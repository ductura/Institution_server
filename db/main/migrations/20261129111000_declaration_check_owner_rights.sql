-- migrate:up
-- SRV-1211, fix of 20261129110000_declaration_schema_rls.sql (Codex review
-- of #535, merged before the fix).
--   * The deferred attachment check fires at commit, after the definer
--     context of save_statement has ended, with the web login as the current
--     user. That login cannot read declaration.conversation_attachment, so
--     every confirmation failed with 42501. The check runs with the owner's
--     rights; it reads only the row it fires for and its attachment rows.
--   * A missing or null payload field made a comparison NULL, and a CHECK
--     accepts NULL. The whole comparison has to be TRUE.
SET LOCAL ROLE ductus_evidence;
ALTER FUNCTION declaration.check_statement_attachments() SECURITY DEFINER;

ALTER TABLE declaration.statement DROP CONSTRAINT statement_payload_matches_row;
ALTER TABLE declaration.statement ADD CONSTRAINT statement_payload_matches_row CHECK (payload_jcs IS NULL OR (
  payload_jcs = declaration.canonical_payload(payload_jcs::jsonb)
  AND payload_jcs::jsonb ->> 'declarationSchema' = 'ductura-declaration-v1'
  AND payload_jcs::jsonb ->> 'principalId' = principal_id::text
  AND payload_jcs::jsonb ->> 'assignmentId' = assignment_id::text
  AND payload_jcs::jsonb -> 'assignmentVersion' = to_jsonb(assignment_version)
  AND payload_jcs::jsonb ->> 'documentId' = document_id
  AND payload_jcs::jsonb -> 'revision' = to_jsonb(revision)) IS TRUE);
SET LOCAL ROLE ductus_migrator;

-- migrate:down
SET LOCAL ROLE ductus_evidence;
ALTER TABLE declaration.statement DROP CONSTRAINT statement_payload_matches_row;
ALTER TABLE declaration.statement ADD CONSTRAINT statement_payload_matches_row CHECK (payload_jcs IS NULL OR (
  payload_jcs = declaration.canonical_payload(payload_jcs::jsonb)
  AND payload_jcs::jsonb ->> 'declarationSchema' = 'ductura-declaration-v1'
  AND payload_jcs::jsonb ->> 'principalId' = principal_id::text
  AND payload_jcs::jsonb ->> 'assignmentId' = assignment_id::text
  AND payload_jcs::jsonb -> 'assignmentVersion' = to_jsonb(assignment_version)
  AND payload_jcs::jsonb ->> 'documentId' = document_id
  AND payload_jcs::jsonb -> 'revision' = to_jsonb(revision)));
ALTER FUNCTION declaration.check_statement_attachments() SECURITY INVOKER;
SET LOCAL ROLE ductus_migrator;
