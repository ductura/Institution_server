-- migrate:up
-- F4-V13-R04-SRV2 (Ductus#2059, orchestrator 28. 11. 2026; WEB#1146, R04): a
-- slides assignment is created (201), yet the student gets the text editor,
-- because student.assignments.get does not say which kind of document the
-- assignment asks for. institution.student_assignments() now also answers
-- institution.assignment.document_kind ('text', 'slides' or 'spreadsheet';
-- 20261219360000, 20261220120000, written once by 20261220880000), so the
-- route can carry documentKind and workKind.
--
-- A new result column changes the return type, which CREATE OR REPLACE cannot
-- do, so the function is dropped and created again (as 20261220210000 did)
-- with the same body, the same owner, LANGUAGE plpgsql STABLE SECURITY
-- DEFINER with an empty search_path, the same grant (EXECUTE for ductus_app,
-- nothing for PUBLIC) and the column last. The rows are exactly those of
-- 20261220210000: the same predicate, joins and order, so no one sees an
-- assignment or a row they did not see before. No table, policy or grant on a
-- table changes.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.student_assignments();
CREATE FUNCTION institution.student_assignments()
RETURNS TABLE (
  assignment_id uuid,
  course_id uuid,
  course_name text,
  academic_year text,
  title text,
  work_type text,
  opens_at timestamptz,
  due_at timestamptz,
  extended_due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  notice_read boolean,
  groups text[],
  mentors jsonb,
  teachers jsonb,
  is_practice boolean,
  document_kind text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  -- ZD401 without a live session.
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  RETURN QUERY
  SELECT a.id, c.id, c.name, c.academic_year, v.title, v.work_type, v.opens_at, v.due_at,
    nullif(institution.effective_due_at(a.id, v_user), v.due_at),
    a.current_version,
    EXISTS (
      SELECT 1 FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = a.id AND n.version_no = a.current_version
         AND n.student_id = v_user AND n.institution_id = v_institution),
    EXISTS (
      SELECT 1 FROM institution.notice_read r
       WHERE r.assignment_id = a.id AND r.student_id = v_user AND r.institution_id = v_institution),
    coalesce((
      SELECT array_agg(g.name ORDER BY g.name)
        FROM institution.seminar_group_member s
        JOIN institution.seminar_group g ON g.id = s.group_id AND g.institution_id = v_institution
       WHERE s.course_id = c.id AND s.user_id = v_user AND s.institution_id = v_institution
         AND s.valid_to IS NULL), '{}'::text[]),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.user_id, 'name', t.name) ORDER BY t.user_id)
        FROM (SELECT DISTINCT gt.user_id, nullif(concat_ws(' ', pn.given_name, pn.family_name), '') AS name
                FROM institution.seminar_group_member s
                JOIN institution.seminar_group_teacher gt
                  ON gt.group_id = s.group_id AND gt.institution_id = v_institution AND gt.valid_to IS NULL
                LEFT JOIN identity.person_name pn
                  ON pn.user_id = gt.user_id AND pn.institution_id = v_institution
               WHERE s.course_id = c.id AND s.user_id = v_user AND s.institution_id = v_institution
                 AND s.valid_to IS NULL
                 -- A group place outlives a revoked teacher role (revoke_teacher_role).
                 AND institution.is_confirmed_teacher(gt.user_id, c.id)) t), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.user_id, 'name', t.name, 'role', t.role)
                       ORDER BY t.role DESC, t.user_id)
        FROM (SELECT tm.user_id, nullif(concat_ws(' ', pn.given_name, pn.family_name), '') AS name,
                     CASE WHEN EXISTS (
                       SELECT 1 FROM institution.course_holder h
                        WHERE h.course_id = c.id AND h.institution_id = v_institution
                          AND h.user_id = tm.user_id AND h.valid_to IS NULL)
                     THEN 'holder' ELSE 'collaborator' END AS role
                FROM institution.course_member tm
                LEFT JOIN identity.person_name pn
                  ON pn.user_id = tm.user_id AND pn.institution_id = v_institution
               WHERE tm.course_id = c.id AND tm.institution_id = v_institution
                 AND tm.role = 'teacher' AND tm.member_to IS NULL
                 AND institution.is_confirmed_teacher(tm.user_id, c.id)) t), '[]'::jsonb),
    a.is_practice,
    a.document_kind
    FROM institution.course_member m
    JOIN institution.course c
      ON c.id = m.course_id AND c.institution_id = v_institution
    JOIN institution.assignment a
      ON a.course_id = c.id AND a.institution_id = v_institution
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE m.user_id = v_user AND m.institution_id = v_institution
     AND m.role = 'student' AND m.member_to IS NULL
   ORDER BY c.id, v.due_at, a.id;
