-- migrate:up
-- F4-PM2-R01 (Ductus#2059). Additive, no breaking change: the submission route
-- stays synchronous and keeps its contract. After a submission is recorded the
-- worker reconstructs the submitted revision once more and keeps the verdict,
-- and the student reads it back at a route of its own.
--
--   evidence.submission_reconstruction      the verdict per submission, only
--                   appended (verified or mismatch); forced RLS with the
--                   owner's policy alone, no privilege for any other role
--   app.worker_submissions_to_reconstruct   ductus_worker: ids of the submissions
--                   of its own evidence domain that have no verdict yet
--   app.worker_submission_record            ductus_worker: the record of one
--                   submission, as app.read_submission_record gives it for a
--                   request, plus the kind of the work
--   app.worker_record_submission_reconstruction  ductus_worker: keeps the verdict;
--                   the database compares the hash the worker reconstructed
--                   with the one the submission was recorded with, the worker
--                   never says verified itself
--   app.my_submission_reconstruction        ductus_app: the student's own
--                   submission of an assignment; another person's, an unknown
--                   assignment and one without a submission read not_found
--
-- The domain is the worker's configuration, never a request field of a client.
-- Errors carry no input: ZD401 no session, 22023 an invalid worker request.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- The key the verdict's foreign key carries the institution with.
ALTER TABLE evidence.submission ADD CONSTRAINT evidence_submission_id_institution_key UNIQUE (id, institution_id);

CREATE TABLE evidence.submission_reconstruction (
  submission_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('verified', 'mismatch')),
  checked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (submission_id, institution_id) REFERENCES evidence.submission (id, institution_id)
);
CREATE TRIGGER submission_reconstruction_immutable BEFORE UPDATE OR DELETE ON evidence.submission_reconstruction
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER submission_reconstruction_no_truncate BEFORE TRUNCATE ON evidence.submission_reconstruction
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.submission_reconstruction ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_reconstruction FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_submission_reconstruction_owner ON evidence.submission_reconstruction
  TO ductus_evidence USING (true) WITH CHECK (true);

