-- migrate:up
-- INT-31 (Ductus#2055): a student with an approved mentorship could open the
-- notice of the mentored work (bachelor, master ... thesis) but found it in no
-- list, because institution.student_assignments() and app.student_workspace()
-- join only course memberships, while a mentorship assignment has no course
-- (course_id NULL, mentorship_id set). The two existing functions and their
-- callers stay as they are; their parsers require a course. These siblings give
-- the mentored assignments of the caller under exactly the predicate of
-- app.lock_student_assignment (the gate of the work): the caller is the
-- student of an open mentorship of their own institution, and the mentor holds
-- a confirmed, not revoked teacher role there. Nothing is written; who asks
-- comes only from the session.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION institution.student_mentored_assignments()
RETURNS TABLE (
  assignment_id uuid,
  mentorship_id uuid,
  title text,
  work_type text,
  opens_at timestamptz,
  due_at timestamptz,
  extended_due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  mentor_id uuid,
  mentor_given_name text,
  mentor_family_name text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  -- ZD401 without a live session.
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  RETURN QUERY
  SELECT a.id, s.id, v.title, v.work_type, v.opens_at, v.due_at,
    nullif(institution.effective_due_at(a.id, v_user), v.due_at),
    a.current_version,
    EXISTS (
      SELECT 1 FROM institution.notice_acknowledgment n
       WHERE n.assignment_id = a.id AND n.version_no = a.current_version
         AND n.student_id = v_user AND n.institution_id = v_institution),
    s.mentor_id, pn.given_name, pn.family_name
    FROM institution.mentorship s
    JOIN institution.institution_role r
      ON r.user_id = s.mentor_id AND r.institution_id = s.institution_id AND r.role = 'teacher'
     AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
    JOIN institution.assignment a
      ON a.mentorship_id = s.id AND a.institution_id = v_institution AND a.course_id IS NULL
    JOIN institution.assignment_version v
      ON v.assignment_id = a.id AND v.version_no = a.current_version
    LEFT JOIN identity.person_name pn
      ON pn.user_id = s.mentor_id AND pn.institution_id = v_institution
   WHERE s.student_id = v_user AND s.institution_id = v_institution AND s.ended_at IS NULL
   ORDER BY v.due_at, a.id;
END
$$;
REVOKE ALL ON FUNCTION institution.student_mentored_assignments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.student_mentored_assignments() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;

-- The work beside each mentored assignment, as app.student_workspace() gives it
-- beside a course assignment: the caller's own project, document and live
-- submission (neither withdrawn nor returned). SECURITY INVOKER, as its
-- sibling: the RLS of the evidence tables stays a second barrier.
CREATE FUNCTION app.student_mentored_workspace()
RETURNS TABLE (
  assignment_id uuid,
  title text,
  opens_at timestamptz,
  due_at timestamptz,
  current_version integer,
  acknowledged boolean,
  document_id text,
  server_revision bigint,
  submitted_revision bigint,
  submitted_at timestamptz,
  after_deadline boolean
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_institution uuid := app.current_institution_id();
BEGIN
  IF v_user IS NULL OR v_institution IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
  SELECT m.assignment_id, m.title, m.opens_at,
    coalesce(app.student_effective_due_at(m.assignment_id), m.due_at), m.current_version,
    m.acknowledged, d.id, d.current_revision, s.revision, s.requested_at, s.after_deadline
    FROM institution.student_mentored_assignments() m
    LEFT JOIN evidence.project p
      ON p.assignment_id = m.assignment_id AND p.institution_id = v_institution AND p.principal_id = v_user
    LEFT JOIN evidence.document d
      ON d.project_id = p.id AND d.institution_id = v_institution AND d.principal_id = v_user
    LEFT JOIN evidence.submission s
      ON s.assignment_id = m.assignment_id AND s.institution_id = v_institution AND s.principal_id = v_user
     AND NOT EXISTS (SELECT 1 FROM evidence.submission_withdrawal w WHERE w.submission_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM evidence.submission_return rt WHERE rt.submission_id = s.id)
   ORDER BY m.assignment_id, d.id;
END
$$;
REVOKE ALL ON FUNCTION app.student_mentored_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_mentored_workspace() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.student_mentored_workspace();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.student_mentored_assignments();
RESET ROLE;
