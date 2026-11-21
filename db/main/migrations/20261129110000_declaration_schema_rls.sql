-- migrate:up
-- SRV-1211. Step 2 of docs/contracts/declaration-v1.md, section 8 (OD-1:
-- a durable record on the server). SRV-1510 made the schema with the
-- statement and external upload tables and their RPCs; this closes what
-- section 8 still asks of the storage itself:
--   * one draft per student and assignment (OD-13: no rounds yet);
--   * a row is a draft or a confirmed version and no UPDATE turns one into
--     the other; a confirmed version is never changed or deleted;
--   * a confirmed row agrees with its payload: schema, student, assignment,
--     its version, document and revision, in canonical bytes;
--   * the conversation attachments of a confirmed version as rows, exactly
--     the ones in its hashed payload, append-only.
-- The web role still has no direct access to any table of the schema and
-- the worker none at all; it sees only the id and hash pinned on the
-- request (section 8). A teacher reads nothing here: the read of the bound
-- version (section 7, step 4) and its access log surface (OD-10) are not
-- in this step. The producer of conversation attachments is M9.5 (2.5), so
-- save_statement still accepts only an empty list and the table stays empty
-- until then; the conversation id has no foreign key into the assistant
-- schema, which another owner holds, and is checked by that producer.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA declaration TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE UNIQUE INDEX statement_one_draft ON declaration.statement (institution_id, assignment_id, principal_id)
  WHERE draft IS NOT NULL;

DROP TRIGGER statement_immutable ON declaration.statement;
CREATE TRIGGER statement_no_update BEFORE UPDATE ON declaration.statement
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER statement_immutable BEFORE DELETE ON declaration.statement
  FOR EACH ROW WHEN (OLD.payload_jcs IS NOT NULL) EXECUTE FUNCTION evidence.reject_append_only_change();

-- IS TRUE: a missing or null field makes a comparison NULL, which a CHECK
-- would otherwise accept.
ALTER TABLE declaration.statement ADD CONSTRAINT statement_payload_matches_row CHECK (payload_jcs IS NULL OR (
  payload_jcs = declaration.canonical_payload(payload_jcs::jsonb)
  AND payload_jcs::jsonb ->> 'declarationSchema' = 'ductura-declaration-v1'
  AND payload_jcs::jsonb ->> 'principalId' = principal_id::text
  AND payload_jcs::jsonb ->> 'assignmentId' = assignment_id::text
  AND payload_jcs::jsonb -> 'assignmentVersion' = to_jsonb(assignment_version)
  AND payload_jcs::jsonb ->> 'documentId' = document_id
  AND payload_jcs::jsonb -> 'revision' = to_jsonb(revision)) IS TRUE);

ALTER TABLE declaration.statement ADD CONSTRAINT statement_id_institution UNIQUE (id, institution_id);
CREATE TABLE declaration.conversation_attachment (
  statement_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('transferred_deleted', 'transferred', 'pasted_known', 'student_added')),
  through_seq integer NOT NULL CHECK (through_seq >= 1),
  messages_sha256 text NOT NULL CHECK (messages_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (statement_id, conversation_id),
  FOREIGN KEY (statement_id, institution_id) REFERENCES declaration.statement (id, institution_id)
);
ALTER TABLE declaration.conversation_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaration.conversation_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_attachment_owner ON declaration.conversation_attachment
  TO ductus_evidence USING (true) WITH CHECK (true);
CREATE TRIGGER conversation_attachment_immutable BEFORE UPDATE OR DELETE ON declaration.conversation_attachment
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER conversation_attachment_no_truncate BEFORE TRUNCATE ON declaration.conversation_attachment
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- The conversation entries of a confirmed payload, in the payload's shape.
CREATE FUNCTION declaration.payload_conversations(p_payload_jcs text) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT e FROM jsonb_array_elements(coalesce(p_payload_jcs::jsonb #> '{ai,attachments}', '[]')) e
   WHERE e ->> 'reason' IS DISTINCT FROM 'external_upload'
$$;

-- A row names an entry of a confirmed payload, never a draft or anything else.
CREATE FUNCTION declaration.check_conversation_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM declaration.statement s
     CROSS JOIN LATERAL declaration.payload_conversations(s.payload_jcs) e
     WHERE s.id = NEW.statement_id AND s.payload_jcs IS NOT NULL
       AND e = jsonb_build_object('reason', NEW.reason, 'conversationId', NEW.conversation_id,
         'throughSeq', NEW.through_seq, 'messagesSha256', NEW.messages_sha256))
  THEN
    RAISE EXCEPTION 'attachment outside the confirmed payload' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_attachment_in_payload BEFORE INSERT ON declaration.conversation_attachment
  FOR EACH ROW EXECUTE FUNCTION declaration.check_conversation_attachment();

-- At commit, every conversation entry of a confirmed payload has its row, so
-- the rows and the hashed bytes cannot tell different stories. The check is
-- deferred, so it fires after the RPC's definer context has ended, with the
-- web login as the current user; it therefore runs with the owner's rights.
CREATE FUNCTION declaration.check_statement_attachments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.payload_jcs IS NOT NULL AND (
    SELECT count(*) FROM declaration.payload_conversations(NEW.payload_jcs)
  ) <> (
    SELECT count(*) FROM declaration.conversation_attachment c WHERE c.statement_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'confirmed payload without its attachment rows' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_attachments_complete AFTER INSERT ON declaration.statement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION declaration.check_statement_attachments();

REVOKE EXECUTE ON FUNCTION declaration.payload_conversations(text), declaration.check_conversation_attachment(),
  declaration.check_statement_attachments() FROM PUBLIC;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA declaration FROM ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_evidence;
DROP TRIGGER statement_attachments_complete ON declaration.statement;
DROP TABLE declaration.conversation_attachment;
ALTER TABLE declaration.statement DROP CONSTRAINT statement_id_institution;
DROP FUNCTION declaration.check_statement_attachments();
DROP FUNCTION declaration.check_conversation_attachment();
DROP FUNCTION declaration.payload_conversations(text);
ALTER TABLE declaration.statement DROP CONSTRAINT statement_payload_matches_row;
DROP TRIGGER statement_immutable ON declaration.statement;
DROP TRIGGER statement_no_update ON declaration.statement;
CREATE TRIGGER statement_immutable BEFORE UPDATE OR DELETE ON declaration.statement
  FOR EACH ROW WHEN (OLD.payload_jcs IS NOT NULL) EXECUTE FUNCTION evidence.reject_append_only_change();
DROP INDEX declaration.statement_one_draft;
