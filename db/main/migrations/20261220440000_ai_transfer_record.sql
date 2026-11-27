-- migrate:up
-- SRV-1809 step 3 (Ductus docs/contracts/evidence-segment-v4.md; contract
-- server/contracts/evidence-transfer/ai-transfer.ts): the record of a transfer
-- of assistant text into a work, ductus-ai-transfer-v1. Owner decisions in
-- Ductus#2059 (comments 7208668664 and 7208831876): O-4, the record is its own
-- row and a v4 segment points at it by aiTransferId and aiTransferSha256; O-5,
-- transferredAt is a whole minute from the database clock.
--
--   assistant.ai_transfer         one row per transfer, append only
--   assistant.create_ai_transfer  the student owner records a transfer
--
-- What the caller gives: the work, the response message and the transferred
-- text. The text must be a non-empty, contiguous part of that response, exactly
-- as stored; the server hashes it (SHA-256 of its UTF-8 bytes, not normalised,
-- as event-text.ts) and never stores it (C11). Everything else comes from the
-- database, never from the caller: provider, model and purpose are those of
-- the response's request; the phase is derived from the state of the work
-- (D-42, no question to the student), from a closed list:
--   drafting          nothing sent yet
--   revision          a version was sent (a revision round, or a submission
--                     that was withdrawn or returned for revision)
--   after_submission  a submission that is not withdrawn exists
-- The record text is the JCS form of the twelve keys, built here and held to
-- the columns by a constraint; record_sha256 is its SHA-256.
--
-- Who may: only the student owner of the work (C-23), and only with a response
-- of the student's own conversation on the work's assignment. Another's work,
-- another's response, a missing one and a teacher read the same: ZD403. The
-- table is append only, for the owner too. Nothing here writes schema
-- evidence; the submission state is read through collaboration.document_submission_state,
-- owned by the evidence role like collaboration.document_scope.
-- Errors carry no input: ZD401 no session, ZD403 not the student owner or not
-- there (one answer), ZD409 a rewrite of the record, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;

