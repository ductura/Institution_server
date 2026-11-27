-- SRV-1809 (plan M9.0-S1, D-269 O8; Ductus docs/contracts/evidence-segment-v4.md):
-- the database side of accepting a ductus-evidence-segment-v4 segment that
-- carries AI transfer links. The segment itself is checked by the web process;
-- the database sees its descriptor and the links the event names, checks each
-- link against the record of the transfer, the way checkTransferLinkV1 in
-- server/contracts/evidence-transfer does, and binds every record to at most
-- one segment.
--
-- Nothing live changes. The 9-argument app.commit_evidence_segment and
-- evidence.validate_segment_descriptor_v2 stay as 20261028000000 left them,
-- so a v2 or v3 call behaves byte for byte as before and v4 is still refused
-- there. v4 comes in only through the new 10-argument overload, whose body is
-- the live 9-argument body verbatim but for the hunks the unit test lists
-- (tests/unit/evidence-segment-v4-ingest-migration.test.ts):
--   * the links argument: v4 needs an array (possibly empty), v2 and v3 take
--     NULL or []; at most assistant.ai_transfer_max() links, each exactly
--     {aiTransferId, aiTransferSha256}, a lowercase UUID v4 and 64 hex, ids
--     distinct; anything else is invalid;
--   * the descriptor is validated as v3, whose shape v4's descriptor has;
--     the receipt still names the schema the client sent;
--   * a retry with other links than the first acceptance stored is an
--     idempotency conflict;
--   * a link to no record, to another student's or document's record, with
--     another hash, or to a record already bound is invalid, one answer for
--     all (C7), and nothing is written;
--   * the accepted links go to evidence.segment_ai_transfer with the segment.
-- The web process keeps calling the 9-argument function until its own step.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end. USAGE on assistant
-- stays: the evidence owner calls the one function granted to it there.
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;
GRANT USAGE ON SCHEMA assistant TO ductus_evidence;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;

