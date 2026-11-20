-- migrate:up
-- SRV-21 (Ductus#2028, c.7009405737; C-5, PD-4): a student's notes on an
-- assignment, kept beside the submission. A note is never part of the
-- submission, its signed receipt or the process summary (PO-17), and is only
-- ever added: no update, no delete, no truncate, for the owner too.
--
--   evidence.submission_note    the notes; forced RLS with only the owner's
--                               policy, no privilege for any other role
--   app.submission_note_append  the one writer; no access check, executable
--                               only by ductus_identity
--   app.submission_notes_of     the one reader of a student's notes on an
--                               assignment; the same
--   app.add_submission_note     the caller adds a note on an assignment of a
--                               course where they hold an open student
--                               membership (or of their mentorship)
--   app.submission_notes        the caller's own notes (p_student_id null or
--                               the caller), or one student's notes for a
--                               reader of that student's work: the teacher of
--                               the course (holder or collaborator, C-7),
--                               the teacher of the student's seminar group,
--                               the mentor; the same readers as
--                               app.teacher_submission_state (20261119160000)
--
-- As for the submission state, the web role reaches the table only through
-- the two RPCs (the client never writes evidence directly), and the identity
-- role has no right on the evidence schema: it calls the two helpers, which
-- belong to the evidence role. The institution comes from the session, never
-- from a parameter. Errors carry no input: ZD401 no session, ZD403 no
-- relation (also for an assignment or student that does not exist, one
-- answer for every refusal), ZD422 invalid text.
--
-- The text is that of the contract (student.submission-notes.post): 1 to 600
-- characters (code points) with at least one that is not blank. Reading notes
-- writes nothing to audit.access_log: the log's surfaces are a closed list
-- (rule 17 names the work, the summary and the receipt) and none of them is a
-- note.
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

CREATE TABLE evidence.submission_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 600 AND text ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX submission_note_work_idx
  ON evidence.submission_note (institution_id, assignment_id, student_id, created_at, id);

-- The same refusal as audit.reject_change (mentorship_event), in the schema
-- the evidence role owns: that role has no right on schema audit.
CREATE TRIGGER submission_note_append_only BEFORE UPDATE OR DELETE ON evidence.submission_note
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER submission_note_no_truncate BEFORE TRUNCATE ON evidence.submission_note
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.submission_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_note FORCE ROW LEVEL SECURITY;
CREATE POLICY submission_note_owner ON evidence.submission_note TO ductus_evidence USING (true) WITH CHECK (true);

-- The writer and the reader. Neither checks access: only the definer
-- functions of ductus_identity below call them, after their own check.
CREATE FUNCTION app.submission_note_append(p_assignment_id uuid, p_student_id uuid, p_text text)
RETURNS TABLE (id uuid, text text, created_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO evidence.submission_note (institution_id, assignment_id, student_id, text)
  SELECT a.institution_id, p_assignment_id, p_student_id, p_text
    FROM app.current_actor() a
   WHERE a.institution_id IS NOT NULL
  RETURNING submission_note.id, submission_note.text, submission_note.created_at
$$;
REVOKE ALL ON FUNCTION app.submission_note_append(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_note_append(uuid, uuid, text) TO ductus_identity;

-- Oldest first, then by id (the contract's order).
CREATE FUNCTION app.submission_notes_of(p_assignment_id uuid, p_student_id uuid)
RETURNS TABLE (id uuid, text text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT n.id, n.text, n.created_at
    FROM app.current_actor() a
    JOIN evidence.submission_note n
      ON n.institution_id = a.institution_id AND n.assignment_id = p_assignment_id
     AND n.student_id = p_student_id
   ORDER BY n.created_at, n.id
$$;
REVOKE ALL ON FUNCTION app.submission_notes_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_notes_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The caller adds a note on an assignment of which they are the student
-- (collaboration.actor_role's student branch, as app.my_submission_state). A
-- removed student, a teacher and anyone else: ZD403. Returns the stored note.
CREATE FUNCTION app.add_submission_note(p_assignment_id uuid, p_text text)
RETURNS TABLE (id uuid, text text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 600 OR p_text !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY SELECT * FROM app.submission_note_append(p_assignment_id, v_user, p_text);
END
$$;
REVOKE ALL ON FUNCTION app.add_submission_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_submission_note(uuid, text) TO ductus_app;

-- The notes of one student on an assignment. With p_student_id null or the
-- caller: the caller's own, under the same relation as adding them. Else: the
-- reader and the student of app.teacher_submission_state, checked the same
-- way (audit.reader_role, and the student is or was a student of the course
-- or is the student of the mentorship). Every refusal is ZD403. One STABLE
-- read; writes nothing.
CREATE FUNCTION app.submission_notes(p_assignment_id uuid, p_student_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, text text, created_at timestamptz)
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
  RETURN QUERY SELECT * FROM app.submission_notes_of(p_assignment_id, v_student);
END
$$;
REVOKE ALL ON FUNCTION app.submission_notes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_notes(uuid, uuid) TO ductus_app;

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
DROP FUNCTION app.submission_notes(uuid, uuid);
DROP FUNCTION app.add_submission_note(uuid, text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.submission_notes_of(uuid, uuid);
DROP FUNCTION app.submission_note_append(uuid, uuid, text);
DROP TABLE evidence.submission_note;
RESET ROLE;
