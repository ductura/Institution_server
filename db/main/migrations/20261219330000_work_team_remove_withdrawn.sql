-- migrate:up
-- SRV-V19-GRUPA-RUTE (Ductus#2055; review of #727 and #729): the teacher can
-- remove a current member of a team who is no longer enrolled in the course.
-- app.teacher_team_member of 20261219310000 asked for work_relation = 'student'
-- on every call, so a student who withdrew from the course stayed in the team:
-- shown to its members, listed by app.teacher_teams and counted against maxSize,
-- with nobody able to remove them (404). Only the function is replaced (the
-- merged migration is untouched); signature, owner and grants stay.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The teacher adds an enrolled student to a team or removes one from it. A
-- current member is removable whether or not still enrolled in the course
-- (a student who withdrew from the course would otherwise stay in the team,
-- be shown to its members and count towards maxSize with nobody able to remove
-- them); an addition still needs an enrolled student. Nothing is deleted: the
-- removal is a 'leave' event.
CREATE OR REPLACE FUNCTION app.teacher_team_member(p_assignment_id uuid, p_team_id uuid, p_student_id uuid, p_action text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  IF p_team_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.work_team t
        WHERE t.id = p_team_id AND t.assignment_id = p_assignment_id AND t.institution_id = v_ctx.o_institution_id)
     OR p_student_id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.work_team_lock(p_assignment_id);
  SELECT s.o_enabled, s.o_max_size INTO v_ctx.o_enabled, v_ctx.o_max_size
    FROM institution.work_team_setting_of(p_assignment_id) s;
  SELECT m.team_id INTO v_current
    FROM institution.work_team_members_now(p_assignment_id) m
   WHERE m.student_id = p_student_id;
  IF p_action = 'remove' THEN
    -- Only a current member of this team: anyone else, enrolled or not, reads 404.
    IF v_current IS DISTINCT FROM p_team_id THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
    END IF;
    -- Teams off: neither an addition nor a removal (work-team-v1.md).
    IF NOT v_ctx.o_enabled OR institution.work_team_part_submitted(p_assignment_id, p_student_id) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO institution.work_team_member_event
      (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
    VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'leave', v_ctx.o_user_id, 'teacher');
    RETURN;
  END IF;
  IF institution.work_relation(p_student_id, p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF NOT v_ctx.o_enabled OR v_current IS NOT NULL
     OR (SELECT count(*) FROM institution.work_team_members_now(p_assignment_id) m
          WHERE m.team_id = p_team_id) >= v_ctx.o_max_size THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_team_member_event
    (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'join', v_ctx.o_user_id, 'teacher');
END
$$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- As 20261219310000: every call needs an enrolled student.
CREATE OR REPLACE FUNCTION app.teacher_team_member(p_assignment_id uuid, p_team_id uuid, p_student_id uuid, p_action text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ctx record;
  v_current uuid;
BEGIN
  SELECT * INTO v_ctx FROM institution.work_team_context(p_assignment_id, 'teacher');
  IF p_team_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM institution.work_team t
        WHERE t.id = p_team_id AND t.assignment_id = p_assignment_id AND t.institution_id = v_ctx.o_institution_id)
     OR p_student_id IS NULL
     OR institution.work_relation(p_student_id, p_assignment_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM institution.work_team_lock(p_assignment_id);
  SELECT s.o_enabled, s.o_max_size INTO v_ctx.o_enabled, v_ctx.o_max_size
    FROM institution.work_team_setting_of(p_assignment_id) s;
  SELECT m.team_id INTO v_current
    FROM institution.work_team_members_now(p_assignment_id) m
   WHERE m.student_id = p_student_id;
  -- Teams off: neither an addition nor a removal (work-team-v1.md).
  IF NOT v_ctx.o_enabled THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF p_action = 'remove' THEN
    IF v_current IS DISTINCT FROM p_team_id THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
    END IF;
    IF institution.work_team_part_submitted(p_assignment_id, p_student_id) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO institution.work_team_member_event
      (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
    VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'leave', v_ctx.o_user_id, 'teacher');
    RETURN;
  END IF;
  IF v_current IS NOT NULL
     OR (SELECT count(*) FROM institution.work_team_members_now(p_assignment_id) m
          WHERE m.team_id = p_team_id) >= v_ctx.o_max_size THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO institution.work_team_member_event
    (institution_id, assignment_id, team_id, student_id, action, actor_id, actor_role)
  VALUES (v_ctx.o_institution_id, p_assignment_id, p_team_id, p_student_id, 'join', v_ctx.o_user_id, 'teacher');
END
$$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
