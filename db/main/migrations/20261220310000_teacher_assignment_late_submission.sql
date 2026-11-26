-- migrate:up
-- F4-NAS-R01-SRV (Ductus#2055). The teacher of an assignment reads whether a
-- submission after its deadline is allowed, so the form shows the value in
-- force instead of the default. Expand only: one new read; the column, its
-- setter and the student's read (20261219160000) stay as they are.
--
--   app.teacher_assignment_late_submission()  the teacher of the assignment
--                   reads it, by the same relation as
--                   institution.set_late_submission_allowed (C-23); a
--                   student, another teacher, another institution and an
--                   unknown assignment read not_found.
--
-- Errors carry no input: ZD401 no session.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.teacher_assignment_late_submission(p_assignment_id uuid)
RETURNS TABLE (outcome text, late_submission_allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_allowed boolean;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::boolean;
    RETURN;
  END IF;
  SELECT a.late_submission_allowed INTO v_allowed FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text, v_allowed;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_assignment_late_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_assignment_late_submission(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_assignment_late_submission(uuid);
