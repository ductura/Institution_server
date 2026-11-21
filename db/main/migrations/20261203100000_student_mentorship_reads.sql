-- migrate:up
-- SRV-1414 (Plan M2, D-204; supplement to SRV-1407): the two reads of the
-- student's side of mentorship. No table changes; the web role cannot read
-- the names (identity.person_name) or the institution's teacher roles
-- (institution.institution_role, administrator only), so both reads are
-- functions of the owner that decide who may and what comes back.
--
--   app.student_mentorship_requests  the caller's own requests, in every
--                       state, with the teacher's name pair and the instant of
--                       the one end, if any. Never the decline reason (P-6).
--   app.student_mentor_candidates    the confirmed, unrevoked teachers of the
--                       caller's institution, other than the caller: the
--                       accounts institution.request_mentorship accepts. Only
--                       the account and the name pair: no address, no
--                       identifier from AAI@EduHr, no login time.
--
-- A caller with a confirmed, unrevoked teacher role is refused (ZD403): both
-- are reads of the student's side. ZD401 without a session. Errors carry no
-- input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.student_mentorship_requests()
RETURNS TABLE (
  request_id uuid, teacher_id uuid, given_name text, family_name text, work_type text,
  state text, requested_at timestamptz, ended_at timestamptz, mentorship_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_has_role('teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  SELECT r.id, r.teacher_id, n.given_name, n.family_name, r.work_type,
         CASE
           WHEN r.approved_at IS NOT NULL THEN 'approved'
           WHEN r.declined_at IS NOT NULL THEN 'declined'
           WHEN r.withdrawn_at IS NOT NULL THEN 'withdrawn'
           ELSE 'requested'
         END,
         r.requested_at, coalesce(r.approved_at, r.declined_at, r.withdrawn_at), r.mentorship_id
  FROM institution.mentorship_request r
  LEFT JOIN identity.person_name n ON n.institution_id = r.institution_id AND n.user_id = r.teacher_id
  WHERE r.institution_id = actor.institution_id AND r.student_id = actor.user_id
  ORDER BY r.requested_at DESC, r.id;
END
$$;

CREATE FUNCTION app.student_mentor_candidates()
RETURNS TABLE (teacher_id uuid, given_name text, family_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_has_role('teacher') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- The same conditions as institution.lock_teacher_role, which
  -- request_mentorship checks: a confirmed, unrevoked teacher role here.
  RETURN QUERY
  SELECT u.id, n.given_name, n.family_name
  FROM identity.user_account u
  LEFT JOIN identity.person_name n ON n.institution_id = u.institution_id AND n.user_id = u.id
  WHERE u.institution_id = actor.institution_id AND u.id <> actor.user_id
    AND EXISTS (
      SELECT 1 FROM institution.institution_role r
      WHERE r.institution_id = u.institution_id AND r.user_id = u.id AND r.role = 'teacher'
        AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
    )
  ORDER BY n.family_name NULLS LAST, n.given_name NULLS LAST, u.id;
END
$$;

REVOKE ALL ON FUNCTION app.student_mentorship_requests(), app.student_mentor_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_mentorship_requests(), app.student_mentor_candidates() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.student_mentor_candidates();
DROP FUNCTION app.student_mentorship_requests();
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
