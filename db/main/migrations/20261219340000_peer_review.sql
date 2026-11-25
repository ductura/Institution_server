-- migrate:up
-- SRV-V19-RECENZIJA-BAZA (Ductus#2055; val 19, docs/nalazi/val19-razlika.md §5
-- task 11; contract docs/contracts/peer-review-v1.md, API 1.129.0): anonymous
-- peer review between students, led by the teacher. The teacher opens one
-- round per assignment; students who submitted review each other's submitted
-- work without knowing whose it is, and read the reviews of their own work
-- without knowing who wrote them. The teacher sees both ends. Nothing here
-- enters a grade, ranks, sums or sanctions anyone; there is no model or
-- detector.
--
--   institution.peer_review_round        the versions of the round of an
--                                        assignment (opens, due, reviews per
--                                        student, rubrics); the latest holds;
--                                        each version has its own id, and the
--                                        id of the allocated one is the seed
--   institution.peer_review_allocation   who reviews whose submitted work; its
--                                        id is the task id the reviewer sees
--   institution.peer_review              the review of a task, written once
--   institution.peer_review_withdrawal   the teacher withdraws a review, with a
--                                        reason; the review stays
--
-- Every table is append-only (no UPDATE, DELETE or TRUNCATE, for the owner
-- too), has forced RLS and no privilege for ductus_app: only the RPCs below
-- read and write. Who (C-23, from the relation, never from a role alone):
--   teacher   the teachers of the course of the assignment (institution.
--             work_relation) set the round, allocate, read the overview of both
--             ends and withdraw a review
--   reviewer  only the student a task is allocated to, only while the round
--             runs, reads the work of the task and writes its review
--   author    reads only the reviews of the own work, without the reviewer and
--             without the withdrawn ones
-- Another course, another institution, a mentorship assignment, an unknown or
-- malformed id, another's task, an author's own work: the same refusal. Errors
-- carry no input: ZD401 no session, ZD404 not there or no part in it, ZD409
-- wrong state (the message says which: already_allocated, too_few_submissions,
-- closed, already_reviewed, conflict), ZD422 invalid input.
--
-- Anonymity is in what the RPCs return (peer review #642):
--   * app.peer_review_work returns the rubrics and the blocks {kind, text} of
--     the submitted revision, and nothing else: no student, document, project,
--     submission or assignment id, no name, no cover page, no signature, no
--     block id, mark, attribute or time. Only the text of the blocks of a text
--     kind (paragraph, heading, quote, list item, code as paragraph) leaves;
--     citations, tables, images, formulas, the cover (title page data) and the
--     sources do not. What the author wrote about themselves in the body of the
--     work belongs to the author and is not removed.
--   * app.peer_reviews_received returns review id, rubric texts, general text
--     and time, and not the reviewer, the task or the round.
--   * The round is allocated only with at least max(5, 2k + 1) submitted works
--     (k reviews per student): below it mutual reviews would reveal the author
--     (peerReviewMinSubmissions in the contract). The allocation is a pure
--     function of the round id and the ids of the submitted works
--     (institution.peer_review_pairs): in a seeded random order student i
--     reviews the works at positions i+1 .. i+k (modulo n), so nobody reviews
--     their own work, no two students review each other (2k < n), and everyone
--     reviews and is reviewed exactly k times.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;

-- Facts read from the evidence, owned by the evidence role because the identity
-- role reads no evidence table; callable only by the identity role, from the
-- RPCs below after the relation is checked.
SET LOCAL ROLE ductus_evidence;

-- The live (not withdrawn) submissions of an assignment.
CREATE FUNCTION app.peer_review_submitted(p_assignment_id uuid)
RETURNS TABLE (student_id uuid, submission_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.principal_id, s.id
    FROM evidence.submission s
   WHERE s.assignment_id = p_assignment_id
     AND NOT evidence.submission_withdrawn(s.id)
$$;
REVOKE ALL ON FUNCTION app.peer_review_submitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.peer_review_submitted(uuid) TO ductus_identity;

-- The text of the submitted revision of one live submission as blocks, in
-- document order, and nothing else: kind (paragraph, heading, quote,
-- list_item) and text. The paragraphs of a box come in place; a code block is a
-- paragraph with its text; everything that is not text (cover, sources, ids,
-- marks, attributes, atoms, citations, captions) is left out, and so is a block
-- without a character. The bytes are checked against the revision's own hash,
-- so no text other than the submitted one leaves. No row for a withdrawn
-- submission, another assignment, or text that does not match its hash.
CREATE FUNCTION app.peer_review_blocks(p_assignment_id uuid, p_submission_id uuid)
RETURNS TABLE (ord integer, kind text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH doc AS (
    SELECT c.body::jsonb AS j
      FROM evidence.submission s
      JOIN evidence.submission_request r
        ON r.id = s.submission_request_id AND r.institution_id = s.institution_id
      JOIN evidence.document_checkpoint c
        ON c.document_id = r.document_id AND c.institution_id = r.institution_id
       AND c.revision = s.revision AND c.content_hash = s.artifact_hash
     WHERE s.id = p_submission_id AND s.assignment_id = p_assignment_id
       AND NOT evidence.submission_withdrawn(s.id)
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex') = s.artifact_hash
  ),
  top AS (
    SELECT n.v, n.i FROM doc, jsonb_array_elements(doc.j -> 'nodes') WITH ORDINALITY n (v, i)
  ),
  flat AS (
    SELECT t.i, 0::bigint AS j, t.v AS node FROM top t WHERE t.v ->> 'type' IS DISTINCT FROM 'box'
    UNION ALL
    SELECT t.i, c.k, c.v
      FROM top t, jsonb_array_elements(t.v -> 'children') WITH ORDINALITY c (v, k)
     WHERE t.v ->> 'type' = 'box'
  ),
  typed AS (
    SELECT f.i, f.j,
           CASE f.node ->> 'type'
             WHEN 'paragraph' THEN 'paragraph' WHEN 'codeBlock' THEN 'paragraph'
             WHEN 'heading' THEN 'heading' WHEN 'quote' THEN 'quote'
             WHEN 'bulletItem' THEN 'list_item'
           END AS kind,
           (SELECT coalesce(string_agg(x.ch ->> 'text', '' ORDER BY x.o), '')
              FROM jsonb_array_elements(CASE jsonb_typeof(f.node -> 'children') WHEN 'array' THEN f.node -> 'children' ELSE '[]'::jsonb END)
                   WITH ORDINALITY x (ch, o)
             WHERE x.ch ->> 'type' = 'text') AS body
      FROM flat f
  )
  SELECT (row_number() OVER (ORDER BY ty.i, ty.j))::integer, ty.kind, ty.body
    FROM typed ty
   WHERE ty.kind IS NOT NULL AND ty.body <> ''
   ORDER BY ty.i, ty.j
$$;
REVOKE ALL ON FUNCTION app.peer_review_blocks(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.peer_review_blocks(uuid, uuid) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- Rubrics: 1 to 6 objects with exactly the keys key and label; key a short word
-- of lowercase letters, digits and hyphens (up to 40, distinct); label one line
-- of 1 to 120 code points, trimmed, without control characters. A rubric is not
-- a grade and has no points.
CREATE FUNCTION institution.peer_review_rubrics_valid(p_rubrics jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_rubrics IS NULL OR jsonb_typeof(p_rubrics) <> 'array'
                OR jsonb_array_length(p_rubrics) NOT BETWEEN 1 AND 6 THEN false
         ELSE (SELECT coalesce(bool_and(
                  jsonb_typeof(e) = 'object'
                  AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) = ARRAY['key', 'label']
                  AND jsonb_typeof(e -> 'key') = 'string' AND jsonb_typeof(e -> 'label') = 'string'
                  AND (e ->> 'key') ~ '^[a-z0-9][a-z0-9-]{0,39}$'
                  AND char_length(e ->> 'label') BETWEEN 1 AND 120
                  AND (e ->> 'label') = btrim(e ->> 'label')
                  AND (e ->> 'label') !~ '[[:cntrl:]]'), false)
                 FROM jsonb_array_elements(p_rubrics) e)
              AND (SELECT count(DISTINCT e ->> 'key') FROM jsonb_array_elements(p_rubrics) e)
                  = jsonb_array_length(p_rubrics)
         END
$$;

CREATE TABLE institution.peer_review_round (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of the versions; the latest for an assignment holds.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  opens_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  reviews_per_student integer NOT NULL CHECK (reviews_per_student BETWEEN 1 AND 3),
  rubrics jsonb NOT NULL CHECK (institution.peer_review_rubrics_valid(rubrics)),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (opens_at < due_at),
  UNIQUE (id, assignment_id, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (set_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX peer_review_round_assignment_idx
  ON institution.peer_review_round (assignment_id, institution_id, seq);
CREATE INDEX peer_review_round_author_idx ON institution.peer_review_round (set_by, institution_id);

-- author_work_ref is the submission whose revision the reviewer reads; it never
-- leaves the database.
CREATE TABLE institution.peer_review_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  round_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  author_id uuid NOT NULL,
  author_work_ref uuid NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (reviewer_id <> author_id),
  UNIQUE (round_id, reviewer_id, author_id),
  UNIQUE (id, assignment_id, institution_id),
  FOREIGN KEY (round_id, assignment_id, institution_id)
    REFERENCES institution.peer_review_round (id, assignment_id, institution_id),
  FOREIGN KEY (reviewer_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX peer_review_allocation_assignment_idx
  ON institution.peer_review_allocation (assignment_id, institution_id);
CREATE INDEX peer_review_allocation_round_idx
  ON institution.peer_review_allocation (round_id, assignment_id, institution_id);
CREATE INDEX peer_review_allocation_reviewer_idx
  ON institution.peer_review_allocation (reviewer_id, institution_id);
CREATE INDEX peer_review_allocation_author_idx
  ON institution.peer_review_allocation (author_id, institution_id);

CREATE TABLE institution.peer_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  -- One review per task, written once.
  task_id uuid NOT NULL UNIQUE,
  body_json jsonb NOT NULL CHECK (jsonb_typeof(body_json) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (id, assignment_id, institution_id),
  FOREIGN KEY (task_id, assignment_id, institution_id)
    REFERENCES institution.peer_review_allocation (id, assignment_id, institution_id)
);
CREATE INDEX peer_review_assignment_idx ON institution.peer_review (assignment_id, institution_id);

CREATE TABLE institution.peer_review_withdrawal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  review_id uuid NOT NULL UNIQUE,
  teacher_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (review_id, assignment_id, institution_id)
    REFERENCES institution.peer_review (id, assignment_id, institution_id),
  FOREIGN KEY (teacher_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX peer_review_withdrawal_assignment_idx
  ON institution.peer_review_withdrawal (assignment_id, institution_id);
CREATE INDEX peer_review_withdrawal_teacher_idx ON institution.peer_review_withdrawal (teacher_id, institution_id);

-- A record is only ever added: no update, no delete, no truncate, for the owner too.
CREATE FUNCTION institution.reject_peer_review_record_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
END
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['peer_review_round', 'peer_review_allocation', 'peer_review', 'peer_review_withdrawal'] LOOP
    EXECUTE format('ALTER TABLE institution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE institution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON institution.%I TO ductus_identity USING (true) WITH CHECK (true)', t || '_owner', t);
    EXECUTE format('REVOKE ALL ON institution.%I FROM PUBLIC, ductus_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON institution.%I '
                   'FOR EACH ROW EXECUTE FUNCTION institution.reject_peer_review_record_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON institution.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION institution.reject_peer_review_record_change()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- The fewest submitted works for a round of k reviews per student.
CREATE FUNCTION institution.peer_review_min_submissions(p_reviews_per_student integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT greatest(5, 2 * p_reviews_per_student + 1) $$;

-- The allocation as a pure function of the round id, the students with a
-- submitted work and k: no self review, no pair that reviews each other (when
-- there are at least 2k + 1 students), everyone reviews and is reviewed k times.
CREATE FUNCTION institution.peer_review_pairs(p_round_id uuid, p_students uuid[], p_reviews_per_student integer)
RETURNS TABLE (reviewer_id uuid, author_id uuid)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH ord AS (
    SELECT s.id AS student_id,
           (row_number() OVER (ORDER BY pg_catalog.md5(p_round_id::text || s.id::text), s.id) - 1) AS pos
      FROM (SELECT DISTINCT u AS id FROM unnest(p_students) u) s
  ),
  n AS (SELECT count(*) AS n FROM ord)
  SELECT r.student_id, a.student_id
    FROM ord r
   CROSS JOIN n
   CROSS JOIN generate_series(1, p_reviews_per_student) d
    JOIN ord a ON a.pos = (r.pos + d) % n.n
   WHERE n.n > p_reviews_per_student
$$;

-- The caller's part in the review of one assignment: p_part 'student' or
-- 'teacher'. The assignment must be one of a course (a mentorship assignment has
-- no review rounds). ZD401 without a session; ZD404 for anything else.
CREATE FUNCTION institution.peer_review_context(p_assignment_id uuid, p_part text,
                                                OUT o_user_id uuid, OUT o_institution_id uuid, OUT o_course_id uuid)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  SELECT r.user_id, r.institution_id INTO o_user_id, o_institution_id FROM institution.require_actor() r;
  SELECT a.course_id INTO o_course_id FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = o_institution_id AND a.course_id IS NOT NULL;
  IF p_assignment_id IS NULL OR o_course_id IS NULL
     OR institution.work_relation(o_user_id, p_assignment_id) IS DISTINCT FROM p_part THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
END
$$;

-- One writer of the review of an assignment at a time.
CREATE FUNCTION institution.peer_review_lock(p_assignment_id uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer_review:' || p_assignment_id, 0))
$$;

-- The round in force: the latest version.
CREATE FUNCTION institution.peer_review_round_of(p_assignment_id uuid) RETURNS institution.peer_review_round
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT r FROM institution.peer_review_round r
   WHERE r.assignment_id = p_assignment_id ORDER BY r.seq DESC LIMIT 1
$$;

-- Has the round been allocated (any allocation of that version)?
CREATE FUNCTION institution.peer_review_allocated(p_round_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM institution.peer_review_allocation a WHERE a.round_id = p_round_id) $$;

-- The teacher sets the round; each call adds a version, while it is not allocated.
CREATE FUNCTION app.set_peer_review_round(p_assignment_id uuid, p_opens_at timestamptz, p_due_at timestamptz,
                                          p_reviews_per_student integer, p_rubrics jsonb)
RETURNS TABLE (round_id uuid, opens_at timestamptz, due_at timestamptz, reviews_per_student integer, rubrics jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current institution.peer_review_round;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'teacher');
  IF p_opens_at IS NULL OR p_due_at IS NULL OR p_opens_at >= p_due_at
     OR p_reviews_per_student IS NULL OR p_reviews_per_student NOT BETWEEN 1 AND 3
     OR NOT institution.peer_review_rubrics_valid(p_rubrics) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.peer_review_lock(p_assignment_id);
  v_current := institution.peer_review_round_of(p_assignment_id);
  IF v_current.id IS NOT NULL AND institution.peer_review_allocated(v_current.id) THEN
    RAISE EXCEPTION 'already_allocated' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.peer_review_round
    (institution_id, assignment_id, opens_at, due_at, reviews_per_student, rubrics, set_by)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_opens_at, p_due_at, p_reviews_per_student, p_rubrics,
          v_ctx.o_user_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, p_opens_at, p_due_at, p_reviews_per_student, p_rubrics;
END
$$;

-- The round, its state and the count of submitted works, for the teachers of the
-- course; always one row. state: none, not_allocated, allocated (before it
-- opens), open, closed (after it is due). Without a round the round columns are
-- null and the least submitted works is that of one review per student.
CREATE FUNCTION app.peer_review_round(p_assignment_id uuid)
RETURNS TABLE (round_id uuid, opens_at timestamptz, due_at timestamptz, reviews_per_student integer, rubrics jsonb,
               allocated_at timestamptz, state text, submitted_works integer, min_submissions integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_round institution.peer_review_round;
  v_works integer;
  v_allocated timestamptz;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'teacher');
  SELECT count(*)::integer INTO v_works
    FROM app.peer_review_submitted(p_assignment_id) s
    JOIN institution.course_member cm
      ON cm.course_id = v_ctx.o_course_id AND cm.institution_id = v_ctx.o_institution_id
     AND cm.user_id = s.student_id AND cm.role = 'student' AND cm.member_to IS NULL;
  v_round := institution.peer_review_round_of(p_assignment_id);
  IF v_round.id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::integer, NULL::jsonb,
                        NULL::timestamptz, 'none'::text, v_works, institution.peer_review_min_submissions(1);
    RETURN;
  END IF;
  SELECT min(a.allocated_at) INTO v_allocated FROM institution.peer_review_allocation a WHERE a.round_id = v_round.id;
  RETURN QUERY SELECT v_round.id, v_round.opens_at, v_round.due_at, v_round.reviews_per_student, v_round.rubrics,
    v_allocated,
    CASE WHEN v_allocated IS NULL THEN 'not_allocated'
         WHEN statement_timestamp() < v_round.opens_at THEN 'allocated'
         WHEN statement_timestamp() <= v_round.due_at THEN 'open'
         ELSE 'closed' END,
    v_works, institution.peer_review_min_submissions(v_round.reviews_per_student);
END
$$;

-- The teacher allocates the round, once. Returns the number of tasks. Refused:
-- no round (404), already allocated, too few submitted works (ZD409, the message
-- says which; nothing is written).
CREATE FUNCTION app.allocate_peer_review(p_assignment_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_round institution.peer_review_round;
  v_students uuid[];
  v_count integer;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'teacher');
  PERFORM institution.peer_review_lock(p_assignment_id);
  v_round := institution.peer_review_round_of(p_assignment_id);
  IF v_round.id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF institution.peer_review_allocated(v_round.id) THEN
    RAISE EXCEPTION 'already_allocated' USING ERRCODE = 'ZD409';
  END IF;
  SELECT coalesce(array_agg(s.student_id), ARRAY[]::uuid[]) INTO v_students
    FROM app.peer_review_submitted(p_assignment_id) s
    JOIN institution.course_member cm
      ON cm.course_id = v_ctx.o_course_id AND cm.institution_id = v_ctx.o_institution_id
     AND cm.user_id = s.student_id AND cm.role = 'student' AND cm.member_to IS NULL;
  IF coalesce(array_length(v_students, 1), 0)
       < institution.peer_review_min_submissions(v_round.reviews_per_student) THEN
    RAISE EXCEPTION 'too_few_submissions' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.peer_review_allocation
    (institution_id, assignment_id, round_id, reviewer_id, author_id, author_work_ref)
  SELECT v_ctx.o_institution_id, p_assignment_id, v_round.id, p.reviewer_id, p.author_id, w.submission_id
    FROM institution.peer_review_pairs(v_round.id, v_students, v_round.reviews_per_student) p
    JOIN app.peer_review_submitted(p_assignment_id) w ON w.student_id = p.author_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- The student's tasks as rows: round_state (none, open, closed) on every row,
-- and one row per task (task id, pending or submitted, the due time); one row
-- with no task when there is none. A round that has not opened, a student with
-- no allocation (a work that was not submitted is not allocated) and a round
-- not allocated read as none. A task whose author withdrew the work is not
-- listed. The task id is the only thing about the work.
CREATE FUNCTION app.peer_review_tasks(p_assignment_id uuid)
RETURNS TABLE (round_state text, task_id uuid, task_state text, due_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_round institution.peer_review_round;
  v_state text;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'student');
  v_round := institution.peer_review_round_of(p_assignment_id);
  IF v_round.id IS NULL OR statement_timestamp() < v_round.opens_at
     OR NOT EXISTS (SELECT 1 FROM institution.peer_review_allocation a
                     WHERE a.round_id = v_round.id AND a.reviewer_id = v_ctx.o_user_id) THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  v_state := CASE WHEN statement_timestamp() <= v_round.due_at THEN 'open' ELSE 'closed' END;
  RETURN QUERY
    SELECT v_state, a.id,
           CASE WHEN EXISTS (SELECT 1 FROM institution.peer_review r WHERE r.task_id = a.id)
                THEN 'submitted' ELSE 'pending' END,
           v_round.due_at
      FROM institution.peer_review_allocation a
     WHERE a.round_id = v_round.id AND a.reviewer_id = v_ctx.o_user_id
       AND a.author_work_ref IN (SELECT w.submission_id FROM app.peer_review_submitted(p_assignment_id) w)
     ORDER BY a.id;
  -- Every allocated work withdrawn: still the state of the round, with no task.
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_state, NULL::uuid, NULL::text, NULL::timestamptz;
  END IF;
END
$$;

-- The work of a task, for its reviewer only and only while the round runs: the
-- rubrics (a json array of {key, label}) on every row and the blocks {kind,
-- body} of the submitted revision, one row per block in document order; a work
-- with no text block is one row with no block. Nothing else: see the header.
-- Another's, unknown, own-work, early, late and withdrawn: the same ZD404.
CREATE FUNCTION app.peer_review_work(p_task_id uuid)
RETURNS TABLE (rubrics jsonb, ord integer, kind text, body text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_task institution.peer_review_allocation;
  v_round institution.peer_review_round;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  SELECT * INTO v_task FROM institution.peer_review_allocation a
   WHERE a.id = p_task_id AND a.reviewer_id = v_actor.user_id AND a.institution_id = v_actor.institution_id;
  IF v_task.id IS NULL
     OR institution.work_relation(v_actor.user_id, v_task.assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT * INTO v_round FROM institution.peer_review_round r WHERE r.id = v_task.round_id;
  IF statement_timestamp() < v_round.opens_at OR statement_timestamp() > v_round.due_at
     OR NOT EXISTS (SELECT 1 FROM app.peer_review_submitted(v_task.assignment_id) w
                     WHERE w.submission_id = v_task.author_work_ref) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN QUERY SELECT v_round.rubrics, b.ord, b.kind, b.body
    FROM app.peer_review_blocks(v_task.assignment_id, v_task.author_work_ref) b
   ORDER BY b.ord;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_round.rubrics, NULL::integer, NULL::text, NULL::text;
  END IF;
END
$$;

-- The reviewer writes the review of a task, once: one text (1 to 4000 code
-- points) for each rubric of the round, exactly those keys, each once, and an
-- optional general text (1 to 4000). Returns the review id. ZD404 as for the
-- work (before it opens, not the reviewer's, unknown, withdrawn work); ZD422
-- invalid input; ZD409 closed after the due time, already_reviewed.
CREATE FUNCTION app.add_peer_review(p_task_id uuid, p_by_rubric jsonb, p_general text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_task institution.peer_review_allocation;
  v_round institution.peer_review_round;
  v_id uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  SELECT * INTO v_task FROM institution.peer_review_allocation a
   WHERE a.id = p_task_id AND a.reviewer_id = v_actor.user_id AND a.institution_id = v_actor.institution_id;
  IF v_task.id IS NULL
     OR institution.work_relation(v_actor.user_id, v_task.assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  SELECT * INTO v_round FROM institution.peer_review_round r WHERE r.id = v_task.round_id;
  IF statement_timestamp() < v_round.opens_at
     OR NOT EXISTS (SELECT 1 FROM app.peer_review_submitted(v_task.assignment_id) w
                     WHERE w.submission_id = v_task.author_work_ref) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_by_rubric IS NULL OR jsonb_typeof(p_by_rubric) <> 'array'
     OR jsonb_array_length(p_by_rubric) <> jsonb_array_length(v_round.rubrics)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_by_rubric) e
        WHERE jsonb_typeof(e) <> 'object'
           OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['key', 'text']
           OR jsonb_typeof(e -> 'key') <> 'string' OR jsonb_typeof(e -> 'text') <> 'string'
           OR char_length(e ->> 'text') NOT BETWEEN 1 AND 4000
           OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_round.rubrics) q WHERE q ->> 'key' = e ->> 'key'))
     OR (SELECT count(DISTINCT e ->> 'key') FROM jsonb_array_elements(p_by_rubric) e) <> jsonb_array_length(p_by_rubric)
     OR (p_general IS NOT NULL AND char_length(p_general) NOT BETWEEN 1 AND 4000) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.peer_review_lock(v_task.assignment_id);
  IF statement_timestamp() > v_round.due_at THEN
    RAISE EXCEPTION 'closed' USING ERRCODE = 'ZD409';
  END IF;
  IF EXISTS (SELECT 1 FROM institution.peer_review r WHERE r.task_id = v_task.id) THEN
    RAISE EXCEPTION 'already_reviewed' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.peer_review (institution_id, assignment_id, task_id, body_json)
  VALUES (v_task.institution_id, v_task.assignment_id, v_task.id,
          CASE WHEN p_general IS NULL
               THEN jsonb_build_object('byRubric', p_by_rubric)
               ELSE jsonb_build_object('byRubric', p_by_rubric, 'general', p_general) END)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The reviews of the author's own work, oldest first, without the withdrawn
-- ones: review id, the texts by rubric in the order of the rubrics with the
-- rubric label (a json array of {key, label, text}), the general text and the
-- time. Never the reviewer, the task or the round. No round or no review is no
-- row. Only the author reads them (the allocation names the author).
CREATE FUNCTION app.peer_reviews_received(p_assignment_id uuid)
RETURNS TABLE (review_id uuid, by_rubric jsonb, general text, submitted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'student');
  RETURN QUERY
    SELECT r.id,
           (SELECT jsonb_agg(jsonb_build_object('key', q.rub ->> 'key', 'label', q.rub ->> 'label',
                                                'text', (SELECT t ->> 'text'
                                                           FROM jsonb_array_elements(r.body_json -> 'byRubric') t
                                                          WHERE t ->> 'key' = q.rub ->> 'key'))
                             ORDER BY q.o)
              FROM jsonb_array_elements(d.rubrics) WITH ORDINALITY q (rub, o)),
           r.body_json ->> 'general', r.submitted_at
      FROM institution.peer_review r
      JOIN institution.peer_review_allocation a
        ON a.id = r.task_id AND a.assignment_id = r.assignment_id AND a.institution_id = r.institution_id
      JOIN institution.peer_review_round d ON d.id = a.round_id
     WHERE a.assignment_id = p_assignment_id AND a.institution_id = v_ctx.o_institution_id
       AND a.author_id = v_ctx.o_user_id
       AND NOT EXISTS (SELECT 1 FROM institution.peer_review_withdrawal w WHERE w.review_id = r.id)
     ORDER BY r.submitted_at, r.id;
END
$$;

-- The overview for the teachers of the course: one row per allocation with both
-- ends, in the order of the reviewer's family name, given name, id, then the
-- author's. state: pending (no review yet), submitted or withdrawn. review_id is
-- null until the review is written. No sum per student and no order by quality.
CREATE FUNCTION app.peer_review_overview(p_assignment_id uuid)
RETURNS TABLE (review_id uuid, reviewer_id uuid, reviewer_given_name text, reviewer_family_name text,
               author_id uuid, author_given_name text, author_family_name text, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'teacher');
  RETURN QUERY
    SELECT r.id, a.reviewer_id, rn.given_name, rn.family_name, a.author_id, an.given_name, an.family_name,
           CASE WHEN r.id IS NULL THEN 'pending'
                WHEN EXISTS (SELECT 1 FROM institution.peer_review_withdrawal w WHERE w.review_id = r.id)
                THEN 'withdrawn' ELSE 'submitted' END
      FROM institution.peer_review_allocation a
      LEFT JOIN institution.peer_review r ON r.task_id = a.id
      LEFT JOIN identity.person_name rn ON rn.user_id = a.reviewer_id AND rn.institution_id = a.institution_id
      LEFT JOIN identity.person_name an ON an.user_id = a.author_id AND an.institution_id = a.institution_id
     WHERE a.assignment_id = p_assignment_id AND a.institution_id = v_ctx.o_institution_id
     ORDER BY rn.family_name, rn.given_name, a.reviewer_id, an.family_name, an.given_name, a.author_id;
END
$$;

-- The teacher withdraws a review of the assignment, with a reason (1 to 600 code
-- points). The review stays; it leaves the author's reading. Returns the review
-- id. ZD404: not a review of this assignment; ZD422 reason; ZD409 conflict: it
-- is withdrawn already (not undone).
CREATE FUNCTION app.withdraw_peer_review(p_assignment_id uuid, p_review_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM institution.peer_review_context(p_assignment_id, 'teacher');
  IF p_review_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.peer_review r
        WHERE r.id = p_review_id AND r.assignment_id = p_assignment_id AND r.institution_id = v_ctx.o_institution_id) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.peer_review_lock(p_assignment_id);
  IF EXISTS (SELECT 1 FROM institution.peer_review_withdrawal w WHERE w.review_id = p_review_id) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.peer_review_withdrawal (institution_id, assignment_id, review_id, teacher_id, reason)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_review_id, v_ctx.o_user_id, p_reason);
  RETURN p_review_id;
END
$$;

REVOKE ALL ON FUNCTION institution.peer_review_rubrics_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.reject_peer_review_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_min_submissions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_pairs(uuid, uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_context(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_round_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.peer_review_allocated(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_peer_review_round(uuid, timestamptz, timestamptz, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.peer_review_round(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.allocate_peer_review(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.peer_review_tasks(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.peer_review_work(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.add_peer_review(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.peer_reviews_received(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.peer_review_overview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.withdraw_peer_review(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_peer_review_round(uuid, timestamptz, timestamptz, integer, jsonb) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.peer_review_round(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.allocate_peer_review(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.peer_review_tasks(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.peer_review_work(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.add_peer_review(uuid, jsonb, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.peer_reviews_received(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.peer_review_overview(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.withdraw_peer_review(uuid, uuid, text) TO ductus_app;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.withdraw_peer_review(uuid, uuid, text);
DROP FUNCTION app.peer_review_overview(uuid);
DROP FUNCTION app.peer_reviews_received(uuid);
DROP FUNCTION app.add_peer_review(uuid, jsonb, text);
DROP FUNCTION app.peer_review_work(uuid);
DROP FUNCTION app.peer_review_tasks(uuid);
DROP FUNCTION app.allocate_peer_review(uuid);
DROP FUNCTION app.peer_review_round(uuid);
DROP FUNCTION app.set_peer_review_round(uuid, timestamptz, timestamptz, integer, jsonb);
DROP FUNCTION institution.peer_review_round_of(uuid);
DROP TABLE institution.peer_review_withdrawal;
DROP TABLE institution.peer_review;
DROP TABLE institution.peer_review_allocation;
DROP TABLE institution.peer_review_round;
DROP FUNCTION institution.peer_review_allocated(uuid);
DROP FUNCTION institution.peer_review_lock(uuid);
DROP FUNCTION institution.peer_review_context(uuid, text);
DROP FUNCTION institution.peer_review_pairs(uuid, uuid[], integer);
DROP FUNCTION institution.peer_review_min_submissions(integer);
DROP FUNCTION institution.reject_peer_review_record_change();
DROP FUNCTION institution.peer_review_rubrics_valid(jsonb);
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.peer_review_blocks(uuid, uuid);
DROP FUNCTION app.peer_review_submitted(uuid);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