-- The hash of a transfer record, for the student and document it belongs to;
-- NULL for a missing and a foreign record alike. The evidence owner holds no
-- right on assistant.ai_transfer (274), so this is the one way it sees one.
SET LOCAL ROLE ductus_identity;
CREATE FUNCTION assistant.ai_transfer_link_sha256(
  p_transfer_id uuid, p_institution_id uuid, p_student_id uuid, p_document_id text
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT t.record_sha256 FROM assistant.ai_transfer t
   WHERE t.transfer_id = p_transfer_id AND t.institution_id = p_institution_id
     AND t.student_id = p_student_id AND t.document_id = p_document_id
$$;
REVOKE ALL ON FUNCTION assistant.ai_transfer_link_sha256(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.ai_transfer_link_sha256(uuid, uuid, uuid, text) TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

-- Which AI transfer records a segment's events name. Append-only like the
-- segment; a record is bound to at most one segment. No ductus_app access:
-- written only by the RPC below.
CREATE TABLE evidence.segment_ai_transfer (
  segment_id text NOT NULL,
  evidence_package_id text NOT NULL,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  ai_transfer_id uuid NOT NULL UNIQUE,
  ai_transfer_sha256 text NOT NULL CHECK (ai_transfer_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (segment_id, evidence_package_id, institution_id, principal_id)
    REFERENCES evidence.segment (id, evidence_package_id, institution_id, principal_id)
);
CREATE INDEX segment_ai_transfer_segment_idx
  ON evidence.segment_ai_transfer (segment_id, evidence_package_id, institution_id);
ALTER TABLE evidence.segment_ai_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.segment_ai_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_segment_ai_transfer_owner ON evidence.segment_ai_transfer
  TO ductus_evidence USING (true) WITH CHECK (true);
CREATE TRIGGER segment_ai_transfer_append_only
  BEFORE UPDATE OR DELETE ON evidence.segment_ai_transfer
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER segment_ai_transfer_no_truncate
  BEFORE TRUNCATE ON evidence.segment_ai_transfer
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

CREATE FUNCTION app.commit_evidence_segment(
  p_evidence_package_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_initial_document_hash text,
  p_final_document_hash text,
  p_descriptor jsonb,
  p_payload_sha256 text,
  p_storage_ref text,
  p_snapshot text,
  p_ai_transfer_links jsonb
) RETURNS TABLE (
  outcome text,
  committed_revision bigint,
  receipt_payload text,
  receipt_id uuid,
  signature jsonb,
  current_revision bigint,
  document_hash text,
  head_segment_hash text,
  last_sequence_to bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_package evidence.package%ROWTYPE;
  v_project evidence.project%ROWTYPE;
  v_document evidence.document%ROWTYPE;
  v_assignment record;
  v_existing evidence.receipt%ROWTYPE;
  v_previous_receipt uuid;
  v_new_receipt uuid;
  v_revision bigint;
  v_now timestamptz;
  v_accepted_at text;
  v_descriptor record;
  v_receipt jsonb;
  v_receipt_text text;
  v_sequence_from bigint;
  v_sequence_to bigint;
  v_event_count integer;
  v_payload_bytes integer;
  v_links jsonb;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;

  -- Validate scalar RPC arguments before asking the private descriptor helper.
  IF p_evidence_package_id IS NULL OR p_evidence_package_id !~ '^[a-z0-9][a-z0-9_-]{0,127}$'
     OR p_client_request_id IS NULL
     OR pg_catalog.btrim(p_client_request_id,
          ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) || pg_catalog.chr(12) || pg_catalog.chr(13)
          || pg_catalog.chr(160) || pg_catalog.chr(5760) || pg_catalog.chr(8192) || pg_catalog.chr(8193)
          || pg_catalog.chr(8194) || pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197)
          || pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200) || pg_catalog.chr(8201)
          || pg_catalog.chr(8202) || pg_catalog.chr(8232) || pg_catalog.chr(8233) || pg_catalog.chr(8239)
          || pg_catalog.chr(8287) || pg_catalog.chr(12288) || pg_catalog.chr(65279)) = ''
     OR p_client_request_id ~ '[[:cntrl:]]'
     OR length(p_client_request_id) + (
       SELECT count(*)
       FROM pg_catalog.regexp_split_to_table(p_client_request_id, '') AS codepoint(value)
       WHERE pg_catalog.octet_length(pg_catalog.convert_to(value, 'UTF8')) = 4
     ) > 128
     OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_expected_revision >= 9007199254740991
     OR p_initial_document_hash IS NULL OR p_initial_document_hash !~ '^[0-9a-f]{64}$'
     OR p_final_document_hash IS NULL OR p_final_document_hash !~ '^[0-9a-f]{64}$'
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR p_storage_ref IS NULL OR length(p_storage_ref) NOT BETWEEN 1 AND 2048 OR p_storage_ref ~ '[[:cntrl:]]'
     OR p_snapshot IS NULL OR pg_catalog.octet_length(p_snapshot) NOT BETWEEN 1 AND 2097152 THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  -- The snapshot is the document the segment ends in (4.10 t. 2): its bytes
  -- hash to the final document hash, or nothing is written.
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_snapshot, 'UTF8')), 'hex') <> p_final_document_hash THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  -- v4 (SRV-1809): the AI transfer links the segment's events name. v4 needs
  -- the array, empty when there are none; v2 and v3 carry none. At most
  -- 5000, assistant.ai_transfer_max(), the transfers one document can have.
  IF p_descriptor->>'evidenceSchema' = 'ductus-evidence-segment-v4' THEN
    IF p_ai_transfer_links IS NULL THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
  ELSIF p_ai_transfer_links IS NOT NULL AND p_ai_transfer_links <> '[]'::jsonb THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF p_ai_transfer_links IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_ai_transfer_links) <> 'array' THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    IF pg_catalog.jsonb_array_length(p_ai_transfer_links) > 5000
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link)
          WHERE CASE WHEN pg_catalog.jsonb_typeof(l.link) <> 'object' THEN true
                ELSE (SELECT count(*) FROM pg_catalog.jsonb_object_keys(l.link)) <> 2
                  OR pg_catalog.jsonb_typeof(l.link->'aiTransferId') IS DISTINCT FROM 'string'
                  OR pg_catalog.jsonb_typeof(l.link->'aiTransferSha256') IS DISTINCT FROM 'string'
                  OR l.link->>'aiTransferId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  OR l.link->>'aiTransferSha256' !~ '^[0-9a-f]{64}$' END
       ) THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    -- Normalized and ordered, so a retry compares them by value; NULL if none.
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'aiTransferId', l.link->>'aiTransferId', 'aiTransferSha256', l.link->>'aiTransferSha256')
           ORDER BY l.link->>'aiTransferId')
      INTO v_links FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link);
    IF (SELECT count(DISTINCT l.link->>'aiTransferId') FROM pg_catalog.jsonb_array_elements(p_ai_transfer_links) AS l(link))
       <> pg_catalog.jsonb_array_length(p_ai_transfer_links) THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT * INTO v_descriptor
    -- A v4 descriptor has v3's shape; only the schema name differs.
    FROM evidence.validate_segment_descriptor_v2(
           CASE WHEN p_descriptor->>'evidenceSchema' = 'ductus-evidence-segment-v4'
                THEN pg_catalog.jsonb_set(p_descriptor, '{evidenceSchema}', '"ductus-evidence-segment-v3"')
                ELSE p_descriptor END,
           p_payload_sha256);
  IF NOT FOUND THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  v_sequence_from := v_descriptor.sequence_from;
  v_sequence_to := v_descriptor.sequence_to;
  v_event_count := v_descriptor.event_count;
  v_payload_bytes := v_descriptor.payload_bytes;
  -- The app is authorized for this specific student assignment before any
  -- idempotency lookup. Rows are locked in one fixed order: package,
  -- assignment, membership, document; this serializes concurrent reserves and
  -- holds the authority rows until commit, in the demo through the signature.
  SELECT p.* INTO v_package
    FROM evidence.package p
   WHERE p.id = p_evidence_package_id AND p.institution_id = v_actor.institution_id
     AND p.principal_id = v_actor.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;
  SELECT pr.* INTO v_project
    FROM evidence.project pr
   WHERE pr.id = v_package.project_id AND pr.institution_id = v_package.institution_id;
  IF NOT FOUND OR v_project.principal_id <> v_actor.user_id THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_assignment FROM app.lock_student_assignment(v_project.assignment_id);
  IF NOT FOUND THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;
  IF p_descriptor->>'evidencePackageId' <> v_package.id
     OR p_descriptor->>'documentId' <> v_package.document_id
     OR p_descriptor->>'evidenceProfileId' <> v_package.evidence_profile_id THEN
    outcome := 'context_mismatch'; RETURN NEXT; RETURN;
  END IF;

  SELECT d.* INTO v_document
    FROM evidence.document d
   WHERE d.id = v_package.document_id AND d.institution_id = v_package.institution_id
     AND d.principal_id = v_actor.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;

  -- t. 8: the authoritative idempotency check. A known key writes nothing.
  SELECT r.* INTO v_existing
    FROM evidence.receipt r
   WHERE r.evidence_package_id = v_package.id
     AND r.institution_id = v_package.institution_id
     AND r.principal_id = v_actor.user_id
     AND r.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.descriptor <> p_descriptor THEN
      outcome := 'idempotency_conflict';
    ELSIF (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'aiTransferId', t.ai_transfer_id::text, 'aiTransferSha256', t.ai_transfer_sha256)
                  ORDER BY t.ai_transfer_id::text)
             FROM evidence.segment_ai_transfer t
            WHERE t.segment_id = v_existing.segment_id AND t.evidence_package_id = v_existing.evidence_package_id
              AND t.institution_id = v_existing.institution_id) IS DISTINCT FROM v_links THEN
      outcome := 'idempotency_conflict';
    ELSIF v_existing.payload_sha256 <> p_payload_sha256 OR v_existing.segment_id <> p_descriptor->>'segmentId'
          OR v_existing.evidence_package_id <> p_evidence_package_id THEN
      outcome := 'invalid';
    ELSIF NOT evidence.acceptance_retry_matches(v_existing.id, v_document.id, v_actor.user_id, p_expected_revision, p_initial_document_hash, p_final_document_hash, p_storage_ref) THEN
      outcome := 'idempotency_conflict';
    ELSE
      outcome := CASE v_existing.status WHEN 'signed' THEN 'duplicate_signed' ELSE 'duplicate_pending' END;
      committed_revision := (v_existing.receipt_payload::jsonb->>'revision')::bigint;
      receipt_payload := v_existing.receipt_payload;
      receipt_id := v_existing.id;
      signature := v_existing.signature;
    END IF;
    RETURN NEXT; RETURN;
  END IF;

  -- New acceptance only (ADR 5.3 t. 8, PRODUCT 6 S3): the locked current
  -- version must be acknowledged by the student and open.
  IF NOT v_package.accepts_evidence OR NOT v_assignment.acknowledged
     OR v_assignment.opens_at > pg_catalog.clock_timestamp() THEN
    outcome := 'not_accepting'; RETURN NEXT; RETURN;
  END IF;
  IF v_payload_bytes > v_package.max_payload_bytes THEN
    outcome := 'too_large'; RETURN NEXT; RETURN;
  END IF;
  -- t. 9 to 12, in this order. A sequence going back is never a conflict.
  IF v_document.current_revision <> p_expected_revision THEN
    outcome := 'stale_base';
  ELSIF p_descriptor->>'predecessorSegmentHash' IS DISTINCT FROM v_package.head_segment_hash THEN
    outcome := 'chain_conflict';
  ELSIF v_sequence_from <= v_package.last_sequence_to THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  ELSIF v_sequence_from <> v_package.last_sequence_to + 1
        OR v_document.current_content_hash <> p_initial_document_hash THEN
    outcome := 'not_continuous';
  END IF;
  IF outcome IS NOT NULL THEN
    current_revision := v_document.current_revision;
    document_hash := v_document.current_content_hash;
    head_segment_hash := v_package.head_segment_hash;
    last_sequence_to := v_package.last_sequence_to;
    RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM evidence.segment s
     WHERE s.evidence_package_id = v_package.id AND s.institution_id = v_package.institution_id
       AND s.id = p_descriptor->>'segmentId'
  ) THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  -- Each link names this student's record for this document with its hash,
  -- and a record not yet bound to a segment; one answer otherwise (C7).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(v_links, '[]'::jsonb)) AS l(link)
     WHERE assistant.ai_transfer_link_sha256((l.link->>'aiTransferId')::uuid, v_package.institution_id,
             v_actor.user_id, v_document.id) IS DISTINCT FROM l.link->>'aiTransferSha256'
        OR EXISTS (SELECT 1 FROM evidence.segment_ai_transfer t
                    WHERE t.ai_transfer_id = (l.link->>'aiTransferId')::uuid)
  ) THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  v_revision := v_document.current_revision + 1;
  v_previous_receipt := v_package.head_receipt_id;
  v_new_receipt := gen_random_uuid();
  v_now := clock_timestamp();
  v_accepted_at := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:00.000"Z"');

  -- The document row is locked, so the guarded update always finds it.
  UPDATE evidence.document
     SET current_revision = v_revision, current_content_hash = p_final_document_hash
   WHERE id = v_document.id AND institution_id = v_document.institution_id
     AND current_revision = p_expected_revision AND current_content_hash = p_initial_document_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence document changed under its lock' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO evidence.document_revision (
    document_id, institution_id, revision, base_revision, principal_id, content_hash, created_at
  ) VALUES (
    v_document.id, v_document.institution_id, v_revision, p_expected_revision,
    v_actor.user_id, p_final_document_hash, v_now
  );
  -- The checkpoint's own key ties its hash to this revision (20261019150000).
  INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
  VALUES (v_document.id, v_document.institution_id, v_revision, p_snapshot);

  INSERT INTO evidence.segment (
    id, evidence_package_id, institution_id, document_id, principal_id, session_id,
    sequence_from, sequence_to, event_count, descriptor, segment_hash, payload_bytes,
    storage_ref, accepted_at
  ) VALUES (
    p_descriptor->>'segmentId', v_package.id, v_package.institution_id, v_document.id,
    v_actor.user_id, p_descriptor->>'sessionId', v_sequence_from, v_sequence_to,
    v_event_count, p_descriptor, p_payload_sha256, v_payload_bytes, p_storage_ref, v_now
  );
  INSERT INTO evidence.segment_ai_transfer (
    segment_id, evidence_package_id, institution_id, principal_id, ai_transfer_id, ai_transfer_sha256
  )
  SELECT p_descriptor->>'segmentId', v_package.id, v_package.institution_id, v_actor.user_id,
         (l.link->>'aiTransferId')::uuid, l.link->>'aiTransferSha256'
    FROM pg_catalog.jsonb_array_elements(COALESCE(v_links, '[]'::jsonb)) AS l(link);

  v_receipt := pg_catalog.jsonb_build_object(
    'receiptSchema', 'ductus-evidence-receipt-v2',
    'receiptId', v_new_receipt::text,
    'evidencePackageId', v_package.id,
    'documentId', v_document.id,
    'sessionId', p_descriptor->>'sessionId',
    'segmentId', p_descriptor->>'segmentId',
    'segmentHash', p_payload_sha256,
    'predecessorSegmentHash', v_package.head_segment_hash,
    'previousReceiptId', v_previous_receipt::text,
    'evidenceSchema', p_descriptor->>'evidenceSchema',
    'evidenceProfileId', v_package.evidence_profile_id,
    'sequenceFrom', v_sequence_from,
    'sequenceTo', v_sequence_to,
    'eventCount', v_event_count,
    'payloadBytes', v_payload_bytes,
    'acceptedAt', v_accepted_at,
    'revision', v_revision,
    'clientTransactionId', p_client_request_id,
    'evidenceDomainId', v_package.evidence_domain_id::text,
    'principalId', v_actor.user_id::text
  );
  v_receipt_text := evidence.canonical_receipt_v2(v_receipt);

  INSERT INTO evidence.receipt (
    id, evidence_package_id, institution_id, evidence_domain_id, segment_id, principal_id,
    client_request_id, previous_receipt_id, payload_sha256, descriptor, receipt_payload, status
  ) VALUES (
    v_new_receipt, v_package.id, v_package.institution_id, v_package.evidence_domain_id,
    p_descriptor->>'segmentId', v_actor.user_id, p_client_request_id, v_previous_receipt,
    p_payload_sha256, p_descriptor, v_receipt_text, 'pending_signature'
  );

  UPDATE evidence.package
     SET head_segment_hash = p_payload_sha256,
         head_receipt_id = v_new_receipt,
         last_sequence_to = v_sequence_to
   WHERE id = v_package.id AND institution_id = v_package.institution_id;

  outcome := 'reserved';
  committed_revision := v_revision;
  receipt_payload := v_receipt_text;
  receipt_id := v_new_receipt;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb);
DROP TABLE evidence.segment_ai_transfer;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.ai_transfer_link_sha256(uuid, uuid, uuid, text);
SET LOCAL ROLE ductus_migrator;
REVOKE USAGE ON SCHEMA assistant FROM ductus_evidence;
