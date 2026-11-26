-- F4-PM2-R02 (plan M3.3, B-12): the two reads the worker's reconstruction loop
-- needs to write the checkpoints of SRV-1503 on its own
-- (server/worker/reconstruction/). Both run for the evidence domain the worker
-- is configured for, are read-only, and give no person: identity and
-- institution come from the package, never from a parameter, and nothing here
-- is a text of a student's work (D-71, D-74, D-102).
--
-- * app.worker_packages_due_checkpoints lists packages whose chain is at least
--   one interval long and still lacks the checkpoint at its newest due
--   revision, by package id, one page at a time after a cursor (so a package
--   that never reproduces cannot starve the ones behind it);
-- * app.worker_package_chain gives the accepted segments of one package in
--   chain order with their hashes, the head the package recorded and the
--   document it started from (revision 0). The segment bytes are read from
--   the payload store and verified against that head by the caller.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- One row per package of the domain with at least p_interval accepted
-- segments and no checkpoint at (segments / interval) * interval, the newest
-- revision due. An unknown or foreign domain gives no row.
CREATE FUNCTION app.worker_packages_due_checkpoints(
  p_evidence_domain_id uuid, p_interval integer, p_after_package_id text, p_limit integer)
RETURNS TABLE (evidence_package_id text, institution_id uuid, segment_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_evidence_domain_id IS NULL
     OR p_interval IS NULL OR p_interval NOT BETWEEN 1 AND 100000
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
     OR (p_after_package_id IS NOT NULL AND p_after_package_id !~ '^[a-z0-9][a-z0-9_-]{0,127}$') THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.id, p.institution_id, s.n
      FROM evidence.package p
      CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*) AS n FROM evidence.segment g
         WHERE g.evidence_package_id = p.id AND g.institution_id = p.institution_id) s
     WHERE p.evidence_domain_id = p_evidence_domain_id
       AND p.head_segment_hash IS NOT NULL
       AND (p_after_package_id IS NULL OR p.id > p_after_package_id)
       AND s.n >= p_interval
       AND NOT EXISTS (
         SELECT 1 FROM evidence.reconstruction_checkpoint c
          WHERE c.evidence_package_id = p.id AND c.institution_id = p.institution_id
            AND c.revision = (s.n / p_interval) * p_interval)
     ORDER BY p.id
     LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION app.worker_packages_due_checkpoints(uuid, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_packages_due_checkpoints(uuid, integer, text, integer) TO ductus_worker;

-- The accepted chain of one package of the domain, first accepted first. The
-- head and the starting document repeat on every row (the latter is the
-- revision 0 text, a few hundred bytes); NULL when the package has none
-- stored. An unknown package or one of another domain gives no row, so the
-- answer never tells them apart.
CREATE FUNCTION app.worker_package_chain(p_evidence_domain_id uuid, p_evidence_package_id text)
RETURNS TABLE (chain_position bigint, segment_hash text, head_segment_hash text, initial_document text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_evidence_domain_id IS NULL OR p_evidence_package_id IS NULL
     OR p_evidence_package_id !~ '^[a-z0-9][a-z0-9_-]{0,127}$' THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT pg_catalog.row_number() OVER (ORDER BY g.sequence_from)::bigint,
           g.segment_hash, p.head_segment_hash,
           (SELECT d.body FROM evidence.document_checkpoint d
             WHERE d.document_id = p.document_id AND d.institution_id = p.institution_id AND d.revision = 0
               AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.body, 'UTF8')), 'hex') = d.content_hash)
      FROM evidence.package p
      JOIN evidence.segment g ON g.evidence_package_id = p.id AND g.institution_id = p.institution_id
     WHERE p.id = p_evidence_package_id AND p.evidence_domain_id = p_evidence_domain_id
     ORDER BY g.sequence_from;
END
$$;
REVOKE ALL ON FUNCTION app.worker_package_chain(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_package_chain(uuid, text) TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.worker_package_chain(uuid, text);
DROP FUNCTION app.worker_packages_due_checkpoints(uuid, integer, text, integer);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
