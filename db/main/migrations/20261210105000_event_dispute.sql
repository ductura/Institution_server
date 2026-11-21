-- migrate:up
-- SRV-1314 (Ductus#2052; plan M7.8, R-08): beside a student's notes on the
-- submission (evidence.submission_note, 20261120090000), the student who owns
-- the work adds an amendment to, or disputes, the description of one event of
-- the process summary. A record is only ever added: no update, no delete, no
-- truncate, for the owner too. It never changes the signed receipt, the
-- accepted evidence or the event itself: it is a separate row that names the
-- event by its id in the summary.
--
--   evidence.event_dispute     the records; forced RLS with only the owner's
--                              policy, no privilege for any other role
--   app.event_dispute_append   the one writer; no access check, executable
--                              only by ductus_identity
--   app.event_disputes_of      the one reader of a student's records on an
--                              assignment; the same
--   app.add_event_dispute      the caller adds a record on an assignment of
--                              which they are the student (an open student
--                              membership of the course, or the mentorship)
--   app.event_disputes         the caller's own records (p_student_id null or
--                              the caller), or one student's records for a
--                              reader of that student's work: the teacher of
--                              the course (holder or collaborator, C-7), the
--                              teacher of the student's seminar group, the
--                              mentor; the same readers as
--                              app.submission_notes (20261120090000)
--
-- As for the notes, the web role reaches the table only through the two RPCs
-- (the client never writes evidence directly), and the identity role has no
-- right on the evidence schema: it calls the two helpers, which belong to the
-- evidence role. The institution comes from the session, never from a
-- parameter. Errors carry no input: ZD401 no session, ZD403 no relation (also
-- for an assignment or student that does not exist, one answer for every
-- refusal), ZD422 invalid input. The input is checked before the relation, so
-- a refusal of the input says nothing of the assignment.
--
-- The input: kind 'amendment' or 'dispute'; the event id as the summary names
-- it, 1 to 128 characters of [a-z0-9_.:/-] starting with a letter (the
-- database cannot recompute the summary, so the id is kept as given and not
-- matched against it); the text 1 to 1000 characters (code points) with at
-- least one that is not blank. Reading the records writes nothing to
-- audit.access_log: the log's surfaces are a closed list (rule 17 names the
-- work, the summary and the receipt) and a record is none of them.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT USAGE ON SCHEMA institution, identity TO ductus_evidence;
SET LOCAL ROLE ductus_identity;
GRANT REFERENCES ON institution.assignment, identity.user_account TO ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.event_dispute (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('amendment', 'dispute')),
  event_id text NOT NULL CHECK (event_id ~ '^[a-z][a-z0-9_.:/-]{0,127}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000 AND text ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX event_dispute_work_idx
  ON evidence.event_dispute (institution_id, assignment_id, student_id, created_at, id);

-- The same refusal as for the notes, in the schema the evidence role owns.
CREATE TRIGGER event_dispute_append_only BEFORE UPDATE OR DELETE ON evidence.event_dispute
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER event_dispute_no_truncate BEFORE TRUNCATE ON evidence.event_dispute
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.event_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.event_dispute FORCE ROW LEVEL SECURITY;
CREATE POLICY event_dispute_owner ON evidence.event_dispute TO ductus_evidence USING (true) WITH CHECK (true);

-- The writer and the reader. Neither checks access: only the definer
-- functions of ductus_identity below call them, after their own check.
CREATE FUNCTION app.event_dispute_append(p_assignment_id uuid, p_student_id uuid, p_kind text, p_event_id text, p_text text)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.event_dispute (institution_id, assignment_id, student_id, kind, event_id, text)
  SELECT a.institution_id, p_assignment_id, p_student_id, p_kind, p_event_id, p_text
    FROM app.current_actor() a
   WHERE a.institution_id IS NOT NULL
  RETURNING event_dispute.id, event_dispute.kind, event_dispute.event_id, event_dispute.text, event_dispute.created_at
$$;
REVOKE ALL ON FUNCTION app.event_dispute_append(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.event_dispute_append(uuid, uuid, text, text, text) TO ductus_identity;

-- Oldest first, then by id.
CREATE FUNCTION app.event_disputes_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT d.id, d.kind, d.event_id, d.text, d.created_at
    FROM app.current_actor() a
    JOIN evidence.event_dispute d
      ON d.institution_id = a.institution_id AND d.assignment_id = p_assignment_id
     AND d.student_id = p_student_id
   ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION app.event_disputes_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.event_disputes_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The caller adds a record on an assignment of which they are the student
-- (collaboration.actor_role's student branch, as app.add_submission_note). A
-- removed student, a teacher and anyone else: ZD403. Returns the stored row.
CREATE FUNCTION app.add_event_dispute(p_assignment_id uuid, p_kind text, p_event_id text, p_text text)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_kind IS NULL OR p_kind NOT IN ('amendment', 'dispute')
     OR p_event_id IS NULL OR p_event_id !~ '^[a-z][a-z0-9_.:/-]{0,127}$'
     OR p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 1000 OR p_text !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.event_dispute_append(p_assignment_id, v_user, p_kind, p_event_id, p_text);
END
$$;
REVOKE ALL ON FUNCTION app.add_event_dispute(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_event_dispute(uuid, text, text, text) TO ductus_app;

-- The records of one student on an assignment. With p_student_id null or the
-- caller: the caller's own, under the same relation as adding them. Else: the
-- readers and the student of app.submission_notes, checked the same way
-- (audit.reader_role, and the student is or was a student of the course or is
-- the student of the mentorship). Every refusal is ZD403. One STABLE read;
-- writes nothing.
CREATE FUNCTION app.event_disputes(p_assignment_id uuid, p_student_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, kind text, event_id text, text text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_student uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  v_student := coalesce(p_student_id, v_user);
  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_student = v_user THEN
    IF collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
    END IF;
  ELSIF audit.reader_role(v_institution, p_assignment_id, v_student) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM institution.assignment s
        WHERE s.id = p_assignment_id AND s.institution_id = v_institution
          AND (EXISTS (SELECT 1 FROM institution.course_member m
                        WHERE m.course_id = s.course_id AND m.institution_id = s.institution_id
                          AND m.user_id = v_student AND m.role = 'student')
               OR EXISTS (SELECT 1 FROM institution.mentorship t
                           WHERE t.id = s.mentorship_id AND t.institution_id = s.institution_id
                             AND t.student_id = v_student))) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.event_disputes_of(p_assignment_id, v_student);
END
$$;
REVOKE ALL ON FUNCTION app.event_disputes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.event_disputes(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
REVOKE REFERENCES ON institution.assignment, identity.user_account FROM ductus_evidence;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE USAGE ON SCHEMA institution, identity FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.event_disputes(uuid, uuid);
DROP FUNCTION app.add_event_dispute(uuid, text, text, text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.event_disputes_of(uuid, uuid);
DROP FUNCTION app.event_dispute_append(uuid, uuid, text, text, text);
DROP TABLE evidence.event_dispute;
RESET ROLE;
