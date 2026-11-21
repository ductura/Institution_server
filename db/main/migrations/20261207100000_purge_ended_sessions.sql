-- migrate:up
-- SRV-1303 (M10.0-S2; D-273 MQ08, MQ14): the first scheduled job of the
-- worker removes ended sessions. One definer function, executable by the
-- retention role alone:
--
--   app.purge_ended_sessions(p_before)  deletes every identity.session row
--                                       that ended before p_before and returns
--                                       how many it deleted
--
-- A session ends at the earliest of three moments, the same expression as
-- identity.purge_ended_sessions() and identity.session_state(): its close
-- (logout, logout_all, backchannel_logout and the other reasons), its
-- absolute expiry (expires_at) and two hours without activity. A session for
-- which none of them is before p_before stays, open or not.
--
-- The cut is the caller's (the schedule derives it from the slot it runs), so
-- a repeat of one slot deletes nothing more: what ended before the cut is
-- already gone, and nothing can end in the past. The 30 days of D-200 P2 hold
-- here too: a cut later than now() - 30 days is refused (ZD422), so no caller
-- removes a session that ended within the retention time. A NULL or infinite
-- cut is refused the same way. Errors carry no input.
--
-- identity.purge_ended_sessions() (20261101200000) stays as it is; nothing
-- schedules it. Only identity.session is touched: accounts, institutions,
-- evidence, submissions and the audit trail are not, and no table refers to a
-- session row (024-session-idle.sql). The function returns the count alone,
-- never a token, an id or a time.
--
-- The owner is ductus_identity, the owner of identity.session. The retention
-- role already has USAGE on schema app (20261125100000_erasure_tombstone.sql)
-- and gets EXECUTE on this function, nothing else.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION app.purge_ended_sessions(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_before IS NULL OR NOT pg_catalog.isfinite(p_before)
     OR p_before > pg_catalog.now() - interval '30 days' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  WITH gone AS (
    DELETE FROM identity.session s
    WHERE LEAST(s.closed_at, s.expires_at, s.last_seen_at + interval '2 hours') < p_before
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM gone;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION app.purge_ended_sessions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_ended_sessions(timestamptz) TO ductus_retention;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.purge_ended_sessions(timestamptz);
