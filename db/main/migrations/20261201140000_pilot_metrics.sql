-- migrate:up
-- SRV-1906 (plan P-D6, owner decision 21. 11. 2026.): whole-server technical
-- numbers of the pilot for an operator. Only counts and two durations, never
-- an identifier, a text or a row per person; the route is an operator path
-- (/api/v1/ops, step 8 of the pipeline). Counts end at the start of the
-- current day in Zagreb, so a repeated read does not show single events.
-- A count from 1 to 4 is never returned; nor is any count from which one
-- could be derived by subtraction from the published ones. Shown counts are
-- rounded down to a multiple of five against differencing between days.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_evidence;
-- Raw counts of the submission path before p_before; private to the identity
-- owner, who applies the suppression. recorded = issued + pending exactly.
CREATE FUNCTION app.pilot_evidence_counts(p_before timestamptz)
RETURNS TABLE (not_recorded bigint, recorded bigint, issued bigint, receipt_p50_ms bigint, receipt_p95_ms bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH recorded AS (
    SELECT s.id, s.requested_at FROM evidence.submission s WHERE s.recorded_at < p_before
  ), issued AS (
    SELECT extract(epoch FROM (c.signed_at - r.requested_at)) * 1000 AS ms
      FROM recorded r JOIN evidence.submission_receipt c ON c.submission_id = r.id
     WHERE c.signed_at < p_before
  )
  SELECT (SELECT count(*) FROM evidence.submission_request q
           WHERE q.requested_at < p_before
             AND NOT EXISTS (SELECT 1 FROM evidence.submission s
                              WHERE s.submission_request_id = q.id AND s.recorded_at < p_before)),
         (SELECT count(*) FROM recorded),
         (SELECT count(*) FROM issued),
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::bigint FROM issued),
         (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::bigint FROM issued)
$$;
REVOKE ALL ON FUNCTION app.pilot_evidence_counts(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pilot_evidence_counts(timestamptz) TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_identity;
-- The suppressed numbers before p_before. Private to the owner; the tests call
-- it with a cutoff of their own, the application only through pilot_metrics().
CREATE FUNCTION app.pilot_metrics_at(p_before timestamptz)
RETURNS TABLE (
  as_of timestamptz, submissions_recorded integer, submissions_not_recorded integer,
  receipts_issued integer, receipts_pending integer, help_requests integer,
  save_problem_reports integer, receipt_p50_ms integer, receipt_p95_ms integer
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH e AS (
    SELECT * FROM app.pilot_evidence_counts(p_before)
  ), h AS (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE p.sync_state IN ('ERROR', 'CONFLICT', 'RECOVERY_REQUIRED')) AS save
      FROM identity.problem_report p WHERE p.created_at < p_before
  ), small AS (
    SELECT e.issued BETWEEN 1 AND 4 OR e.recorded - e.issued BETWEEN 1 AND 4 AS receipts,
           h.save BETWEEN 1 AND 4 OR h.total - h.save BETWEEN 1 AND 4 AS save
      FROM e, h
  )
  -- A shown count is rounded down to a multiple of five, so the totals of two
  -- days never differ by a small exact number. Durations are capped at the
  -- integer range and hidden with the receipt partition: a shown duration
  -- would prove five receipts and so reveal a hidden pending count.
  SELECT p_before,
         CASE WHEN e.recorded BETWEEN 1 AND 4 THEN NULL ELSE e.recorded - e.recorded % 5 END::integer,
         CASE WHEN e.not_recorded BETWEEN 1 AND 4 THEN NULL
              ELSE e.not_recorded - e.not_recorded % 5 END::integer,
         CASE WHEN small.receipts THEN NULL ELSE e.issued - e.issued % 5 END::integer,
         CASE WHEN small.receipts THEN NULL
              ELSE (e.recorded - e.issued) - (e.recorded - e.issued) % 5 END::integer,
         CASE WHEN h.total BETWEEN 1 AND 4 THEN NULL ELSE h.total - h.total % 5 END::integer,
         CASE WHEN small.save THEN NULL ELSE h.save - h.save % 5 END::integer,
         CASE WHEN e.issued >= 5 AND NOT small.receipts THEN least(e.receipt_p50_ms, 2147483647) END::integer,
         CASE WHEN e.issued >= 5 AND NOT small.receipts THEN least(e.receipt_p95_ms, 2147483647) END::integer
    FROM e, h, small
$$;
REVOKE ALL ON FUNCTION app.pilot_metrics_at(timestamptz) FROM PUBLIC;

-- The operator's read. Only an operator path calls it (the operator list and
-- the second factor are the server's, step 8); without a session ZD401.
CREATE FUNCTION app.pilot_metrics()
RETURNS TABLE (
  as_of timestamptz, submissions_recorded integer, submissions_not_recorded integer,
  receipts_issued integer, receipts_pending integer, help_requests integer,
  save_problem_reports integer, receipt_p50_ms integer, receipt_p95_ms integer
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
  SELECT * FROM app.pilot_metrics_at(date_trunc('day', statement_timestamp(), 'Europe/Zagreb'));
END
$$;
REVOKE ALL ON FUNCTION app.pilot_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pilot_metrics() TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.pilot_metrics();
DROP FUNCTION app.pilot_metrics_at(timestamptz);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.pilot_evidence_counts(timestamptz);
RESET ROLE;
