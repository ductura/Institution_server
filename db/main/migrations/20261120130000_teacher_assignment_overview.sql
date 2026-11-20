-- migrate:up
-- SRV-28 (Ductus#2028, c.7009405737), part 2 of 2: what the teacher's screens
-- of wave 5 read.
--
--   app.assignment_overview  N-17 (SRV-27 teacher.assignment-overview.get): per
--                       student of the assignment the name, the seminar group,
--                       whether it was submitted, the minute, after the
--                       deadline, and the evidence record of the receipt (null
--                       while the receipt is pending). The rows are those of
--                       app.assignment_submissions for the same caller and the
--                       receipt is read by the one reader
--                       app.submission_state_of (SRV-20). No text, hash or id
--                       of a submission, and it writes nothing: the overview
--                       opens no work, so there is no audit.access_log row.
--   app.teacher_course_students  the same rows as before, with the seminar
--                       group of each student (N-04, SRV-27 "grupa").
--
-- C-7: the collaborator of a course (a teacher of one of its groups,
-- institution.is_course_team_member) already passes both
-- app.teacher_course_students and app.assignment_submissions, for the
-- students of the own groups only, as the group scope decided (20261104100000,
-- DAN-351; db/main/tests/099 and 100). The holder and every teacher of the
-- course get the whole course. Nothing of that boundary changes here; the
-- overview inherits it. No session: ZD401.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;

-- The overview takes its rows from app.assignment_submissions, as its owner.
SET LOCAL ROLE ductus_evidence;
GRANT EXECUTE ON FUNCTION app.assignment_submissions(uuid) TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_identity;

-- As 20261104100000, with the open seminar group of each student (at most one
-- per student and course, seminar_group_member_open_idx), NULL without one.
-- squawk-ignore ban-drop-function
DROP FUNCTION app.teacher_course_students(uuid);
CREATE FUNCTION app.teacher_course_students(p_course_id uuid)
RETURNS TABLE (student_id uuid, given_name text, family_name text, group_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_role text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  v_role := institution.actor_course_role(p_course_id);
  RETURN QUERY
  SELECT m.user_id, n.given_name, n.family_name, g.name
    FROM institution.course_member m
    LEFT JOIN identity.person_name n ON n.user_id = m.user_id AND n.institution_id = m.institution_id
    LEFT JOIN institution.seminar_group_member p
      ON p.course_id = m.course_id AND p.institution_id = m.institution_id AND p.user_id = m.user_id
     AND p.valid_to IS NULL
    LEFT JOIN institution.seminar_group g ON g.id = p.group_id AND g.institution_id = p.institution_id
   WHERE m.course_id = p_course_id AND m.institution_id = v_actor.institution_id
     AND m.role = 'student' AND m.member_to IS NULL
     AND (v_role = 'teacher' OR institution.actor_group_student(p_course_id, m.user_id))
   ORDER BY m.user_id;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_course_students(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_course_students(uuid) TO ductus_app;

-- One row per row of app.assignment_submissions for the same caller, in its
-- order; every caller it gives nothing gets nothing. The group is the
-- student's open one in the assignment's course (none for a mentorship's
-- assignment). The evidence record is that of the bound receipt, read only
-- for a submitted student.
CREATE FUNCTION app.assignment_overview(p_assignment_id uuid)
RETURNS TABLE (
  student_id uuid, given_name text, family_name text, group_name text,
  submitted boolean, requested_minute timestamptz, after_deadline boolean, evidence_record text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
  SELECT s.student_id, n.given_name, n.family_name, g.name, s.submitted, s.requested_minute, s.after_deadline,
         CASE WHEN s.submitted THEN (
           SELECT x.receipt_payload::jsonb ->> 'evidenceRecord'
             FROM app.submission_state_of(p_assignment_id, s.student_id) x
            WHERE x.state = 'potvrdeno')
         END
    FROM app.assignment_submissions(p_assignment_id) s
    LEFT JOIN identity.person_name n ON n.user_id = s.student_id AND n.institution_id = v_actor.institution_id
    LEFT JOIN institution.assignment a ON a.id = p_assignment_id AND a.institution_id = v_actor.institution_id
    LEFT JOIN institution.seminar_group_member p
      ON p.course_id = a.course_id AND p.institution_id = a.institution_id AND p.user_id = s.student_id
     AND p.valid_to IS NULL
    LEFT JOIN institution.seminar_group g ON g.id = p.group_id AND g.institution_id = p.institution_id
   ORDER BY s.student_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_overview(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assignment_overview(uuid);
DROP FUNCTION app.teacher_course_students(uuid);
CREATE FUNCTION app.teacher_course_students(p_course_id uuid)
RETURNS TABLE (student_id uuid, given_name text, family_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_role text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  v_role := institution.actor_course_role(p_course_id);
  RETURN QUERY
  SELECT m.user_id, n.given_name, n.family_name
    FROM institution.course_member m
    LEFT JOIN identity.person_name n ON n.user_id = m.user_id AND n.institution_id = m.institution_id
   WHERE m.course_id = p_course_id AND m.institution_id = v_actor.institution_id
     AND m.role = 'student' AND m.member_to IS NULL
     AND (v_role = 'teacher' OR institution.actor_group_student(p_course_id, m.user_id))
   ORDER BY m.user_id;
END
$$;
REVOKE ALL ON FUNCTION app.teacher_course_students(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teacher_course_students(uuid) TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
SET LOCAL ROLE ductus_evidence;
REVOKE EXECUTE ON FUNCTION app.assignment_submissions(uuid) FROM ductus_identity;
RESET ROLE;
