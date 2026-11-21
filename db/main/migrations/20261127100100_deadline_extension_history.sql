-- migrate:up
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- An extension can lengthen the published deadline. A common extension that
-- ends earlier than an individual extension still leaves the latter in force.
CREATE OR REPLACE FUNCTION institution.effective_due_at(p_assignment_id uuid, p_student_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT greatest(v.due_at, (
    SELECT max(e.due_at) FROM institution.deadline_extension e
     WHERE e.assignment_id = a.id AND (e.student_id IS NULL OR e.student_id = p_student_id)
  ))
    FROM institution.assignment a
    JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
   WHERE a.id = p_assignment_id
$$;

-- SRV-1509: the SRV-1108 table already holds the append-only history.
-- Only an active student of the assignment can read this projection. Derive
-- student and institution from the session; include common extensions and
-- the caller's individual extensions, in the same order as the teacher list.
CREATE FUNCTION institution.student_deadline_history(p_assignment_id uuid)
RETURNS TABLE (id uuid, scope text, previous_due_at timestamptz, due_at timestamptz, reason_id text,
               created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF NOT EXISTS (
    SELECT 1 FROM institution.assignment a
     WHERE a.id = p_assignment_id AND a.institution_id = v_institution
       AND institution.work_relation(v_user, a.id) = 'student'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  RETURN QUERY
    SELECT e.id, CASE WHEN e.student_id IS NULL THEN 'all' ELSE 'one' END,
           e.previous_due_at, e.due_at, e.reason_id, e.created_at
      FROM institution.deadline_extension e
     WHERE e.institution_id = v_institution AND e.assignment_id = p_assignment_id
       AND (e.student_id = v_user OR e.student_id IS NULL)
     ORDER BY e.seq;
END
$$;
REVOKE ALL ON FUNCTION institution.student_deadline_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.student_deadline_history(uuid) TO ductus_app;

-- Preserve the published base due_at and populate its existing optional
-- extension field from the same deadline used to pin a submission request.
CREATE OR REPLACE FUNCTION institution.student_assignments()
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
  teachers jsonb
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
                 AND institution.is_confirmed_teacher(tm.user_id, c.id)) t), '[]'::jsonb)
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

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION institution.student_deadline_history(uuid);

CREATE OR REPLACE FUNCTION institution.effective_due_at(p_assignment_id uuid, p_student_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT e.due_at FROM institution.deadline_extension e
      WHERE e.assignment_id = p_assignment_id
        AND (e.student_id IS NULL OR e.student_id = p_student_id)
      ORDER BY e.seq DESC LIMIT 1),
    (SELECT v.due_at FROM institution.assignment a
       JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
      WHERE a.id = p_assignment_id))
$$;

CREATE OR REPLACE FUNCTION institution.student_assignments()
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
  teachers jsonb
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
    NULL::timestamptz,
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
                 AND institution.is_confirmed_teacher(tm.user_id, c.id)) t), '[]'::jsonb)
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

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
