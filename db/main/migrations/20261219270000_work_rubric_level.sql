-- migrate:up
-- SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17, docs/nalazi/val17-razlika.md 2 and 3): the
-- teacher's mark of a level per criterion of the assignment's rubric (SRV-V17-RUBRIC-DEF,
-- 20261219240000), on one work. A mark is a word-level 0, 1 or 2 (lowest to highest, the
-- position of the level in the criterion) or null, with a short note. There is no number,
-- sum, weight, grade or rank anywhere: nothing is computed from a mark and no read returns one
-- but the teacher's own (D-130, PRODUCT 5).
--
--   collaboration.work_rubric_level          one row per author, work, rubric version and
--                                            criterion, written only while a level or a note
--                                            is set; forced RLS, owner policy only
--   collaboration.list_work_rubric           the caller's own marks on a work, for the latest
--                                            rubric version of its assignment
--   collaboration.save_work_rubric_mark      sets or clears the level and note of one criterion
--   collaboration.delete_work_rubric_levels  retention only, called by the orphan sweep
--
-- Bound to a version: a mark names the rubric version it was made against, so a later version
-- never changes what an earlier mark meant. The routes read and write the latest version only;
-- while the teacher set no rubric the version is 0 and the criteria are the six default ones
-- (topic, structure, sources, method, language, formatting), as a student reads them.
--
-- Who may (C-23, from the relation, never from the role alone): a teacher of that work
-- (collaboration.actor_role, decided on every call), and only the author reads the rows; another
-- teacher of the same work does not. The student of the work, a teacher with no relation to it,
-- another institution and an unknown work are the same ZD403. Errors carry no input: ZD401 no
-- session, ZD403 no relation, ZD422 invalid input (a
-- level outside 0..2, a note that is not a short text); a criterion not in the latest version is ZD403.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE collaboration.work_rubric_level (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  author_id uuid NOT NULL,
  -- 0 while the teacher set no rubric (the six default criteria), else a version of
  -- institution.assignment_rubric_version, checked when the mark is saved.
  rubric_version integer NOT NULL CHECK (rubric_version >= 0),
  criterion_id text NOT NULL CHECK (criterion_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  -- 0 lowest, 1 middle, 2 highest level of the criterion: a position, never points.
  level smallint CHECK (level BETWEEN 0 AND 2),
  note text CHECK (note IS NULL OR collaboration.is_comment_body(note)),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (document_id, institution_id, author_id, rubric_version, criterion_id),
  CHECK (level IS NOT NULL OR note IS NOT NULL),
  CHECK (author_id <> owner_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (author_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE collaboration.work_rubric_level ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.work_rubric_level FORCE ROW LEVEL SECURITY;
CREATE POLICY work_rubric_level_owner ON collaboration.work_rubric_level
  TO ductus_identity USING (true) WITH CHECK (true);

-- The criterion ids of the latest rubric version of an assignment, in order, with that version:
-- the six default criteria at version 0 while none is stored.
CREATE FUNCTION collaboration.rubric_criterion_ids(p_assignment_id uuid)
RETURNS TABLE (rubric_version integer, criterion_id text, ord bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_version integer;
  v_criteria jsonb;
BEGIN
  SELECT v.version, v.criteria INTO v_version, v_criteria
    FROM institution.assignment_rubric_version v
   WHERE v.assignment_id = p_assignment_id ORDER BY v.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 0, c.id, c.ord
        FROM unnest(ARRAY['topic', 'structure', 'sources', 'method', 'language', 'formatting'])
             WITH ORDINALITY AS c (id, ord);
    RETURN;
  END IF;
  RETURN QUERY
    SELECT v_version, e.item ->> 'id', e.ord
      FROM jsonb_array_elements(v_criteria) WITH ORDINALITY AS e (item, ord);
END
$$;

-- The caller's own marks on one work: one row per criterion of the latest rubric version, in the
-- rubric's order, with a null level and note where nothing is set. Only while the caller is a
-- teacher of the work; another teacher's rows never come.
CREATE FUNCTION collaboration.list_work_rubric(p_document_id text)
RETURNS TABLE (rubric_version integer, criterion_id text, level smallint, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT c.rubric_version, c.criterion_id, w.level, w.note
      FROM collaboration.rubric_criterion_ids(scope.assignment_id) c
      LEFT JOIN collaboration.work_rubric_level w
        ON w.criterion_id = c.criterion_id AND w.rubric_version = c.rubric_version
       AND w.document_id = p_document_id AND w.institution_id = scope.institution_id
       AND w.author_id = actor.user_id
     ORDER BY c.ord;
END
$$;

-- Sets the level and the note of one criterion of the latest rubric version, replacing both: a
-- null clears it, and a criterion with neither is removed. Returns the saved values.
CREATE FUNCTION collaboration.save_work_rubric_mark(p_document_id text, p_criterion_id text, p_level smallint, p_note text)
RETURNS TABLE (rubric_version integer, criterion_id text, level smallint, note text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  scope record;
  v_version integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  SELECT c.rubric_version INTO v_version
    FROM collaboration.rubric_criterion_ids(scope.assignment_id) c
   WHERE c.criterion_id = p_criterion_id;
  IF v_version IS NULL THEN
    -- Not a criterion of the latest rubric version: one answer with "no relation" (the HTTP 404).
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF (p_level IS NOT NULL AND p_level NOT BETWEEN 0 AND 2)
     OR (p_note IS NOT NULL AND NOT coalesce(collaboration.is_comment_body(p_note), false)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_level IS NULL AND p_note IS NULL THEN
    DELETE FROM collaboration.work_rubric_level w
     WHERE w.document_id = p_document_id AND w.institution_id = scope.institution_id
       AND w.author_id = actor.user_id AND w.rubric_version = v_version AND w.criterion_id = p_criterion_id;
    RETURN QUERY SELECT v_version, p_criterion_id, NULL::smallint, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.work_rubric_level AS w
      (institution_id, document_id, assignment_id, owner_id, author_id, rubric_version, criterion_id, level, note)
    VALUES (scope.institution_id, p_document_id, scope.assignment_id, scope.principal_id, actor.user_id,
            v_version, p_criterion_id, p_level, p_note)
    ON CONFLICT (document_id, institution_id, author_id, rubric_version, criterion_id)
    DO UPDATE SET level = EXCLUDED.level, note = EXCLUDED.note, updated_at = statement_timestamp()
    RETURNING w.rubric_version, w.criterion_id, w.level, w.note;
END
$$;

-- For the retention role only (and the orphan sweep below): the marks of a document go with the
-- document, as delete_working_criteria. No rows: nothing happens. Takes and returns no text.
CREATE FUNCTION collaboration.delete_work_rubric_levels(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_rubric_level w
   WHERE w.document_id = p_document_id AND w.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.rubric_criterion_ids(uuid),
  collaboration.list_work_rubric(text),
  collaboration.save_work_rubric_mark(text, text, smallint, text),
  collaboration.delete_work_rubric_levels(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.list_work_rubric(text),
  collaboration.save_work_rubric_mark(text, text, smallint, text)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_work_rubric_levels(text, uuid) TO ductus_retention;

-- The orphan sweep (20261217170000) now also removes the marks of a work that is gone.
CREATE OR REPLACE FUNCTION collaboration.purge_orphan_work_data() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  w record;
  v_rows bigint := 0;
BEGIN
  FOR w IN
    SELECT k.document_id, k.institution_id
      FROM (SELECT n.document_id, n.institution_id FROM collaboration.work_self_note n
            UNION SELECT s.document_id, s.institution_id FROM collaboration.work_item_seen s
            UNION SELECT m.document_id, m.institution_id FROM collaboration.work_message m
            UNION SELECT t.document_id, t.institution_id FROM collaboration.teacher_note t
            UNION SELECT l.document_id, l.institution_id FROM collaboration.live_state l
            UNION SELECT r.document_id, r.institution_id FROM collaboration.revision_request r
            UNION SELECT c.document_id, c.institution_id FROM collaboration.teacher_working_criterion c
            UNION SELECT e.document_id, e.institution_id FROM collaboration.direct_edit_setting e
            UNION SELECT e.document_id, e.institution_id FROM collaboration.teacher_edit e
            UNION SELECT v.document_id, v.institution_id FROM collaboration.work_review v
            UNION SELECT r.document_id, r.institution_id FROM collaboration.work_rubric_level r) k
      LEFT JOIN LATERAL collaboration.document_scope(k.document_id) d ON true
     WHERE d.institution_id IS DISTINCT FROM k.institution_id
     ORDER BY k.institution_id, k.document_id
  LOOP
    -- The document may have appeared since the candidates were read.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM collaboration.document_scope(w.document_id) d WHERE d.institution_id = w.institution_id);
    -- A work under an open legal hold, on itself, a student or an assignment
    -- of its rows, is neither counted nor removed.
    CONTINUE WHEN app.is_on_legal_hold('work', w.document_id) OR EXISTS (
      SELECT 1
        FROM (SELECT n.owner_id FROM collaboration.work_self_note n
               WHERE n.document_id = w.document_id AND n.institution_id = w.institution_id
              UNION SELECT s.viewer_id FROM collaboration.work_item_seen s
               WHERE s.document_id = w.document_id AND s.institution_id = w.institution_id
              UNION SELECT m.owner_id FROM collaboration.work_message m
               WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id
              UNION SELECT t.owner_id FROM collaboration.teacher_note t
               WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id
              UNION SELECT l.owner_id FROM collaboration.live_state l
               WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id
              UNION SELECT r.owner_id FROM collaboration.revision_request r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id
              UNION SELECT c.owner_id FROM collaboration.teacher_working_criterion c
               WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id
              UNION SELECT e.owner_id FROM collaboration.direct_edit_setting e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT e.owner_id FROM collaboration.teacher_edit e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT v.owner_id FROM collaboration.work_review v
               WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id
              UNION SELECT r.owner_id FROM collaboration.work_rubric_level r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id) o (student_id)
       WHERE app.is_on_legal_hold('student', o.student_id::text)
    ) OR EXISTS (
      SELECT 1
        FROM (SELECT m.assignment_id FROM collaboration.work_message m
               WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id
              UNION SELECT t.assignment_id FROM collaboration.teacher_note t
               WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id
              UNION SELECT l.assignment_id FROM collaboration.live_state l
               WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id
              UNION SELECT r.assignment_id FROM collaboration.revision_request r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id
              UNION SELECT c.assignment_id FROM collaboration.teacher_working_criterion c
               WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id
              UNION SELECT e.assignment_id FROM collaboration.direct_edit_setting e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT e.assignment_id FROM collaboration.teacher_edit e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT v.assignment_id FROM collaboration.work_review v
               WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id
              UNION SELECT r.assignment_id FROM collaboration.work_rubric_level r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id) a (assignment_id)
       WHERE app.is_on_legal_hold('assignment', a.assignment_id::text)
    );
    v_rows := v_rows
      + (SELECT count(*) FROM collaboration.work_self_note n
          WHERE n.document_id = w.document_id AND n.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_item_seen s
          WHERE s.document_id = w.document_id AND s.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_message m
          WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_note t
          WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.live_state l
          WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request r
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request_version rv
           JOIN collaboration.revision_request r ON r.id = rv.request_id AND r.institution_id = rv.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_response rs
           JOIN collaboration.revision_request r ON r.id = rs.request_id AND r.institution_id = rs.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_working_criterion c
          WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting_change ec
          WHERE ec.document_id = w.document_id AND ec.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_edit e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_review v
          WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_rubric_level r
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id);
    PERFORM collaboration.delete_work_self_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_items_seen(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_messages(w.document_id, w.institution_id);
    PERFORM collaboration.delete_teacher_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_live_state(w.document_id, w.institution_id);
    PERFORM collaboration.delete_revision_requests(w.document_id, w.institution_id);
    PERFORM collaboration.delete_working_criteria(w.document_id, w.institution_id);
    PERFORM collaboration.delete_direct_edit(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_reviews(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_rubric_levels(w.document_id, w.institution_id);
  END LOOP;
  RETURN v_rows;
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION collaboration.purge_orphan_work_data() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  w record;
  v_rows bigint := 0;
BEGIN
  FOR w IN
    SELECT k.document_id, k.institution_id
      FROM (SELECT n.document_id, n.institution_id FROM collaboration.work_self_note n
            UNION SELECT s.document_id, s.institution_id FROM collaboration.work_item_seen s
            UNION SELECT m.document_id, m.institution_id FROM collaboration.work_message m
            UNION SELECT t.document_id, t.institution_id FROM collaboration.teacher_note t
            UNION SELECT l.document_id, l.institution_id FROM collaboration.live_state l
            UNION SELECT r.document_id, r.institution_id FROM collaboration.revision_request r
            UNION SELECT c.document_id, c.institution_id FROM collaboration.teacher_working_criterion c
            UNION SELECT e.document_id, e.institution_id FROM collaboration.direct_edit_setting e
            UNION SELECT e.document_id, e.institution_id FROM collaboration.teacher_edit e
            UNION SELECT v.document_id, v.institution_id FROM collaboration.work_review v) k
      LEFT JOIN LATERAL collaboration.document_scope(k.document_id) d ON true
     WHERE d.institution_id IS DISTINCT FROM k.institution_id
     ORDER BY k.institution_id, k.document_id
  LOOP
    -- The document may have appeared since the candidates were read.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM collaboration.document_scope(w.document_id) d WHERE d.institution_id = w.institution_id);
    -- A work under an open legal hold, on itself, a student or an assignment
    -- of its rows, is neither counted nor removed.
    CONTINUE WHEN app.is_on_legal_hold('work', w.document_id) OR EXISTS (
      SELECT 1
        FROM (SELECT n.owner_id FROM collaboration.work_self_note n
               WHERE n.document_id = w.document_id AND n.institution_id = w.institution_id
              UNION SELECT s.viewer_id FROM collaboration.work_item_seen s
               WHERE s.document_id = w.document_id AND s.institution_id = w.institution_id
              UNION SELECT m.owner_id FROM collaboration.work_message m
               WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id
              UNION SELECT t.owner_id FROM collaboration.teacher_note t
               WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id
              UNION SELECT l.owner_id FROM collaboration.live_state l
               WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id
              UNION SELECT r.owner_id FROM collaboration.revision_request r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id
              UNION SELECT c.owner_id FROM collaboration.teacher_working_criterion c
               WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id
              UNION SELECT e.owner_id FROM collaboration.direct_edit_setting e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT e.owner_id FROM collaboration.teacher_edit e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT v.owner_id FROM collaboration.work_review v
               WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id) o (student_id)
       WHERE app.is_on_legal_hold('student', o.student_id::text)
    ) OR EXISTS (
      SELECT 1
        FROM (SELECT m.assignment_id FROM collaboration.work_message m
               WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id
              UNION SELECT t.assignment_id FROM collaboration.teacher_note t
               WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id
              UNION SELECT l.assignment_id FROM collaboration.live_state l
               WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id
              UNION SELECT r.assignment_id FROM collaboration.revision_request r
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id
              UNION SELECT c.assignment_id FROM collaboration.teacher_working_criterion c
               WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id
              UNION SELECT e.assignment_id FROM collaboration.direct_edit_setting e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT e.assignment_id FROM collaboration.teacher_edit e
               WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id
              UNION SELECT v.assignment_id FROM collaboration.work_review v
               WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id) a (assignment_id)
       WHERE app.is_on_legal_hold('assignment', a.assignment_id::text)
    );
    v_rows := v_rows
      + (SELECT count(*) FROM collaboration.work_self_note n
          WHERE n.document_id = w.document_id AND n.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_item_seen s
          WHERE s.document_id = w.document_id AND s.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_message m
          WHERE m.document_id = w.document_id AND m.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_note t
          WHERE t.document_id = w.document_id AND t.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.live_state l
          WHERE l.document_id = w.document_id AND l.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request r
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_request_version rv
           JOIN collaboration.revision_request r ON r.id = rv.request_id AND r.institution_id = rv.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.revision_response rs
           JOIN collaboration.revision_request r ON r.id = rs.request_id AND r.institution_id = rs.institution_id
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_working_criterion c
          WHERE c.document_id = w.document_id AND c.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.direct_edit_setting_change ec
          WHERE ec.document_id = w.document_id AND ec.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.teacher_edit e
          WHERE e.document_id = w.document_id AND e.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_review v
          WHERE v.document_id = w.document_id AND v.institution_id = w.institution_id);
    PERFORM collaboration.delete_work_self_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_items_seen(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_messages(w.document_id, w.institution_id);
    PERFORM collaboration.delete_teacher_notes(w.document_id, w.institution_id);
    PERFORM collaboration.delete_live_state(w.document_id, w.institution_id);
    PERFORM collaboration.delete_revision_requests(w.document_id, w.institution_id);
    PERFORM collaboration.delete_working_criteria(w.document_id, w.institution_id);
    PERFORM collaboration.delete_direct_edit(w.document_id, w.institution_id);
    PERFORM collaboration.delete_work_reviews(w.document_id, w.institution_id);
  END LOOP;
  RETURN v_rows;
END
$$;
DROP FUNCTION collaboration.delete_work_rubric_levels(text, uuid);
DROP FUNCTION collaboration.save_work_rubric_mark(text, text, smallint, text);
DROP FUNCTION collaboration.list_work_rubric(text);
DROP FUNCTION collaboration.rubric_criterion_ids(uuid);
DROP TABLE collaboration.work_rubric_level;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
