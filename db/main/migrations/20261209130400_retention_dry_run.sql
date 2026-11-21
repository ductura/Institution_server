-- migrate:up
-- SRV-1304 (plan M10.2 and M10.7, the part without an owner decision): the
-- dry run of the data classes. One read for an administrator of the
-- institution, per class of server/domain/retention, of how many rows a
-- deletion would take. Nothing is deleted, written or locked: both functions
-- are STABLE, so PostgreSQL itself refuses any write inside them.
--
--   app.retention_candidates(p_institution_id)  for ductus_app; the caller's
--       session must be live (ZD401) and belong to p_institution_id, and the
--       caller must be a confirmed, unrevoked administrator there (ZD403). One
--       row per counted class: (class_key, candidates).
--   app.retention_evidence_candidates(p_institution_id)  private to the
--       identity owner: per submitted work its assignment, student and the
--       count of its document revisions and checkpoints other than the
--       submitted one. Never reachable from the application.
--
-- What a candidate is, per class (server/domain/retention/catalog.ts):
--   sessions      a session that ended more than 30 days ago (D-273 MQ08;
--                 the same expression as app.purge_ended_sessions);
--   live-state    the live view row of a work that has been submitted;
--   versions      revisions and full-text checkpoints of a submitted work,
--                 except the submitted revision itself (class 16);
--   change-times  NULL: the time of each change has no storage of its own yet
--                 (class 22 is planned as a separate class);
--   access-log    every row of the access log (the trigger is the access).
-- Hashes and receipts (class 27) are a class that is never deleted and is
-- not counted. Until D-30 is decided, no other class has a period, so the
-- counts are upper bounds: what a deletion with the period ending today would
-- take. Only counts leave the function, never an identifier or a time.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION app.retention_evidence_candidates(p_institution_id uuid)
RETURNS TABLE (assignment_id uuid, principal_id uuid, versions bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.assignment_id, s.principal_id,
         (SELECT pg_catalog.count(*) FROM evidence.document_revision r
           WHERE r.document_id = q.document_id AND r.institution_id = s.institution_id
             AND r.revision <> s.revision)
       + (SELECT pg_catalog.count(*) FROM evidence.document_checkpoint c
           WHERE c.document_id = q.document_id AND c.institution_id = s.institution_id
             AND c.revision <> s.revision)
    FROM evidence.submission s
    JOIN evidence.submission_request q ON q.id = s.submission_request_id
   WHERE s.institution_id = p_institution_id
$$;
REVOKE ALL ON FUNCTION app.retention_evidence_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retention_evidence_candidates(uuid) TO ductus_identity;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;

SET LOCAL ROLE ductus_identity;
CREATE FUNCTION app.retention_candidates(p_institution_id uuid)
RETURNS TABLE (class_key text, candidates bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  -- Only the institution of the session, and only for its administrator.
  IF p_institution_id IS DISTINCT FROM v_actor.institution_id OR NOT EXISTS (
       SELECT 1 FROM institution.institution_role r
        WHERE r.institution_id = v_actor.institution_id AND r.user_id = v_actor.user_id
          AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
  WITH e AS (
    SELECT * FROM app.retention_evidence_candidates(p_institution_id)
  )
  SELECT 'sessions', (
           SELECT pg_catalog.count(*) FROM identity.session s
            WHERE s.institution_id = p_institution_id
              AND LEAST(s.closed_at, s.expires_at, s.last_seen_at + interval '2 hours')
                  < pg_catalog.now() - interval '30 days')
  UNION ALL
  SELECT 'live-state', (
           SELECT pg_catalog.count(*) FROM collaboration.live_state l
            WHERE l.institution_id = p_institution_id
              AND EXISTS (SELECT 1 FROM e WHERE e.assignment_id = l.assignment_id
                                            AND e.principal_id = l.owner_id))
  UNION ALL
  SELECT 'versions', (SELECT coalesce(sum(e.versions), 0)::bigint FROM e)
  UNION ALL
  SELECT 'change-times', NULL::bigint
  UNION ALL
  SELECT 'access-log', (
           SELECT pg_catalog.count(*) FROM audit.access_log a
            WHERE a.institution_id = p_institution_id);
END
$$;
REVOKE ALL ON FUNCTION app.retention_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retention_candidates(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production migrate forward.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.retention_candidates(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.retention_evidence_candidates(uuid);
RESET ROLE;
