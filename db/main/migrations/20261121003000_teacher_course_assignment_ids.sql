-- migrate:up
-- SRV-29: discover the assignment ids for the course roster. The ordinary
-- assignment policy does not cover teachers whose relation is a group.
-- The roster and assignment readers still decide which student/work rows
-- this actor may see.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.teacher_course_assignment_ids(p_course_id uuid)
RETURNS TABLE (assignment_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;

  IF institution.actor_course_role(p_course_id) IS DISTINCT FROM 'teacher'
     AND NOT EXISTS (SELECT 1 FROM app.teacher_course_students(p_course_id)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id
    FROM institution.assignment a
   WHERE a.course_id = p_course_id AND a.institution_id = v_actor.institution_id
   ORDER BY a.id;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_course_assignment_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_course_assignment_ids(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.teacher_course_assignment_ids(uuid);
RESET ROLE;