-- Oldest submission first; 1 to 1000 ids per call.
CREATE FUNCTION app.worker_submissions_to_reconstruct(p_evidence_domain_id uuid, p_limit integer)
RETURNS TABLE (submission_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_evidence_domain_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT s.id
      FROM evidence.submission s
      JOIN evidence.submission_request q ON q.id = s.submission_request_id
      JOIN evidence.package k
        ON k.document_id = q.document_id AND k.institution_id = q.institution_id AND k.principal_id = q.principal_id
     WHERE k.evidence_domain_id = p_evidence_domain_id
       AND NOT EXISTS (SELECT 1 FROM evidence.submission_reconstruction r WHERE r.submission_id = s.id)
     ORDER BY s.recorded_at, s.id
     LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION app.worker_submissions_to_reconstruct(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_submissions_to_reconstruct(uuid, integer) TO ductus_worker;

-- Outcomes: found, not_found (no such submission in this domain), unavailable
-- (no package or more than one, or no receipt names the submitted revision).
-- The record is cut at the submitted revision exactly as in
-- app.read_submission_record (20261020120000).
CREATE FUNCTION app.worker_submission_record(p_evidence_domain_id uuid, p_submission_id uuid)
RETURNS TABLE (
  outcome text, institution_id uuid, evidence_package_id text, evidence_domain_id uuid, document_id text,
  principal_id uuid, revision bigint, content_hash text, head_segment_hash text, segment_count integer,
  segments jsonb, document_kind text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_request evidence.submission_request%ROWTYPE;
  v_package evidence.package%ROWTYPE;
  v_packages integer;
  v_head record;
BEGIN
  IF p_evidence_domain_id IS NULL OR p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  SELECT q.* INTO v_request
    FROM evidence.submission s JOIN evidence.submission_request q ON q.id = s.submission_request_id
   WHERE s.id = p_submission_id;
  SELECT pg_catalog.count(*)::integer INTO v_packages
    FROM evidence.package k
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id;
  SELECT k.* INTO v_package
    FROM evidence.package k
   WHERE k.document_id = v_request.document_id AND k.institution_id = v_request.institution_id
     AND k.principal_id = v_request.principal_id AND k.evidence_domain_id = p_evidence_domain_id;
  IF v_request.id IS NULL OR v_package.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::uuid,
      NULL::bigint, NULL::text, NULL::text, NULL::integer, NULL::jsonb, NULL::text;
    RETURN;
  END IF;
  SELECT s.segment_hash, s.sequence_from INTO v_head
    FROM evidence.segment s
    JOIN evidence.receipt r
      ON r.segment_id = s.id AND r.evidence_package_id = s.evidence_package_id AND r.institution_id = s.institution_id
   WHERE s.evidence_package_id = v_package.id AND s.institution_id = v_package.institution_id
     AND pg_catalog.jsonb_typeof(r.receipt_payload::jsonb -> 'revision') = 'number'
     AND (r.receipt_payload::jsonb ->> 'revision')::numeric = v_request.revision
   ORDER BY s.sequence_from DESC
   LIMIT 1;
  IF v_packages <> 1 OR v_head.segment_hash IS NULL THEN
    RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::uuid,
      NULL::bigint, NULL::text, NULL::text, NULL::integer, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'found'::text, v_package.institution_id, v_package.id, v_package.evidence_domain_id, v_request.document_id,
         v_request.principal_id, v_request.revision, v_request.content_hash, v_head.segment_hash,
         pg_catalog.count(*)::integer,
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'segmentHash', s.segment_hash, 'receiptPayload', r.receipt_payload, 'signature', r.signature)
           ORDER BY s.sequence_from),
         (SELECT d.document_kind FROM evidence.document d
           WHERE d.id = v_request.document_id AND d.institution_id = v_request.institution_id)
    FROM evidence.segment s
    JOIN evidence.receipt r
      ON r.segment_id = s.id AND r.evidence_package_id = s.evidence_package_id AND r.institution_id = s.institution_id
   WHERE s.evidence_package_id = v_package.id AND s.institution_id = v_package.institution_id
     AND s.sequence_from <= v_head.sequence_from;
END
$$;
REVOKE ALL ON FUNCTION app.worker_submission_record(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_submission_record(uuid, uuid) TO ductus_worker;

-- p_content_hash is the hash of the document the worker reconstructed, or NULL
-- when the reconstruction did not match the record. Outcomes: verified,
-- mismatch (both are kept; the first verdict stays), exists (a verdict is
-- already kept, nothing is written), not_found (no such submission in this domain).
CREATE FUNCTION app.worker_record_submission_reconstruction(
  p_evidence_domain_id uuid, p_submission_id uuid, p_content_hash text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_artifact text;
  v_institution uuid;
  v_status text;
BEGIN
  IF p_evidence_domain_id IS NULL OR p_submission_id IS NULL
     OR (p_content_hash IS NOT NULL AND p_content_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  SELECT s.artifact_hash, s.institution_id INTO v_artifact, v_institution
    FROM evidence.submission s
    JOIN evidence.submission_request q ON q.id = s.submission_request_id
    JOIN evidence.package k
      ON k.document_id = q.document_id AND k.institution_id = q.institution_id AND k.principal_id = q.principal_id
   WHERE s.id = p_submission_id AND k.evidence_domain_id = p_evidence_domain_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  v_status := CASE WHEN p_content_hash IS NOT DISTINCT FROM v_artifact THEN 'verified' ELSE 'mismatch' END;
  INSERT INTO evidence.submission_reconstruction (submission_id, institution_id, status)
  VALUES (p_submission_id, v_institution, v_status)
  ON CONFLICT (submission_id) DO NOTHING;
  RETURN CASE WHEN FOUND THEN v_status ELSE 'exists' END;
END
$$;
REVOKE ALL ON FUNCTION app.worker_record_submission_reconstruction(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_record_submission_reconstruction(uuid, uuid, text) TO ductus_worker;

-- The student's own submission of the assignment (C-23: from the relation, not
-- the role). state is pending until the worker keeps a verdict.
CREATE FUNCTION app.my_submission_reconstruction(p_assignment_id uuid)
RETURNS TABLE (outcome text, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
  v_state text;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF p_assignment_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  SELECT COALESCE(r.status, 'pending') INTO v_state
    FROM evidence.submission s
    LEFT JOIN evidence.submission_reconstruction r ON r.submission_id = s.id
   WHERE s.assignment_id = p_assignment_id AND s.institution_id = v_actor.institution_id
     AND s.principal_id = v_actor.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text, v_state;
END
$$;
REVOKE ALL ON FUNCTION app.my_submission_reconstruction(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_submission_reconstruction(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.my_submission_reconstruction(uuid);
DROP FUNCTION app.worker_record_submission_reconstruction(uuid, uuid, text);
DROP FUNCTION app.worker_submission_record(uuid, uuid);
DROP FUNCTION app.worker_submissions_to_reconstruct(uuid, integer);
DROP TABLE evidence.submission_reconstruction;
ALTER TABLE evidence.submission DROP CONSTRAINT evidence_submission_id_institution_key;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;
