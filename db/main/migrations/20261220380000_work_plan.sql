-- migrate:up
-- SRV-F4-PM2-R15 (Ductus#2059; F4-PM2-R15-SRV, row PM2-R15 of docs/nalazi/pregled-funkcija-f4.md
-- in the WEB repo; plan M5.14b, owner decisions D-234 and D-250): the plan of a work behind the
-- panel "Struktura" (S-14), kept on the server per work: the question of the work (the thesis),
-- the purpose of each chapter and the glossary. The server stores it and never reads it against
-- the document: a chapter is named by the id of its heading block, as a text anchor's nodeId,
-- never by text of the work.
--
-- The plan is not a change of the document (D-234 point 1): it writes no document, revision,
-- segment, receipt or hash, so it is in no hash chain, in no live view (D-142) and in no
-- reproduction (D-143). It follows the work and goes with it (D-130, as the note to self).
--
--   collaboration.work_plan           one row per work; forced RLS, owner policy only
--   collaboration.get_work_plan       the owner reads it
--   collaboration.put_work_plan       the owner writes the whole plan; an empty plan deletes the row
--   collaboration.delete_work_plans   retention only, called by the orphan sweep
--
-- Who may (C-23, from the relation, never from the role alone): the student who owns the work,
-- decided on every call (collaboration.self_note_scope). The mentor does not see the plan in wave 1
-- (D-234 point 2), and neither do the teachers of the work or the administrator. Another's work,
-- an unknown and a malformed work are the same ZD403. The plan may be written while the work is
-- under revision (D-234 point 6): nothing here looks at the state of the work, and nothing is
-- kept per round. Errors carry no input: ZD401 no session, ZD403 no relation, ZD422 invalid input.
--
-- Shape: question null or a line of 1 to 300 characters; purposes up to 200 of {nodeId, purpose}
-- (a block id once, purpose a line of 1 to 300); terms up to 200 of {term, definition, kind} (a
-- term once, case aside; a line of 1 to 80, a line of 1 to 500, kind term|abbreviation). A line has
-- no control character, no bidi control, is NFC and has no space at its ends.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- One line of 1 to p_max characters.
CREATE FUNCTION collaboration.is_plan_line(p_text text, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(
    p_text IS NOT NULL AND p_text IS NFC NORMALIZED
    AND char_length(p_text) BETWEEN 1 AND p_max
    AND p_text = btrim(p_text)
    AND p_text ~ '[^[:space:]]'
    AND p_text !~ '[[:cntrl:]]'
    AND p_text !~ E'[‪-‮⁦-⁩]',
    false)
$$;

-- The chapter purposes: an array of up to 200 objects with exactly nodeId and purpose.
CREATE FUNCTION collaboration.is_plan_purposes(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  e jsonb;
  v_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 200 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_value) x LOOP
    IF jsonb_typeof(e) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['nodeId', 'purpose']
       OR jsonb_typeof(e->'nodeId') <> 'string'
       OR e->>'nodeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR jsonb_typeof(e->'purpose') <> 'string'
       OR NOT collaboration.is_plan_line(e->>'purpose', 300)
       OR lower(e->>'nodeId') = ANY (v_ids) THEN
      RETURN false;
    END IF;
    v_ids := v_ids || lower(e->>'nodeId');
  END LOOP;
  RETURN true;
END
$$;

-- The glossary: an array of up to 200 objects with exactly term, definition and kind.
CREATE FUNCTION collaboration.is_plan_terms(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  e jsonb;
  v_terms text[] := ARRAY[]::text[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 200 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_value) x LOOP
    IF jsonb_typeof(e) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['definition', 'kind', 'term']
       OR jsonb_typeof(e->'term') <> 'string' OR jsonb_typeof(e->'definition') <> 'string'
       OR jsonb_typeof(e->'kind') <> 'string'
       OR e->>'kind' NOT IN ('term', 'abbreviation')
       OR NOT collaboration.is_plan_line(e->>'term', 80)
       OR NOT collaboration.is_plan_line(e->>'definition', 500)
       OR lower(e->>'term') = ANY (v_terms) THEN
      RETURN false;
    END IF;
    v_terms := v_terms || lower(e->>'term');
  END LOOP;
  RETURN true;
END
$$;

-- No foreign key to evidence.document, as the note to self: the document is checked when the row
-- is written and its owner copied then.
CREATE TABLE collaboration.work_plan (
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  owner_id uuid NOT NULL,
  question text CHECK (question IS NULL OR collaboration.is_plan_line(question, 300)),
  purposes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (collaboration.is_plan_purposes(purposes)),
  terms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (collaboration.is_plan_terms(terms)),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (document_id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  -- A plan with nothing in it is deleted, never kept.
  CHECK (question IS NOT NULL OR purposes <> '[]'::jsonb OR terms <> '[]'::jsonb)
);

ALTER TABLE collaboration.work_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.work_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY work_plan_owner ON collaboration.work_plan
  TO ductus_identity USING (true) WITH CHECK (true);
REVOKE ALL ON collaboration.work_plan FROM PUBLIC, ductus_app;

-- The owner's plan of a work: no row when none is kept.
CREATE FUNCTION collaboration.get_work_plan(p_document_id text)
RETURNS TABLE (question text, purposes jsonb, terms jsonb, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  RETURN QUERY
    SELECT p.question, p.purposes, p.terms, p.updated_at
      FROM collaboration.work_plan p
     WHERE p.document_id = p_document_id AND p.institution_id = v_scope.institution_id;
END
$$;

-- The owner writes the whole plan, replacing the earlier one; a plan with no question, no purpose
-- and no term deletes the row. Answers the plan as kept (no row after a delete).
CREATE FUNCTION collaboration.put_work_plan(p_document_id text, p_question text, p_purposes jsonb, p_terms jsonb)
RETURNS TABLE (question text, purposes jsonb, terms jsonb, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  -- Checked before the table constraints, whose errors would quote the row.
  IF (p_question IS NOT NULL AND NOT collaboration.is_plan_line(p_question, 300))
     OR NOT collaboration.is_plan_purposes(p_purposes) OR NOT collaboration.is_plan_terms(p_terms) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_question IS NULL AND p_purposes = '[]'::jsonb AND p_terms = '[]'::jsonb THEN
    DELETE FROM collaboration.work_plan p
     WHERE p.document_id = p_document_id AND p.institution_id = v_scope.institution_id;
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO collaboration.work_plan AS p
      (institution_id, document_id, owner_id, question, purposes, terms, updated_at)
    VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_question, p_purposes, p_terms,
            statement_timestamp())
    ON CONFLICT (document_id, institution_id) DO UPDATE
      SET question = EXCLUDED.question, purposes = EXCLUDED.purposes, terms = EXCLUDED.terms,
          updated_at = EXCLUDED.updated_at
    RETURNING p.question, p.purposes, p.terms, p.updated_at;
END
$$;

-- For the retention role only (and the orphan sweep below): the plan of a document goes with the
-- document, as delete_work_self_notes. No row: nothing happens. Takes and returns no text.
CREATE FUNCTION collaboration.delete_work_plans(p_document_id text, p_institution_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  DELETE FROM collaboration.work_plan p
   WHERE p.document_id = p_document_id AND p.institution_id = p_institution_id
$$;

REVOKE ALL ON FUNCTION
  collaboration.is_plan_line(text, integer),
  collaboration.is_plan_purposes(jsonb),
  collaboration.is_plan_terms(jsonb),
  collaboration.get_work_plan(text),
  collaboration.put_work_plan(text, text, jsonb, jsonb),
  collaboration.delete_work_plans(text, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.get_work_plan(text),
  collaboration.put_work_plan(text, text, jsonb, jsonb)
TO ductus_app;
GRANT EXECUTE ON FUNCTION collaboration.delete_work_plans(text, uuid) TO ductus_retention;

-- The orphan sweep (20261219270000) now also removes the plan of a work that is gone.
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
            UNION SELECT r.document_id, r.institution_id FROM collaboration.work_rubric_level r
            UNION SELECT p.document_id, p.institution_id FROM collaboration.work_plan p) k
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
               WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id
              UNION SELECT p.owner_id FROM collaboration.work_plan p
               WHERE p.document_id = w.document_id AND p.institution_id = w.institution_id) o (student_id)
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
          WHERE r.document_id = w.document_id AND r.institution_id = w.institution_id)
      + (SELECT count(*) FROM collaboration.work_plan p
          WHERE p.document_id = w.document_id AND p.institution_id = w.institution_id);
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
    PERFORM collaboration.delete_work_plans(w.document_id, w.institution_id);
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
DROP FUNCTION collaboration.delete_work_plans(text, uuid);
DROP FUNCTION collaboration.put_work_plan(text, text, jsonb, jsonb);
DROP FUNCTION collaboration.get_work_plan(text);
DROP TABLE collaboration.work_plan;
DROP FUNCTION collaboration.is_plan_terms(jsonb);
DROP FUNCTION collaboration.is_plan_purposes(jsonb);
DROP FUNCTION collaboration.is_plan_line(text, integer);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
