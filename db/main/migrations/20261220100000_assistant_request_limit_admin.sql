-- migrate:up
-- SRV-ASIST-LIMIT-ADMIN (Ductus#2055, approved 25. 11.): the administrator of
-- an institution reads and sets the daily number of assistant requests per
-- student and assignment of the own institution, the same value the operator
-- sets with assistant.publish_request_limit (20261219450000). Only a confirmed
-- administrator (ZD403 for everyone else); every change is a new configuration
-- version with its trail row (audit.assistant_cost_config_event). No new codes.
--
--   assistant.read_request_limit()  {version_no, request_limit} of the latest
--         version of the own institution; 0 and NULL when none is published
--   assistant.set_request_limit(expected, requests)  NULL removes the limit; the
--         other values stay. A stale expected is ZD409; a retry of the same
--         change by the same administrator returns its version and writes nothing.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;

SET LOCAL ROLE ductus_identity;

CREATE FUNCTION assistant.read_request_limit() RETURNS TABLE (version_no integer, request_limit integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT coalesce(max(c.version_no), 0)::integer,
           (SELECT l.student_assignment_day_requests FROM assistant.cost_config_version l
             WHERE l.institution_id = actor.institution_id ORDER BY l.version_no DESC LIMIT 1)
      FROM assistant.cost_config_version c WHERE c.institution_id = actor.institution_id;
END
$$;

CREATE FUNCTION assistant.set_request_limit(p_expected_version integer, p_requests integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v assistant.cost_config_version;
  v_current integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_requests <= 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v := assistant.latest_config(actor.institution_id);
  v_current := coalesce(v.version_no, 0);
  IF p_expected_version <> v_current THEN
    IF p_expected_version = v_current - 1 AND v.published_by = actor.user_id
       AND v.student_assignment_day_requests IS NOT DISTINCT FROM p_requests THEN
      RETURN v_current;
    END IF;
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN assistant.write_config_version_requests(actor.institution_id, v_current, v.cap_micro,
    coalesce(v.cap_period, 'day'), v.student_day_micro, v.student_assignment_day_micro, v.reserve_micro,
    p_requests, actor.user_id, NULL);
END
$$;

REVOKE ALL ON FUNCTION assistant.read_request_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.set_request_limit(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.read_request_limit() TO ductus_app;
GRANT EXECUTE ON FUNCTION assistant.set_request_limit(integer, integer) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;

-- migrate:down

SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.set_request_limit(integer, integer);
DROP FUNCTION assistant.read_request_limit();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