END
$$;
REVOKE ALL ON FUNCTION institution.student_assignments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.student_assignments() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- Back to the function of 20261220210000, without document_kind.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.student_assignments();
CREATE FUNCTION institution.student_assignments()
RETURNS TABLE (
  assignment_id uuid,
  course_id uuid,
  course_name text,
  academic_year text,
  title text,
  work_type text,
  opens_at timestamptz,
  due_at timestamptz,
  extended_due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  notice_read boolean,
  groups text[],
  mentors jsonb,
  teachers jsonb,
  is_practice boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  -- ZD401 without a live session.
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  RETURN QUERY
  SELECT a.id, c.id, c.name, c.academic_year, v.title, v.work_type, v.opens_at, v.due_at,
    nullif(institution.effective_due_at(a.id, v_user), v.due_at),
    a.current_version,
    EXISTS (
      SELECT 1 FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = a.id AND n.version_no = a.current_version
         AND n.student_id = v_user AND n.institution_id = v_institution),
    EXISTS (
      SELECT 1 FROM institution.notice_read r
       WHERE r.assignment_id = a.id AND r.student_id = v_user AND r.institution_id = v_institution),
    coalesce((
      SELECT array_agg(g.name ORDER BY g.name)
        FROM institution.seminar_group_member s
        JOIN institution.seminar_group g ON g.id = s.group_id AND g.institution_id = v_institution
       WHERE s.course_id = c.id AND s.user_id = v_user AND s.institution_id = v_institution
         AND s.valid_to IS NULL), '{}'::text[]),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.user_id, 'name', t.name) ORDER BY t.user_id)
        FROM (SELECT DISTINCT gt.user_id, nullif(concat_ws(' ', pn.given_name, pn.family_name), '') AS name
                FROM institution.seminar_group_member s
                JOIN institution.seminar_group_teacher gt
                  ON gt.group_id = s.group_id AND gt.institution_id = v_institution AND gt.valid_to IS NULL
                LEFT JOIN identity.person_name pn
                  ON pn.user_id = gt.user_id AND pn.institution_id = v_institution
               WHERE s.course_id = c.id AND s.user_id = v_user AND s.institution_id = v_institution
                 AND s.valid_to IS NULL
                 -- A group place outlives a revoked teacher role (revoke_teacher_role).
                 AND institution.is_confirmed_teacher(gt.user_id, c.id)) t), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.user_id, 'name', t.name, 'role', t.role)
                       ORDER BY t.role DESC, t.user_id)
        FROM (SELECT tm.user_id, nullif(concat_ws(' ', pn.given_name, pn.family_name), '') AS name,
                     CASE WHEN EXISTS (
                       SELECT 1 FROM institution.course_holder h
                        WHERE h.course_id = c.id AND h.institution_id = v_institution
                          AND h.user_id = tm.user_id AND h.valid_to IS NULL)
                     THEN 'holder' ELSE 'collaborator' END AS role
                FROM institution.course_member tm
                LEFT JOIN identity.person_name pn
                  ON pn.user_id = tm.user_id AND pn.institution_id = v_institution
               WHERE tm.course_id = c.id AND tm.institution_id = v_institution
                 AND tm.role = 'teacher' AND tm.member_to IS NULL
                 AND institution.is_confirmed_teacher(tm.user_id, c.id)) t), '[]'::jsonb),
    a.is_practice
    FROM institution.course_member m
    JOIN institution.course c
      ON c.id = m.course_id AND c.institution_id = v_institution
    JOIN institution.assignment a
      ON a.course_id = c.id AND a.institution_id = v_institution
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE m.user_id = v_user AND m.institution_id = v_institution
     AND m.role = 'student' AND m.member_to IS NULL
   ORDER BY c.id, v.due_at, a.id;
END
$$;
REVOKE ALL ON FUNCTION institution.student_assignments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.student_assignments() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
