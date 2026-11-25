-- migrate:up
-- SRV-NF4-KASNA-POLJE (Ductus#2055, orchestrator decision A). An assignment
-- says whether a submission after its deadline is allowed. Expand only: a
-- new column with a constant default, so every assignment that exists, and
-- every one made by a path that does not name the field, keeps today's
-- behaviour (allowed). The field may change after publication (answer 3).
-- This migration adds only the field and its reads; enforcement is
-- SRV-NF4-KASNA-PROVEDBA, which reads the same column.
--
--   institution.assignment.late_submission_allowed  true by default.
--   institution.set_late_submission_allowed()  the teacher of the assignment
--                   sets it (C-23); the row is taken FOR UPDATE, setting the
--                   value in force writes nothing.
--   app.my_assignment_late_submission()  a student of the course of the
--                   assignment reads it; anyone else reads not_found.
--
-- Errors carry no input: ZD401 no session, ZD403 no relation, ZD422 invalid
-- input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution, app TO ductus_identity;

SET LOCAL ROLE ductus_identity;
-- A constant default keeps existing and legacy-created assignments as today.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE institution.assignment ADD COLUMN late_submission_allowed boolean NOT NULL DEFAULT true;

CREATE FUNCTION institution.set_late_submission_allowed(p_assignment_id uuid, p_allowed boolean)
RETURNS TABLE (late_submission_allowed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_current boolean;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_allowed IS NULL THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  SELECT a.late_submission_allowed INTO v_current FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_current IS DISTINCT FROM p_allowed THEN
    UPDATE institution.assignment a SET late_submission_allowed = p_allowed
     WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
  END IF;
  RETURN QUERY SELECT p_allowed;
END
$$;
REVOKE ALL ON FUNCTION institution.set_late_submission_allowed(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.set_late_submission_allowed(uuid, boolean) TO ductus_app;

-- The field for a student of the course of the assignment, as
-- app.my_assignment_requirements; anyone else: not_found.
CREATE FUNCTION app.my_assignment_late_submission(p_assignment_id uuid)
RETURNS TABLE (outcome text, late_submission_allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT 'found'::text, a.late_submission_allowed
    FROM institution.assignment a
   WHERE a.id = p_assignment_id AND a.institution_id = v_institution;
END
$$;
REVOKE ALL ON FUNCTION app.my_assignment_late_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_assignment_late_submission(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution, app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.my_assignment_late_submission(uuid);
DROP FUNCTION institution.set_late_submission_allowed(uuid, boolean);
ALTER TABLE institution.assignment DROP COLUMN late_submission_allowed;
