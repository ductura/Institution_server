-- migrate:up
-- F4-EDI-R05-SRV: the base of a keep_local resolution lies strictly below the
-- expected revision. The 11-argument app.commit_evidence_segment took a
-- conflictBaseRevision equal to p_expected_revision; the table CHECK
-- (conflict_base_revision < revision) did not catch it, since the committed
-- revision is p_expected_revision + 1. The web process already refuses it
-- (PR #1002); now the database does too: such a resolution answers 'invalid'
-- and writes nothing.
--
-- Unchanged: the signature, the owner (ductus_evidence), SECURITY DEFINER,
-- search_path, the grants and every other answer. Only the one comparison
-- differs from 20261220870000.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION app.commit_evidence_segment(
  p_evidence_package_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_initial_document_hash text,
  p_final_document_hash text,
  p_descriptor jsonb,
  p_payload_sha256 text,
  p_storage_ref text,
  p_snapshot text,
  p_ai_transfer_links jsonb,
  p_resolution jsonb
) RETURNS TABLE (
  outcome text,
  committed_revision bigint,
  receipt_payload text,
  receipt_id uuid,
  signature jsonb,
  current_revision bigint,
  document_hash text,
  head_segment_hash text,
  last_sequence_to bigint,
  resolution jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_base numeric;
  v_wanted jsonb;
  v_stored jsonb;
  v_inner record;
  v_receipt record;
  v_created_at timestamptz;
  v_marking boolean := false;
BEGIN
  -- The session first, as in the 10-argument function.
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;

  -- The resolution: NULL, or exactly {kind, conflictBaseRevision}.
  IF p_resolution IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_resolution) <> 'object'
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_resolution)) <> 2
       OR p_resolution->'kind' IS DISTINCT FROM '"keep_local"'::jsonb
       OR pg_catalog.jsonb_typeof(p_resolution->'conflictBaseRevision') IS DISTINCT FROM 'number'
       OR p_expected_revision IS NULL THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    v_base := (p_resolution->>'conflictBaseRevision')::numeric;
    IF v_base <> pg_catalog.trunc(v_base) OR v_base < 0 OR v_base >= p_expected_revision THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    v_wanted := pg_catalog.jsonb_build_object('kind', 'keep_local', 'conflictBaseRevision', v_base::bigint);
  END IF;

  -- One savepoint for the commit and its resolution. Only an error of the
  -- resolution row is caught; the inner call's own errors (ZD409, ZD422)
  -- propagate unchanged.
  BEGIN
    SELECT * INTO v_inner FROM app.commit_evidence_segment(
      p_evidence_package_id, p_client_request_id, p_expected_revision, p_initial_document_hash,
      p_final_document_hash, p_descriptor, p_payload_sha256, p_storage_ref, p_snapshot, p_ai_transfer_links);

    IF v_inner.outcome = 'reserved' AND v_wanted IS NOT NULL THEN
      v_marking := true;
      SELECT r.id, r.evidence_package_id, r.institution_id, r.principal_id, p.document_id
        INTO STRICT v_receipt
        FROM evidence.receipt r
        JOIN evidence.package p ON p.id = r.evidence_package_id AND p.institution_id = r.institution_id
       WHERE r.id = v_inner.receipt_id;
      SELECT d.created_at INTO STRICT v_created_at
        FROM evidence.document_revision d
       WHERE d.document_id = v_receipt.document_id AND d.institution_id = v_receipt.institution_id
         AND d.revision = v_inner.committed_revision;
      INSERT INTO evidence.revision_resolution (
        receipt_id, evidence_package_id, institution_id, principal_id, document_id,
        revision, conflict_base_revision, kind, created_at
      ) VALUES (
        v_receipt.id, v_receipt.evidence_package_id, v_receipt.institution_id, v_receipt.principal_id,
        v_receipt.document_id, v_inner.committed_revision, (v_wanted->>'conflictBaseRevision')::bigint,
        'keep_local', v_created_at
      );
      v_marking := false;
    END IF;
  EXCEPTION WHEN integrity_constraint_violation OR no_data_found OR too_many_rows THEN
    IF NOT v_marking THEN
      RAISE;
    END IF;
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END;

  IF v_inner.outcome IN ('duplicate_signed', 'duplicate_pending') THEN
    SELECT pg_catalog.jsonb_build_object('kind', x.kind, 'conflictBaseRevision', x.conflict_base_revision)
      INTO v_stored
      FROM evidence.revision_resolution x
     WHERE x.receipt_id = v_inner.receipt_id;
    IF v_stored IS DISTINCT FROM v_wanted THEN
      outcome := 'idempotency_conflict'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  outcome := v_inner.outcome;
  committed_revision := v_inner.committed_revision;
  receipt_payload := v_inner.receipt_payload;
  receipt_id := v_inner.receipt_id;
  signature := v_inner.signature;
  current_revision := v_inner.current_revision;
  document_hash := v_inner.document_hash;
  head_segment_hash := v_inner.head_segment_hash;
  last_sequence_to := v_inner.last_sequence_to;
  resolution := CASE WHEN v_inner.outcome IN ('reserved', 'duplicate_signed', 'duplicate_pending')
                     THEN v_wanted END;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb, jsonb) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The definition of 20261220870000 again.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION app.commit_evidence_segment(
  p_evidence_package_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_initial_document_hash text,
  p_final_document_hash text,
  p_descriptor jsonb,
  p_payload_sha256 text,
  p_storage_ref text,
  p_snapshot text,
  p_ai_transfer_links jsonb,
  p_resolution jsonb
) RETURNS TABLE (
  outcome text,
  committed_revision bigint,
  receipt_payload text,
  receipt_id uuid,
  signature jsonb,
  current_revision bigint,
  document_hash text,
  head_segment_hash text,
  last_sequence_to bigint,
  resolution jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_base numeric;
  v_wanted jsonb;
  v_stored jsonb;
  v_inner record;
  v_receipt record;
  v_created_at timestamptz;
  v_marking boolean := false;
BEGIN
  -- The session first, as in the 10-argument function.
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    outcome := 'unauthorized'; RETURN NEXT; RETURN;
  END IF;

  -- The resolution: NULL, or exactly {kind, conflictBaseRevision}.
  IF p_resolution IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_resolution) <> 'object'
       OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_resolution)) <> 2
       OR p_resolution->'kind' IS DISTINCT FROM '"keep_local"'::jsonb
       OR pg_catalog.jsonb_typeof(p_resolution->'conflictBaseRevision') IS DISTINCT FROM 'number'
       OR p_expected_revision IS NULL THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    v_base := (p_resolution->>'conflictBaseRevision')::numeric;
    IF v_base <> pg_catalog.trunc(v_base) OR v_base < 0 OR v_base > p_expected_revision THEN
      outcome := 'invalid'; RETURN NEXT; RETURN;
    END IF;
    v_wanted := pg_catalog.jsonb_build_object('kind', 'keep_local', 'conflictBaseRevision', v_base::bigint);
  END IF;

  -- One savepoint for the commit and its resolution. Only an error of the
  -- resolution row is caught; the inner call's own errors (ZD409, ZD422)
  -- propagate unchanged.
  BEGIN
    SELECT * INTO v_inner FROM app.commit_evidence_segment(
      p_evidence_package_id, p_client_request_id, p_expected_revision, p_initial_document_hash,
      p_final_document_hash, p_descriptor, p_payload_sha256, p_storage_ref, p_snapshot, p_ai_transfer_links);

    IF v_inner.outcome = 'reserved' AND v_wanted IS NOT NULL THEN
      v_marking := true;
      SELECT r.id, r.evidence_package_id, r.institution_id, r.principal_id, p.document_id
        INTO STRICT v_receipt
        FROM evidence.receipt r
        JOIN evidence.package p ON p.id = r.evidence_package_id AND p.institution_id = r.institution_id
       WHERE r.id = v_inner.receipt_id;
      SELECT d.created_at INTO STRICT v_created_at
        FROM evidence.document_revision d
       WHERE d.document_id = v_receipt.document_id AND d.institution_id = v_receipt.institution_id
         AND d.revision = v_inner.committed_revision;
      INSERT INTO evidence.revision_resolution (
        receipt_id, evidence_package_id, institution_id, principal_id, document_id,
        revision, conflict_base_revision, kind, created_at
      ) VALUES (
        v_receipt.id, v_receipt.evidence_package_id, v_receipt.institution_id, v_receipt.principal_id,
        v_receipt.document_id, v_inner.committed_revision, (v_wanted->>'conflictBaseRevision')::bigint,
        'keep_local', v_created_at
      );
      v_marking := false;
    END IF;
  EXCEPTION WHEN integrity_constraint_violation OR no_data_found OR too_many_rows THEN
    IF NOT v_marking THEN
      RAISE;
    END IF;
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END;

  IF v_inner.outcome IN ('duplicate_signed', 'duplicate_pending') THEN
    SELECT pg_catalog.jsonb_build_object('kind', x.kind, 'conflictBaseRevision', x.conflict_base_revision)
      INTO v_stored
      FROM evidence.revision_resolution x
     WHERE x.receipt_id = v_inner.receipt_id;
    IF v_stored IS DISTINCT FROM v_wanted THEN
      outcome := 'idempotency_conflict'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  outcome := v_inner.outcome;
  committed_revision := v_inner.committed_revision;
  receipt_payload := v_inner.receipt_payload;
  receipt_id := v_inner.receipt_id;
  signature := v_inner.signature;
  current_revision := v_inner.current_revision;
  document_hash := v_inner.document_hash;
  head_segment_hash := v_inner.head_segment_hash;
  last_sequence_to := v_inner.last_sequence_to;
  resolution := CASE WHEN v_inner.outcome IN ('reserved', 'duplicate_signed', 'duplicate_pending')
                     THEN v_wanted END;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb, jsonb) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
