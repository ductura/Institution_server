-- SRV-33B (Ductus#2028, c.7041077037; Ductus docs/contracts/document-schema-v2.md
-- §7 t. 3 and 6): the context before a commit also names the document version
-- of the work, so the route can refuse a snapshot of another version as 422
-- before anything is stored (the checkpoint trigger of 20261120150000 stays
-- the authority). document_schema_version is the schemaVersion (1, 2 or 3) of
-- the work's revision 0 checkpoint, read only when its bytes hash to the
-- content hash recorded for revision 0; otherwise NULL, which the reader
-- treats as a malformed row. Nothing else changes: arguments, outcomes,
-- owner, grants and search_path are those of 20261020140000. The return type
-- changes, so the function is dropped and made again.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

DROP FUNCTION app.evidence_commit_context(text, text);
CREATE FUNCTION app.evidence_commit_context(p_document_id text, p_client_transaction_id text)
RETURNS TABLE (
  outcome text, evidence_package_id text, institution_id uuid, evidence_domain_id uuid, evidence_profile_id text,
  max_payload_bytes integer, transaction_known boolean,
  current_revision bigint, document_hash text, head_segment_hash text, last_sequence_to bigint,
  document_schema_version integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_package evidence.package%ROWTYPE;
  v_document evidence.document%ROWTYPE;
  v_assignment record;
  v_assignment_id uuid;
  v_known boolean;
  v_version integer;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    outcome := 'unauthenticated'; RETURN NEXT; RETURN;
  END IF;
  -- The limits of the columns and of receipt v2: 1 to 256 characters for the
  -- document, 1 to 128 UTF-16 code units for the key, no control characters.
  IF p_document_id IS NULL OR pg_catalog.length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]'
     OR p_client_transaction_id IS NULL OR p_client_transaction_id = '' OR p_client_transaction_id ~ '[[:cntrl:]]'
     OR pg_catalog.length(p_client_transaction_id) + (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.regexp_split_to_table(p_client_transaction_id, '') AS codepoint(value)
        WHERE pg_catalog.octet_length(pg_catalog.convert_to(value, 'UTF8')) = 4
     ) > 128 THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  SELECT d.* INTO v_document FROM evidence.document d
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id AND d.principal_id = v_actor.user_id;
  IF FOUND THEN
    SELECT k.* INTO v_package FROM evidence.package k
     WHERE k.document_id = v_document.id AND k.institution_id = v_document.institution_id
       AND k.principal_id = v_actor.user_id
     ORDER BY k.created_at, k.id
     LIMIT 1;
  END IF;
  IF FOUND THEN
    SELECT p.assignment_id INTO v_assignment_id FROM evidence.project p
     WHERE p.id = v_package.project_id AND p.institution_id = v_package.institution_id
       AND p.principal_id = v_actor.user_id;
    -- Still an active student of the assignment (same check as the acceptance).
    SELECT * INTO v_assignment FROM app.lock_student_assignment(v_assignment_id);
  END IF;
  IF NOT FOUND THEN
    outcome := 'not_found'; RETURN NEXT; RETURN;
  END IF;

  v_known := EXISTS (
    SELECT 1 FROM evidence.receipt r
     WHERE r.evidence_package_id = v_package.id AND r.institution_id = v_package.institution_id
       AND r.principal_id = v_actor.user_id AND r.client_request_id = p_client_transaction_id
  );
  -- The acceptance's condition for a new acceptance (ADR 5.3 t. 8), with its clock.
  IF NOT v_known AND (NOT v_package.accepts_evidence OR NOT v_assignment.acknowledged
                      OR v_assignment.opens_at > pg_catalog.clock_timestamp()) THEN
    outcome := 'not_accepting'; RETURN NEXT; RETURN;
  END IF;

  -- The version of the work is the schemaVersion of its revision 0 (Ductus
  -- document-schema-v2.md §7 t. 3), read from the checkpoint whose bytes are
  -- the hash recorded for revision 0; any other value, or none, is NULL.
  SELECT CASE evidence.document_object(c.body) -> 'schemaVersion'
           WHEN '1'::jsonb THEN 1 WHEN '2'::jsonb THEN 2 WHEN '3'::jsonb THEN 3 END
    INTO v_version
    FROM evidence.document_checkpoint c
    JOIN evidence.document_revision r
      ON r.document_id = c.document_id AND r.institution_id = c.institution_id AND r.revision = 0
   WHERE c.document_id = v_document.id AND c.institution_id = v_document.institution_id AND c.revision = 0
     AND r.content_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex');

  outcome := 'ok';
  evidence_package_id := v_package.id;
  institution_id := v_package.institution_id;
  evidence_domain_id := v_package.evidence_domain_id;
  evidence_profile_id := v_package.evidence_profile_id;
  max_payload_bytes := v_package.max_payload_bytes;
  transaction_known := v_known;
  current_revision := v_document.current_revision;
  document_hash := v_document.current_content_hash;
  head_segment_hash := v_package.head_segment_hash;
  last_sequence_to := v_package.last_sequence_to;
  document_schema_version := v_version;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.evidence_commit_context(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.evidence_commit_context(text, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

DROP FUNCTION app.evidence_commit_context(text, text);
CREATE FUNCTION app.evidence_commit_context(p_document_id text, p_client_transaction_id text)
RETURNS TABLE (
  outcome text, evidence_package_id text, institution_id uuid, evidence_domain_id uuid, evidence_profile_id text,
  max_payload_bytes integer, transaction_known boolean,
  current_revision bigint, document_hash text, head_segment_hash text, last_sequence_to bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor record;
  v_package evidence.package%ROWTYPE;
  v_document evidence.document%ROWTYPE;
  v_assignment record;
  v_assignment_id uuid;
  v_known boolean;
BEGIN
  SELECT * INTO v_actor FROM app.current_actor();
  IF v_actor.user_id IS NULL OR v_actor.institution_id IS NULL THEN
    outcome := 'unauthenticated'; RETURN NEXT; RETURN;
  END IF;
  -- The limits of the columns and of receipt v2: 1 to 256 characters for the
  -- document, 1 to 128 UTF-16 code units for the key, no control characters.
  IF p_document_id IS NULL OR pg_catalog.length(p_document_id) NOT BETWEEN 1 AND 256
     OR p_document_id ~ '[[:cntrl:]]'
     OR p_client_transaction_id IS NULL OR p_client_transaction_id = '' OR p_client_transaction_id ~ '[[:cntrl:]]'
     OR pg_catalog.length(p_client_transaction_id) + (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.regexp_split_to_table(p_client_transaction_id, '') AS codepoint(value)
        WHERE pg_catalog.octet_length(pg_catalog.convert_to(value, 'UTF8')) = 4
     ) > 128 THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  SELECT d.* INTO v_document FROM evidence.document d
   WHERE d.id = p_document_id AND d.institution_id = v_actor.institution_id AND d.principal_id = v_actor.user_id;
  IF FOUND THEN
    SELECT k.* INTO v_package FROM evidence.package k
     WHERE k.document_id = v_document.id AND k.institution_id = v_document.institution_id
       AND k.principal_id = v_actor.user_id
     ORDER BY k.created_at, k.id
     LIMIT 1;
  END IF;
  IF FOUND THEN
    SELECT p.assignment_id INTO v_assignment_id FROM evidence.project p
     WHERE p.id = v_package.project_id AND p.institution_id = v_package.institution_id
       AND p.principal_id = v_actor.user_id;
    -- Still an active student of the assignment (same check as the acceptance).
    SELECT * INTO v_assignment FROM app.lock_student_assignment(v_assignment_id);
  END IF;
  IF NOT FOUND THEN
    outcome := 'not_found'; RETURN NEXT; RETURN;
  END IF;

  v_known := EXISTS (
    SELECT 1 FROM evidence.receipt r
     WHERE r.evidence_package_id = v_package.id AND r.institution_id = v_package.institution_id
       AND r.principal_id = v_actor.user_id AND r.client_request_id = p_client_transaction_id
  );
  -- The acceptance's condition for a new acceptance (ADR 5.3 t. 8), with its clock.
  IF NOT v_known AND (NOT v_package.accepts_evidence OR NOT v_assignment.acknowledged
                      OR v_assignment.opens_at > pg_catalog.clock_timestamp()) THEN
    outcome := 'not_accepting'; RETURN NEXT; RETURN;
  END IF;

  outcome := 'ok';
  evidence_package_id := v_package.id;
  institution_id := v_package.institution_id;
  evidence_domain_id := v_package.evidence_domain_id;
  evidence_profile_id := v_package.evidence_profile_id;
  max_payload_bytes := v_package.max_payload_bytes;
  transaction_known := v_known;
  current_revision := v_document.current_revision;
  document_hash := v_document.current_content_hash;
  head_segment_hash := v_package.head_segment_hash;
  last_sequence_to := v_package.last_sequence_to;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.evidence_commit_context(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.evidence_commit_context(text, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
