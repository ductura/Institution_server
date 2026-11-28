-- F4-EDI-R05-SRV (B1): the record that a revision was committed on purpose
-- over a conflict, keeping the local text. When the client resolves a
-- stale_base by committing its own text on top of the current revision, it
-- says so with the commit: {kind: "keep_local", conflictBaseRevision: M},
-- where M is the revision its local text was written on. The database keeps
-- that statement with the revision it belongs to, append only, so the replay
-- can show the resolution where it happened instead of an unexplained jump.
--
-- Nothing live changes. The 10-argument app.commit_evidence_segment stays as
-- 20261220490000 left it. A new 11-argument overload is a thin wrapper:
--   * the resolution is NULL, or exactly {kind: "keep_local",
--     conflictBaseRevision: M} with M an integer, 0 <= M <= the expected
--     revision; anything else is invalid and nothing is written;
--   * it calls the 10-argument function and passes every answer through, with
--     the resolution as an eleventh column;
--   * on reserved with a resolution it stores the row for the new revision;
--     the inner call and the row are one savepoint, so a row that cannot be
--     written undoes the commit and answers invalid;
--   * on a retry (duplicate_signed, duplicate_pending) the stored resolution
--     must equal the one sent, absence included, or the answer is an
--     idempotency conflict.
-- The read: app.read_replay_resolutions gives the replay the resolutions of
-- a document's segments, with the readers, the logging and the submission cut
-- of app.read_replay_source (20261028121000).
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;
GRANT CREATE ON SCHEMA app TO ductus_identity;

SET LOCAL ROLE ductus_evidence;

-- One row per revision committed over a conflict. Append only; no access but
-- the owner's: written only by the RPC below, read only through the replay.
CREATE TABLE evidence.revision_resolution (
  receipt_id uuid PRIMARY KEY,
  evidence_package_id text NOT NULL,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  document_id text NOT NULL,
  revision bigint NOT NULL,
  conflict_base_revision bigint NOT NULL,
  kind text NOT NULL CHECK (kind = 'keep_local'),
  created_at timestamptz NOT NULL,
  CHECK (0 <= conflict_base_revision AND conflict_base_revision < revision),
  UNIQUE (document_id, institution_id, revision),
  FOREIGN KEY (receipt_id, evidence_package_id, institution_id)
    REFERENCES evidence.receipt (id, evidence_package_id, institution_id),
  FOREIGN KEY (document_id, institution_id, revision)
    REFERENCES evidence.document_revision (document_id, institution_id, revision),
  FOREIGN KEY (document_id, institution_id, conflict_base_revision)
    REFERENCES evidence.document_revision (document_id, institution_id, revision)
);
ALTER TABLE evidence.revision_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.revision_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_revision_resolution_owner ON evidence.revision_resolution
  TO ductus_evidence USING (true) WITH CHECK (true);
CREATE TRIGGER revision_resolution_append_only
  BEFORE UPDATE OR DELETE ON evidence.revision_resolution
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER revision_resolution_no_truncate
  BEFORE TRUNCATE ON evidence.revision_resolution
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- The 10-argument acceptance plus the resolution. No defaults: the web
-- process names the overload it calls.
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

-- The resolutions of the caller's institution's segments of this document
-- whose hashes are given, one row per segment. The institution comes from the
-- session; the caller has already checked that the actor may read the
-- document and passes the hashes of the record up to its cut.
CREATE FUNCTION app.replay_resolution_marks(p_document_id text, p_segment_hashes text[])
RETURNS TABLE (segment_hash text, conflict_base_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.payload_sha256, x.conflict_base_revision
    FROM app.current_actor() a
    JOIN evidence.revision_resolution x ON x.institution_id = a.institution_id
    JOIN evidence.receipt r
      ON r.id = x.receipt_id AND r.evidence_package_id = x.evidence_package_id
     AND r.institution_id = x.institution_id
   WHERE x.document_id = p_document_id
     AND r.payload_sha256 = ANY (p_segment_hashes)
   ORDER BY x.revision
$$;
REVOKE ALL ON FUNCTION app.replay_resolution_marks(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.replay_resolution_marks(text, text[]) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- ZD401 without an open session. A caller who may not read the document, a
-- malformed id, a missing document and a record that is not exactly one
-- package get no rows. A teacher's read is logged as replay, as
-- app.read_replay_source; the owning student's is not. Only segments up to
-- the cut of app.process_summary_record are answered.
CREATE FUNCTION app.read_replay_resolutions(p_document_id text)
RETURNS TABLE (segment_hash text, conflict_base_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
  v_role text;
  v_record record;
  v_hashes text[];
  v_packages integer := 0;
BEGIN
  -- The session first, before the input: no session is ZD401 whatever is asked.
  PERFORM institution.require_actor();
  IF p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]' OR p_document_id <> pg_catalog.btrim(p_document_id) THEN
    RETURN;
  END IF;
  SELECT * INTO v_scope FROM collaboration.document_scope(p_document_id);
  v_role := collaboration.actor_role(v_scope.institution_id, v_scope.assignment_id, v_scope.principal_id);
  IF v_scope.institution_id IS NULL OR v_role IS NULL THEN
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    PERFORM audit.record_work_opening(v_scope.institution_id, p_document_id, v_scope.assignment_id,
                                      v_scope.principal_id, 'replay');
  END IF;
  FOR v_record IN SELECT r.segment_hashes FROM app.process_summary_record(p_document_id) r LOOP
    v_packages := v_packages + 1;
    v_hashes := v_record.segment_hashes;
  END LOOP;
  IF v_packages <> 1 OR v_hashes IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT m.segment_hash, m.conflict_base_revision
                 FROM app.replay_resolution_marks(p_document_id, v_hashes) m;
END
$$;
REVOKE ALL ON FUNCTION app.read_replay_resolutions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_replay_resolutions(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.read_replay_resolutions(text);
RESET ROLE;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.replay_resolution_marks(text, text[]);
DROP FUNCTION app.commit_evidence_segment(text, text, bigint, text, text, jsonb, text, text, text, jsonb, jsonb);
DROP TABLE evidence.revision_resolution;
RESET ROLE;
