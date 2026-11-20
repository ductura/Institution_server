-- migrate:up
-- SRV-33 (Ductus#2028, c.7009695691; Ductus docs/contracts/document-schema-v2.md
-- §6 and §7, points 1, 3 and 4): document v2 is received beside v1.
--
--   evidence.revision_zero_document_v2()   the exact JCS bytes of the v2
--                                          revision 0 (§6), beside the v1
--                                          function, which stays as it is
--   evidence.document_object(text)         a stored text as a JSON object,
--                                          or null for any other text
--   evidence.keep_document_schema_version  BEFORE INSERT on the checkpoints:
--                                          every later revision has the
--                                          schemaVersion of revision 0 (§7
--                                          t. 4), or nothing is written
--
-- The version of a work is the schemaVersion in the hashed bytes of its
-- revision 0 (§7 t. 3); there is no column that could say otherwise. The
-- check runs in the transaction that writes the revision, for every writer,
-- and for v1 works too: a v2 revision of a v1 work is refused, and the other
-- way round. app.open_student_work is not changed, so every new work is
-- still v1 (step 2 of §7 is a later migration). Errors carry no input:
-- ZD422 for a revision of another version.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

-- The same bytes and hash are fixed in server/domain/document/revision-zero.ts
-- (REVISION_ZERO_V2_JCS, REVISION_ZERO_V2_SHA256) and its known-answer test.
CREATE FUNCTION evidence.revision_zero_document_v2() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":2,"sources":[]}'::text
$$;
REVOKE ALL ON FUNCTION evidence.revision_zero_document_v2() FROM PUBLIC;

-- A stored text as a JSON object, or null for a text that is not one: such a
-- text is never a document the server accepted (server/domain/document/
-- snapshot.ts), and the checkpoint's own checks judge it.
--
-- jsonb cannot hold U+0000 or a lone surrogate, which valid JSON may carry as
-- an escape (and a text of a document may hold), so such a document would be
-- read as no object and pass unjudged. Each such escape is read as \u0001
-- first. A backslash in JSON stands only inside a string, so the rewrite
-- changes the content of strings and never the structure or a number: the
-- schemaVersion read is the stored one.
CREATE FUNCTION evidence.document_object(p_body text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_document jsonb;
BEGIN
  BEGIN
    v_document := pg_catalog.regexp_replace(
      p_body, '\\u(0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\\u0001', 'g')::jsonb;
  EXCEPTION WHEN data_exception OR program_limit_exceeded THEN
    RETURN NULL;
  END;
  IF pg_catalog.jsonb_typeof(v_document) <> 'object' THEN
    RETURN NULL;
  END IF;
  RETURN v_document;
END
$$;
REVOKE ALL ON FUNCTION evidence.document_object(text) FROM PUBLIC;

-- Revision 0 is the base: written by app.open_student_work and never deleted
-- (a checkpoint is never updated or truncated, and nothing deletes one). A
-- later revision that is a JSON object must carry the same schemaVersion, a
-- missing key included; the value is compared as jsonb, so 1 and "1" differ.
-- Definer, so the read of revision 0 does not depend on the writer's row
-- security.
CREATE FUNCTION evidence.keep_document_schema_version() RETURNS trigger
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
REVOKE ALL ON FUNCTION evidence.keep_document_schema_version() FROM PUBLIC;
CREATE TRIGGER evidence_checkpoint_same_version BEFORE INSERT ON evidence.document_checkpoint
  FOR EACH ROW EXECUTE FUNCTION evidence.keep_document_schema_version();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP TRIGGER evidence_checkpoint_same_version ON evidence.document_checkpoint;
DROP FUNCTION evidence.keep_document_schema_version();
DROP FUNCTION evidence.document_object(text);
DROP FUNCTION evidence.revision_zero_document_v2();
RESET ROLE;
