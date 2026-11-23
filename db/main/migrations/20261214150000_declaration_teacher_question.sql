-- migrate:up
-- SRV-IZJAVA-PITANJE (owner decision of 23. 11. 2026, NF-5 question 3; NF-3
-- PR-20, NF-4 NZ-15, NF-5 PG-6): the teacher of an assignment may ask one
-- optional question with the declaration, and the student may answer it.
-- Expand only; declaration-v1 payloads, their hashes and the receipt stay
-- byte-equal. The answer is not part of the hashed payload: it is a row bound
-- to one statement row (a draft or a confirmed version), so it is stale or
-- bound exactly when that version is (declaration.is_fresh, section 6.2). It
-- never blocks a submission and is no part of a grade.
--
--   audit.declaration_question_event  every change of the question with who
--                   and when; append-only. The question in force is the latest
--                   row (question_text null: removed). A question may change
--                   after the assignment is published; the change is recorded.
--   institution.declaration_question_of(), declaration_question_setting(),
--                   set_declaration_question()  the teacher of the assignment
--                   (course teacher or mentor, institution.work_relation, C-23)
--                   reads and sets it. Setting the question in force writes
--                   nothing.
--   app.assignment_declaration_question(), app.declaration_question_text()
--                   the bridges for the evidence role, which does not read
--                   schema audit; no grant to the web role.
--   declaration.question_answer  the student's answer, up to 2000 code points,
--                   bound to one statement row and to the question version it
--                   answers (its id and text). A draft's answer goes with the
--                   draft; a confirmed version's answer never changes.
--   declaration.save_statement_answer()  save_statement and the answer in one
--                   transaction; nothing is written when either is refused.
--   declaration.view_statement()  also teacherQuestion and questionAnswer.
--   declaration.bound_answer_of(), app.teacher_declaration_answer()
--                   the teacher or mentor of the student's work reads the
--                   question and the answer bound to the live submission; the
--                   read is written to the access log (surface 'declaration').
--
-- Nobody writes another person's answer: the only writer is the owner's
-- save_statement_answer, under the student's own session. Errors carry no
-- input: ZD401 no session, ZD403 no relation, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app, audit TO ductus_identity;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;

SET LOCAL ROLE ductus_identity;

