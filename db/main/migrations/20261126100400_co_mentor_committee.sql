-- migrate:up
-- SRV-1409 / DAN-379 (M2.8): the existing work_grant binds co_mentor and
-- committee permissions to a specific student and assignment, with expiry
-- and revocation under forced RLS. The mentor still reads via can('read');
-- a co-mentor with read_text reads via grant_can(). Neither role assignment
-- changes the existing student-only submission recording.
-- On a mentorship, committee grants take effect only for a document with a
-- recorded submission. A pending request and a sibling draft do not count.
-- The existing document predicate is private to the identity owner and
-- reads the same statement snapshot as the grant and its bound roles.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.grant_can(p_action text, p_document_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('read_text', 'comment') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL OR p_document_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT s.institution_id, s.assignment_id, s.principal_id INTO v_scope
  FROM collaboration.document_scope(p_document_id) s;
  IF v_scope.institution_id IS DISTINCT FROM v_institution THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM institution.work_grant g
    JOIN institution.assignment a ON a.id = g.assignment_id AND a.institution_id = g.institution_id
    JOIN institution.institution_role ge ON ge.id = g.grantee_role_id
     AND ge.user_id = g.grantee_id AND ge.institution_id = g.institution_id AND ge.role = 'teacher'
     AND ge.confirmed_at IS NOT NULL AND ge.revoked_at IS NULL
    JOIN institution.institution_role gr ON gr.id = g.granter_role_id
     AND gr.user_id = g.granted_by AND gr.institution_id = g.institution_id AND gr.role = 'teacher'
     AND gr.confirmed_at IS NOT NULL AND gr.revoked_at IS NULL
    WHERE g.institution_id = v_institution
      AND g.grantee_id = v_user
      AND g.assignment_id = v_scope.assignment_id
      AND g.student_id = v_scope.principal_id
      AND g.revoked_at IS NULL
      AND statement_timestamp() >= g.valid_from
      AND statement_timestamp() < g.valid_to
      AND p_action = ANY (g.actions)
      AND CASE
            WHEN a.mentorship_id IS NOT NULL AND g.kind = 'committee'
              THEN app.document_submitted(p_document_id)
            ELSE true
          END
      AND CASE
            WHEN a.course_id IS NOT NULL THEN EXISTS (
              SELECT 1 FROM institution.course_member m
              WHERE m.id = g.granter_member_id AND m.course_id = a.course_id
                AND m.institution_id = a.institution_id AND m.user_id = g.granted_by
                AND m.role = 'teacher' AND m.member_to IS NULL)
            ELSE EXISTS (
              SELECT 1 FROM institution.mentorship ms
              WHERE ms.id = a.mentorship_id AND ms.institution_id = a.institution_id
                AND ms.mentor_id = g.granted_by AND ms.ended_at IS NULL)
          END
  );
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local rollback restores the definition from 20261111221500.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION institution.grant_can(p_action text, p_document_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_scope record;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('read_text', 'comment') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL OR p_document_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT s.institution_id, s.assignment_id, s.principal_id INTO v_scope
  FROM collaboration.document_scope(p_document_id) s;
  IF v_scope.institution_id IS DISTINCT FROM v_institution THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM institution.work_grant g
    JOIN institution.assignment a ON a.id = g.assignment_id AND a.institution_id = g.institution_id
    JOIN institution.institution_role ge ON ge.id = g.grantee_role_id
     AND ge.user_id = g.grantee_id AND ge.institution_id = g.institution_id AND ge.role = 'teacher'
     AND ge.confirmed_at IS NOT NULL AND ge.revoked_at IS NULL
    JOIN institution.institution_role gr ON gr.id = g.granter_role_id
     AND gr.user_id = g.granted_by AND gr.institution_id = g.institution_id AND gr.role = 'teacher'
     AND gr.confirmed_at IS NOT NULL AND gr.revoked_at IS NULL
    WHERE g.institution_id = v_institution
      AND g.grantee_id = v_user
      AND g.assignment_id = v_scope.assignment_id
      AND g.student_id = v_scope.principal_id
      AND g.revoked_at IS NULL
      AND statement_timestamp() >= g.valid_from
      AND statement_timestamp() < g.valid_to
      AND p_action = ANY (g.actions)
      AND CASE
            WHEN a.course_id IS NOT NULL THEN EXISTS (
              SELECT 1 FROM institution.course_member m
              WHERE m.id = g.granter_member_id AND m.course_id = a.course_id
                AND m.institution_id = a.institution_id AND m.user_id = g.granted_by
                AND m.role = 'teacher' AND m.member_to IS NULL)
            ELSE EXISTS (
              SELECT 1 FROM institution.mentorship ms
              WHERE ms.id = a.mentorship_id AND ms.institution_id = a.institution_id
                AND ms.mentor_id = g.granted_by AND ms.ended_at IS NULL)
          END
  );
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
