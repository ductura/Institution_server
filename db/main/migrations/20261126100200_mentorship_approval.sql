-- migrate:up
-- SRV-1407 (Plan M2, D-204): a mentorship comes into being only when the
-- teacher a student asked approves the request. The transitions
-- requested -> approved | declined | withdrawn already exist
-- (20261104090000, 20261120120000, 20261121090000); what the per-request
-- routes of SRV-1407 still need is an approval that is idempotent end to end.
--
--   app.approve_mentorship_request_once  the teacher the request was made to
--                       approves it as app.approve_mentorship_request_with_work
--                       does: the mentorship, its assignment and the first
--                       version in one transaction. Approving a request that
--                       this teacher already approved returns the same
--                       mentorship and writes nothing, also when the two
--                       approvals race: the later one waits on the request
--                       lock, its own attempt rolls back to the savepoint and
--                       it reads the committed approval.
--
-- The checks of the wrapped function stay in force: ZD401 no session, ZD403
-- not allowed (another teacher, another institution, a student, the
-- administrator, a revoked teacher role or an unknown request), ZD409 the
-- request is withdrawn or declined or the student already has an open
-- mentorship of the kind, ZD503 the faculty rule for the kind of work is
-- missing. Errors carry no input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.approve_mentorship_request_once(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_mentorship uuid;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  BEGIN
    RETURN app.approve_mentorship_request_with_work(p_request_id);
  EXCEPTION WHEN SQLSTATE 'ZD409' THEN
    -- The wrapped function reaches ZD409 for an approved request only after
    -- institution.approve_mentorship_request has checked the caller and the
    -- teacher role, so an approval found here is the caller's own.
    SELECT r.mentorship_id INTO v_mentorship FROM institution.mentorship_request r
    WHERE r.id = p_request_id AND r.institution_id = actor.institution_id AND r.teacher_id = actor.user_id
      AND r.approved_at IS NOT NULL;
    IF v_mentorship IS NULL THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    RETURN v_mentorship;
  END;
END
$$;

REVOKE ALL ON FUNCTION app.approve_mentorship_request_once(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_mentorship_request_once(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.approve_mentorship_request_once(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