-- The text of a question: 1 to 500 code points, NFC, no leading or trailing
-- space, no control or direction character but the line feed (as
-- declaration.valid_text, multiline).
CREATE FUNCTION institution.is_declaration_question(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(char_length(p_text) BETWEEN 1 AND 500 AND p_text IS NFC NORMALIZED
    AND p_text !~ '^[[:space:]]|[[:space:]]$'
    AND replace(p_text, chr(10), '') !~ U&'[\0001-\001F\007F-\009F\061C\200E\200F\202A-\202E\2066-\2069\FEFF]',
    false)
$$;

CREATE TABLE audit.declaration_question_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  assignment_id uuid NOT NULL,
  -- Null: the question was removed.
  question_text text CHECK (question_text IS NULL OR institution.is_declaration_question(question_text)),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX declaration_question_event_assignment_idx
  ON audit.declaration_question_event (institution_id, assignment_id, seq);
CREATE INDEX declaration_question_event_actor_idx ON audit.declaration_question_event (actor_id, institution_id);
CREATE TRIGGER declaration_question_event_append_only BEFORE UPDATE OR DELETE
  ON audit.declaration_question_event FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER declaration_question_event_no_truncate BEFORE TRUNCATE
  ON audit.declaration_question_event FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.declaration_question_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.declaration_question_event FORCE ROW LEVEL SECURITY;
CREATE POLICY declaration_question_event_owner ON audit.declaration_question_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The question in force (its id and text; both null when there is none) and
-- when it last changed (null: never). One row for an existing assignment. No
-- access check: only the functions below, which check first, call it.
CREATE FUNCTION institution.declaration_question_of(p_assignment_id uuid)
RETURNS TABLE (question_id uuid, question_text text, changed_at timestamptz)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN e.question_text IS NOT NULL THEN e.id END, e.question_text, e.occurred_at
    FROM institution.assignment a
    LEFT JOIN LATERAL (
      SELECT x.id, x.question_text, x.occurred_at FROM audit.declaration_question_event x
       WHERE x.assignment_id = a.id AND x.institution_id = a.institution_id
       ORDER BY x.seq DESC LIMIT 1) e ON true
   WHERE a.id = p_assignment_id
$$;

-- The teacher of the assignment reads the question.
CREATE FUNCTION institution.declaration_question_setting(p_assignment_id uuid)
RETURNS TABLE (question_text text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = v_institution) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT q.question_text, q.changed_at FROM institution.declaration_question_of(p_assignment_id) q;
END
$$;

-- The teacher of the assignment sets or removes (null) the question. Setters
-- are serialised on the assignment row. A change writes its audit row in the
-- same call; setting the question in force writes nothing.
CREATE FUNCTION institution.set_declaration_question(p_assignment_id uuid, p_question text)
RETURNS TABLE (question_text text, changed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  PERFORM 1 FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_question IS NOT NULL AND NOT institution.is_declaration_question(p_question) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_question IS DISTINCT FROM (SELECT q.question_text FROM institution.declaration_question_of(p_assignment_id) q) THEN
    INSERT INTO audit.declaration_question_event (institution_id, assignment_id, question_text, actor_id)
    VALUES (v_institution, p_assignment_id, p_question, v_user);
  END IF;
  RETURN QUERY SELECT q.question_text, q.changed_at FROM institution.declaration_question_of(p_assignment_id) q;
END
$$;
REVOKE ALL ON FUNCTION institution.is_declaration_question(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.declaration_question_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.declaration_question_setting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.set_declaration_question(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.declaration_question_setting(uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.set_declaration_question(uuid, text) TO ductus_app;

-- The question in force for the student's view, {questionId, text}, or null.
-- No access check: only the evidence functions below call it, after their own.
CREATE FUNCTION app.assignment_declaration_question(p_assignment_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN q.question_id IS NOT NULL
              THEN jsonb_build_object('questionId', q.question_id, 'text', q.question_text) END
    FROM institution.declaration_question_of(p_assignment_id) q
$$;
-- The text of one question version of the assignment, or null when the id
-- names no question of it (another assignment, a removal, an unknown id).
CREATE FUNCTION app.declaration_question_text(p_assignment_id uuid, p_question_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.question_text FROM audit.declaration_question_event e
   WHERE e.id = p_question_id AND e.assignment_id = p_assignment_id AND e.question_text IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.assignment_declaration_question(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.declaration_question_text(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_declaration_question(uuid) TO ductus_evidence;
GRANT EXECUTE ON FUNCTION app.declaration_question_text(uuid, uuid) TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- The answer bound to one statement row. The draft's answer goes with its
-- draft (the trigger statement_draft_answer below, the only delete there is);
-- a confirmed version's answer never changes.
CREATE TABLE declaration.question_answer (
  statement_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  question_id uuid NOT NULL,
  question_text text NOT NULL CHECK (char_length(question_text) BETWEEN 1 AND 500),
  answer_text text NOT NULL CHECK (declaration.valid_text(answer_text, 2000, true)),
  FOREIGN KEY (statement_id, institution_id) REFERENCES declaration.statement (id, institution_id)
);
ALTER TABLE declaration.question_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaration.question_answer FORCE ROW LEVEL SECURITY;
CREATE POLICY question_answer_owner ON declaration.question_answer
  TO ductus_evidence USING (true) WITH CHECK (true);

-- No update; a delete only when its statement row is not a confirmed version
-- (a draft that save_statement replaces).
CREATE FUNCTION declaration.reject_answer_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM declaration.statement s WHERE s.id = OLD.statement_id AND s.payload_jcs IS NOT NULL
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
END $$;
CREATE TRIGGER question_answer_immutable BEFORE UPDATE OR DELETE ON declaration.question_answer
  FOR EACH ROW EXECUTE FUNCTION declaration.reject_answer_change();
CREATE TRIGGER question_answer_no_truncate BEFORE TRUNCATE ON declaration.question_answer
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- save_statement replaces the draft row by deleting it; its answer goes first.
-- A confirmed row is never deleted (statement_immutable).
CREATE FUNCTION declaration.delete_draft_answer() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM declaration.question_answer a
   WHERE a.statement_id = OLD.id AND a.institution_id = OLD.institution_id;
  RETURN OLD;
END $$;
CREATE TRIGGER statement_draft_answer BEFORE DELETE ON declaration.statement
  FOR EACH ROW WHEN (OLD.draft IS NOT NULL) EXECUTE FUNCTION declaration.delete_draft_answer();

CREATE FUNCTION declaration.answer_ref(a declaration.question_answer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('questionId', a.question_id, 'questionText', a.question_text, 'text', a.answer_text)
$$;

-- save_statement and the answer in one call. p_answer is null (no answer) or
-- exactly {questionId, text}; questionId names a question version of this
-- assignment (the one the student read, even if the teacher changed it
-- since). Every refusal of save_statement is returned unchanged; an invalid
-- answer is invalid_input and nothing of the save stays.
CREATE FUNCTION declaration.save_statement_answer(p_assignment uuid, p_body jsonb, p_form_file text, p_answer jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor record;
  v_result jsonb;
  v_question_text text;
  v_statement declaration.statement%ROWTYPE;
  v_row declaration.question_answer%ROWTYPE;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  BEGIN
    v_result := declaration.save_statement(p_assignment, p_body, p_form_file);
    IF v_result->>'status' = 'ok' AND p_answer IS NOT NULL AND p_answer <> 'null'::jsonb THEN
      -- Checked after save_statement, so a refusal of its own (no relation,
      -- a stale base) is answered first, as without an answer.
      IF jsonb_typeof(p_answer) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_answer->'questionId') IS DISTINCT FROM 'string'
         OR jsonb_typeof(p_answer->'text') IS DISTINCT FROM 'string'
         OR p_answer IS DISTINCT FROM jsonb_build_object('questionId', p_answer->'questionId', 'text', p_answer->'text')
         OR p_answer->>'questionId' !~ uuid_pattern
         OR NOT declaration.valid_text(p_answer->>'text', 2000, true) THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
      v_question_text := app.declaration_question_text(p_assignment, (p_answer->>'questionId')::uuid);
      IF v_question_text IS NULL THEN
        RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
      END IF;
      SELECT * INTO v_actor FROM app.current_actor();
      SELECT * INTO v_statement FROM declaration.statement s
       WHERE (s.institution_id, s.assignment_id, s.principal_id) = (v_actor.institution_id, p_assignment, v_actor.user_id)
       ORDER BY s.version DESC LIMIT 1;
      INSERT INTO declaration.question_answer (statement_id, institution_id, question_id, question_text, answer_text)
      VALUES (v_statement.id, v_statement.institution_id, (p_answer->>'questionId')::uuid, v_question_text,
              p_answer->>'text')
      RETURNING * INTO v_row;
      v_result := jsonb_set(v_result, '{statement,questionAnswer}', declaration.answer_ref(v_row));
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZD422' THEN
    -- The subtransaction is rolled back: the statement row is not written.
    RETURN '{"status":"invalid_input"}';
  END;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION declaration.save_statement_answer(uuid, jsonb, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.save_statement_answer(uuid, jsonb, text, jsonb) TO ductus_app;

-- As 20261214110000, with teacherQuestion and questionAnswer: the answer of
-- the row the state is about, so it is draft, confirmed, stale or bound
-- exactly as the declaration is.
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads,
    'declarationRequired', app.assignment_declaration_required(p_assignment),
    'teacherQuestion', app.assignment_declaration_question(p_assignment),
    'questionAnswer', (SELECT declaration.answer_ref(a) FROM declaration.question_answer a
                        WHERE a.statement_id = v_saved.id AND a.institution_id = p_institution)));
END $$;

-- The answer bound to the live (not withdrawn) submission of a student, as
-- bound_declaration_of; answer is null when that version has none. The
-- evidence owner's helper, executable by the identity role only.
CREATE FUNCTION declaration.bound_answer_of(p_institution_id uuid, p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(document_id text, answer jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.document_id, declaration.answer_ref(a)
    FROM evidence.submission x
    JOIN evidence.submission_request r
      ON r.id = x.submission_request_id AND r.institution_id = x.institution_id
    JOIN declaration.statement s
      ON s.id = r.declaration_version_id AND s.institution_id = r.institution_id
    LEFT JOIN declaration.question_answer a
      ON a.statement_id = s.id AND a.institution_id = s.institution_id
   WHERE x.institution_id = p_institution_id AND x.assignment_id = p_assignment_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
     AND s.content_sha256 = r.declaration_sha256
$$;
REVOKE ALL ON FUNCTION declaration.answer_ref(declaration.question_answer) FROM PUBLIC;
REVOKE ALL ON FUNCTION declaration.reject_answer_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION declaration.delete_draft_answer() FROM PUBLIC;
REVOKE ALL ON FUNCTION declaration.bound_answer_of(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declaration.bound_answer_of(uuid, uuid, uuid) TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- The teacher of the course or the mentor of the student's work reads the
-- question in force and the answer bound to the live submission (null without
-- one or without an answer). Reading a bound answer is written to the access
-- log with the surface 'declaration' (one row per five minutes, as the
-- teacher's declaration read). Anyone else is refused (ZD403) and nothing is
-- written.
CREATE FUNCTION app.teacher_declaration_answer(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE(question jsonb, answer jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_row record;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL OR p_student_id IS NULL
     OR coalesce(audit.reader_role(v_institution, p_assignment_id, p_student_id), '') NOT IN ('teacher', 'mentor')
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = p_student_id AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship ms
                           WHERE ms.id = s.mentorship_id AND ms.institution_id = s.institution_id
                             AND ms.student_id = p_student_id))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT b.document_id, b.answer INTO v_row
    FROM declaration.bound_answer_of(v_institution, p_assignment_id, p_student_id) b;
  IF v_row.document_id IS NOT NULL THEN
    PERFORM audit.record_work_opening(v_institution, v_row.document_id, p_assignment_id, p_student_id,
                                      'declaration');
  END IF;
  RETURN QUERY SELECT app.assignment_declaration_question(p_assignment_id), v_row.answer;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_declaration_answer(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_declaration_answer(uuid, uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app, audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_declaration_answer(uuid, uuid);
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION declaration.view_statement(p_institution uuid, p_assignment uuid, p_student uuid,
  p_revision bigint, p_assignment_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_saved declaration.statement%ROWTYPE;
  v_uploads jsonb;
  v_state text;
BEGIN
  SELECT * INTO v_request FROM evidence.submission_request q
    WHERE (q.institution_id, q.assignment_id, q.principal_id) = (p_institution, p_assignment, p_student)
      AND evidence.request_live(q.id, q.institution_id);
  SELECT * INTO v_saved FROM declaration.statement s
    WHERE (s.institution_id, s.assignment_id, s.principal_id) = (p_institution, p_assignment, p_student)
      AND (v_request.id IS NULL OR s.id = v_request.declaration_version_id)
    ORDER BY s.version DESC LIMIT 1;
  v_state := CASE WHEN v_saved.id IS NULL THEN 'none'
    WHEN v_request.id IS NOT NULL THEN 'bound'
    WHEN v_saved.draft IS NOT NULL THEN 'draft'
    WHEN declaration.is_fresh(v_saved, v_saved.document_id, p_revision, p_assignment_version) THEN 'confirmed'
    ELSE 'stale' END;
  SELECT coalesce(jsonb_agg(declaration.attachment_ref(a) ORDER BY a.id), '[]'::jsonb) INTO v_uploads
    FROM declaration.external_attachment a
    WHERE (a.institution_id, a.assignment_id, a.principal_id) = (p_institution, p_assignment, p_student);
  RETURN jsonb_build_object('status', 'ok', 'statement', jsonb_build_object(
    'state', v_state, 'submitted', v_request.id IS NOT NULL, 'currentRevision', p_revision,
    'version', coalesce(v_saved.version, 0), 'formText', v_saved.form_text, 'draft', v_saved.draft,
    'payload', v_saved.payload_jcs::jsonb, 'declarationSha256', v_saved.content_sha256, 'uploads', v_uploads,
    'declarationRequired', app.assignment_declaration_required(p_assignment)));
END $$;
DROP FUNCTION declaration.bound_answer_of(uuid, uuid, uuid);
DROP FUNCTION declaration.save_statement_answer(uuid, jsonb, text, jsonb);
DROP FUNCTION declaration.answer_ref(declaration.question_answer);
DROP TRIGGER statement_draft_answer ON declaration.statement;
DROP TABLE declaration.question_answer;
DROP FUNCTION declaration.delete_draft_answer();
DROP FUNCTION declaration.reject_answer_change();
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.declaration_question_text(uuid, uuid);
DROP FUNCTION app.assignment_declaration_question(uuid);
DROP FUNCTION institution.set_declaration_question(uuid, text);
DROP FUNCTION institution.declaration_question_setting(uuid);
DROP FUNCTION institution.declaration_question_of(uuid);
DROP TABLE audit.declaration_question_event;
DROP FUNCTION institution.is_declaration_question(text);
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;
