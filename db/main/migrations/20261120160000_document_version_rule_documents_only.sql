-- migrate:up
-- SRV-33 follow-up (Ductus#2028; CI on ductura/Institution_server#420): the
-- version rule of 20261120150000 judges only a document.
--
-- That migration treated a checkpoint object without schemaVersion as a
-- revision of another version and refused it (ZD422). Such an object is no
-- document of any version: the server's validator requires the key
-- (server/domain/document/validate.ts), so no commit through the server can
-- write one. The evidence-commit and pending-receipt-worker integration tests
-- write such synthetic snapshots straight through app.commit_evidence_segment
-- and were refused. Like any other text that is no document, an object
-- without the key is now left to the other checks of the checkpoint, as
-- before 20261120150000. A JSON object with a schemaVersion is still judged
-- against revision 0, as jsonb (1 and "1" differ), in both directions.
-- Only the trigger function changes; its trigger, owner and rights stay.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE OR REPLACE FUNCTION evidence.keep_document_schema_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_base jsonb;
  v_new jsonb;
BEGIN
  IF NEW.revision = 0 THEN
    RETURN NEW;
  END IF;
  SELECT evidence.document_object(c.body) INTO v_base
    FROM evidence.document_checkpoint c
   WHERE c.document_id = NEW.document_id AND c.institution_id = NEW.institution_id
     AND c.revision = 0;
  v_new := evidence.document_object(NEW.body);
  IF v_base IS NULL OR v_new IS NULL OR NOT (v_new ? 'schemaVersion') THEN
    RETURN NEW;
  END IF;
  IF (v_new -> 'schemaVersion') IS DISTINCT FROM (v_base -> 'schemaVersion') THEN
    RAISE EXCEPTION 'revision of another document version' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
CREATE OR REPLACE FUNCTION evidence.keep_document_schema_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_base jsonb;
  v_new jsonb;
BEGIN
  IF NEW.revision = 0 THEN
    RETURN NEW;
  END IF;
  SELECT evidence.document_object(c.body) INTO v_base
    FROM evidence.document_checkpoint c
   WHERE c.document_id = NEW.document_id AND c.institution_id = NEW.institution_id
     AND c.revision = 0;
  v_new := evidence.document_object(NEW.body);
  IF v_base IS NULL OR v_new IS NULL THEN
    RETURN NEW;
  END IF;
  IF (v_new -> 'schemaVersion') IS DISTINCT FROM (v_base -> 'schemaVersion') THEN
    RAISE EXCEPTION 'revision of another document version' USING ERRCODE = 'ZD422';
  END IF;
  RETURN NEW;
END
$$;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