-- The submission state of a document of the caller's institution: 'current'
-- (a submission that is not withdrawn), 'earlier' (only withdrawn or returned
-- ones) or 'none'.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.document_submission_state(p_document_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN bool_or(NOT evidence.submission_withdrawn(s.id)) THEN 'current'
    WHEN count(s.id) > 0 THEN 'earlier'
    ELSE 'none' END
    FROM app.current_actor() a
    JOIN evidence.submission_request r ON r.institution_id = a.institution_id AND r.document_id = p_document_id
    JOIN evidence.submission s ON s.submission_request_id = r.id AND s.institution_id = r.institution_id
$$;
REVOKE ALL ON FUNCTION collaboration.document_submission_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.document_submission_state(text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The canonical (JCS) text of a ductus-ai-transfer-v1 record: the keys sorted,
-- strings as JSON.stringify writes them (to_json), the time as a whole UTC
-- minute. Equal to canonicalAiTransferRecordV1 (pgTAP holds it to the golden
-- vectors). Never raises on non-null input.
CREATE FUNCTION assistant.ai_transfer_canonical(
  p_transfer_id uuid, p_document_id text, p_conversation_id uuid, p_response_id uuid,
  p_provider_id text, p_model_id text, p_purpose_catalog_version integer, p_purpose_id text,
  p_phase_id text, p_text_sha256 text, p_transferred_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT '{"conversationId":' || to_json(p_conversation_id::text)::text
      || ',"documentId":' || to_json(p_document_id)::text
      || ',"modelId":' || to_json(p_model_id)::text
      || ',"phaseId":' || to_json(p_phase_id)::text
      || ',"providerId":' || to_json(p_provider_id)::text
      || ',"purposeCatalogVersion":' || p_purpose_catalog_version::text
      || ',"purposeId":' || to_json(p_purpose_id)::text
      || ',"responseId":' || to_json(p_response_id::text)::text
      || ',"textSha256":' || to_json(p_text_sha256)::text
      || ',"transferId":' || to_json(p_transfer_id::text)::text
      || ',"transferSchema":"ductus-ai-transfer-v1"'
      || ',"transferredAt":"' || to_char(p_transferred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || ':00.000Z"}'
$$;

CREATE TABLE assistant.ai_transfer (
  transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    CHECK (transfer_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  institution_id uuid NOT NULL,
  student_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  conversation_id uuid NOT NULL
    CHECK (conversation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  response_id uuid NOT NULL
    CHECK (response_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  model_id text NOT NULL CHECK (model_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  purpose_catalog_version integer NOT NULL CHECK (purpose_catalog_version BETWEEN 1 AND 2147483647),
  purpose_id text NOT NULL CHECK (purpose_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  phase_id text NOT NULL CHECK (phase_id IN ('drafting', 'revision', 'after_submission')),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  transferred_at timestamptz NOT NULL,
  record_text text NOT NULL,
  record_sha256 text NOT NULL UNIQUE,
  CHECK (date_trunc('minute', transferred_at AT TIME ZONE 'UTC') = transferred_at AT TIME ZONE 'UTC'),
  CHECK (record_text = assistant.ai_transfer_canonical(transfer_id, document_id, conversation_id, response_id,
    provider_id, model_id, purpose_catalog_version, purpose_id, phase_id, text_sha256, transferred_at)),
  CHECK (record_sha256 = encode(sha256(convert_to(record_text, 'UTF8')), 'hex')),
  FOREIGN KEY (conversation_id, institution_id) REFERENCES assistant.conversation (id, institution_id),
  -- No FK to the response: a reference would stop the guarded TRUNCATE of the
  -- messages before their own trigger. The RPC checks the response, and a
  -- message is never deleted.
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX ai_transfer_document_idx ON assistant.ai_transfer (document_id, institution_id);

ALTER TABLE assistant.ai_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.ai_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_transfer_owner ON assistant.ai_transfer TO ductus_identity USING (true) WITH CHECK (true);

-- Append only, for every role and the owner too: no update, delete or truncate.
CREATE FUNCTION assistant.refuse_ai_transfer_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'append only' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER ai_transfer_append_only BEFORE UPDATE OR DELETE ON assistant.ai_transfer
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_ai_transfer_rewrite();
CREATE TRIGGER ai_transfer_no_truncate BEFORE TRUNCATE ON assistant.ai_transfer
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_ai_transfer_rewrite();

-- The phase of a work now (D-42), from its state; see the header. Internal.
CREATE FUNCTION assistant.ai_transfer_phase(p_document_id text, p_institution_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE collaboration.document_submission_state(p_document_id)
    WHEN 'current' THEN 'after_submission'
    WHEN 'earlier' THEN 'revision'
    ELSE CASE WHEN EXISTS (SELECT 1 FROM collaboration.revision_send r
                            WHERE r.document_id = p_document_id AND r.institution_id = p_institution_id)
              THEN 'revision' ELSE 'drafting' END
  END
$$;

-- At most this many transfers per work; a bound on what one student can store.
CREATE FUNCTION assistant.ai_transfer_max() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 5000 $$;

-- The student owner records a transfer from a response into the work. Returns
-- the new record: its id, its SHA-256 and its canonical text.
CREATE FUNCTION assistant.create_ai_transfer(p_document_id text, p_response_id uuid, p_text text)
RETURNS TABLE (transfer_id uuid, record_sha256 text, record_text text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scope record;
  src record;
  v_id uuid := gen_random_uuid();
  v_at timestamptz := date_trunc('minute', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_phase text;
  v_text_sha text;
  v_record text;
BEGIN
  PERFORM 1 FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.import_owner_scope(p_document_id);
  SELECT m.conversation_id, m.content, q.provider_id, q.model_id, q.purpose_catalog_version, q.purpose_key
    INTO src
    FROM assistant.message m
    JOIN assistant.conversation c ON c.id = m.conversation_id AND c.institution_id = m.institution_id
    JOIN assistant.request q ON q.id = m.request_id AND q.institution_id = m.institution_id
   WHERE m.id = p_response_id AND m.role = 'provider_response'
     AND m.institution_id = scope.institution_id
     AND c.student_id = scope.owner_id AND c.assignment_id = scope.assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_text IS NULL OR p_text = '' OR char_length(p_text) > 40000 OR strpos(src.content, p_text) = 0
     OR src.provider_id IS NULL OR src.model_id IS NULL
     OR src.conversation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_response_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (SELECT count(*) FROM assistant.ai_transfer t
          WHERE t.document_id = p_document_id AND t.institution_id = scope.institution_id) >= assistant.ai_transfer_max() THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_phase := assistant.ai_transfer_phase(p_document_id, scope.institution_id);
  v_text_sha := encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
  v_record := assistant.ai_transfer_canonical(v_id, p_document_id, src.conversation_id, p_response_id,
    src.provider_id, src.model_id, src.purpose_catalog_version, src.purpose_key, v_phase, v_text_sha, v_at);
  INSERT INTO assistant.ai_transfer
    (transfer_id, institution_id, student_id, document_id, conversation_id, response_id, provider_id, model_id,
     purpose_catalog_version, purpose_id, phase_id, text_sha256, transferred_at, record_text, record_sha256)
  VALUES (v_id, scope.institution_id, scope.owner_id, p_document_id, src.conversation_id, p_response_id,
          src.provider_id, src.model_id, src.purpose_catalog_version, src.purpose_key, v_phase, v_text_sha, v_at,
          v_record, encode(sha256(convert_to(v_record, 'UTF8')), 'hex'));
  RETURN QUERY SELECT v_id, encode(sha256(convert_to(v_record, 'UTF8')), 'hex'), v_record;
END
$$;

REVOKE ALL ON FUNCTION assistant.ai_transfer_canonical(uuid, text, uuid, uuid, text, text, integer, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.refuse_ai_transfer_rewrite() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.ai_transfer_phase(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.ai_transfer_max() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.create_ai_transfer(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.create_ai_transfer(text, uuid, text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.create_ai_transfer(text, uuid, text);
DROP FUNCTION assistant.ai_transfer_max();
DROP FUNCTION assistant.ai_transfer_phase(text, uuid);
DROP TABLE assistant.ai_transfer;
DROP FUNCTION assistant.refuse_ai_transfer_rewrite();
DROP FUNCTION assistant.ai_transfer_canonical(uuid, text, uuid, uuid, text, text, integer, text, text, text, timestamptz);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
DROP FUNCTION collaboration.document_submission_state(text);
