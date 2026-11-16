-- DAN-827 (S-1D-a; contract on Ductus#1836, c.6914672657): the state of a
-- session, derived from the existing columns of identity.session. No table
-- and no column is added.
--
-- The earliest of three moments decides, the same expression as
-- purge_ended_sessions: closed_at, expires_at and last_seen_at + 2 hours (the
-- idle limit of app.current_actor and the session limit). None has passed:
-- active. A close at the same moment as expiry or idleness wins, as it names
-- its reason.
--   ended        logout, logout_all, backchannel_logout; expired (absolute)
--   interrupted  idle; institution_changed, issuer_removed, operator, superseded
-- "in_progress" (login started, session not yet issued) is defined in
-- server/session/state.ts and never returned here: the login state lives in a
-- cookie and no column records it.
--
-- Only the review roles read it, for sessions of the caller's own
-- institution: a confirmed administrator or an appointed network engineer.
-- Without a session: ZD401; any other account: ZD403; a session of another
-- institution or no session at all: no row, so the answer is no oracle.
-- app_admin has no link to an account yet (V-7) and is not among them.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION identity.session_state(p_session_id uuid)
RETURNS TABLE (state text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT (institution.actor_has_role('admin') OR EXISTS (
      SELECT 1 FROM identity.network_engineer_appointment n
       WHERE n.user_id = v_user AND n.institution_id = v_institution AND n.revoked_at IS NULL
         AND n.appointed_at <= pg_catalog.now())) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD403';
  END IF;

  RETURN QUERY
  SELECT CASE
           WHEN e.closed THEN
             CASE WHEN s.close_reason IN ('logout', 'logout_all', 'backchannel_logout') THEN 'ended'
                  ELSE 'interrupted' END
           WHEN e.at IS NULL THEN 'active'
           WHEN s.expires_at <= s.last_seen_at + interval '2 hours' THEN 'ended'
           ELSE 'interrupted'
         END,
         CASE
           WHEN e.closed THEN s.close_reason
           WHEN e.at IS NULL THEN NULL
           WHEN s.expires_at <= s.last_seen_at + interval '2 hours' THEN 'expired'
           ELSE 'idle'
         END
    FROM identity.session s
    CROSS JOIN LATERAL (
      SELECT LEAST(s.expires_at, s.last_seen_at + interval '2 hours') AS limit_at
    ) l
    CROSS JOIN LATERAL (
      SELECT s.closed_at IS NOT NULL AND s.closed_at <= l.limit_at AS closed,
             CASE WHEN l.limit_at <= pg_catalog.now() OR s.closed_at IS NOT NULL THEN l.limit_at END AS at
    ) e
   WHERE s.id = p_session_id AND s.institution_id = v_institution;
END
$$;
REVOKE ALL ON FUNCTION identity.session_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.session_state(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down

SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.session_state(uuid);
