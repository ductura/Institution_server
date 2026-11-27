-- Dizajn 27. 11., 1.1 i 1.11 (Ductus#2059): the reader of a student's work
-- sees the same "Kod potvrde" the student sees, beside
-- teacher.submission-receipt.get. One STABLE read, nothing written.
--
-- app.teacher_submission_confirmation_code: exactly the check of
-- app.teacher_submission_state (a reader of the work by audit.reader_role, and
-- a student of the assignment); every refusal is that function's ZD403, no
-- session its ZD401. The code is that of app.submission_confirmation_code_of:
-- NULL while there is no submission, it was withdrawn or it waits for its
-- receipt (ceka).
-- migrate:up
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.teacher_submission_confirmation_code(p_assignment_id uuid, p_student_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- The access check of the state, not a copy of it: it raises ZD401 or ZD403.
  PERFORM 1 FROM app.teacher_submission_state(p_assignment_id, p_student_id);
  RETURN app.submission_confirmation_code_of(p_assignment_id, p_student_id);
END
$$;
REVOKE ALL ON FUNCTION app.teacher_submission_confirmation_code(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_submission_confirmation_code(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_submission_confirmation_code(uuid, uuid);
RESET ROLE;
