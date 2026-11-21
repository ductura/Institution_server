-- migrate:up
-- SRV-1803 (M8.2 and M8.2b, DAN-396; D-282, D-290 to D-292; contract
-- docs/adr/import-contract.md, SRV-1801): the record of a DOCX import. The
-- server reads the file, builds the manifest ductus-import-manifest-v1 with
-- its three hashes and prepares the import here; the student reviews the
-- preview and confirms it, idempotently. The import is marked in the record
-- as source "import" and evidence kind "imported", never "observed".
--
--   collaboration.import_event        one row per prepared import, append only
--   collaboration.import_confirmation one row per confirmed import, append only;
--                                     its event_id is the one import event (E2)
--   collaboration.import_gate         may the student owner import into the work now
--   collaboration.prepare_import      the server stores the manifest it built
--   collaboration.confirm_import      the review confirmation (contract §5)
--
-- Who may: only the student owner of the work (C-23: from the relation, never
-- from the role alone), only while the current version of the assignment has
-- "Dopušten uvoz" on (import_allowed, D-282; off by default, a new version may
-- only turn it off) and the work is not submitted. The base revision and the
-- time come from the database, never from the caller. Both tables are append
-- only: nothing updates or deletes a row, the owner included; the state of an
-- import is derived (confirmed when its confirmation exists, expired after 60
-- minutes, else pending). The file name is kept only in import_event.file_name,
-- outside every hash (D-292); it is never in the manifest.
--
-- Confirmation (contract §5): the row of the import is locked FOR UPDATE, so
-- two tabs confirming at once give exactly one event (P5); the order of the
-- decision is the order of decideImportConfirmation: NOT_FOUND (another owner,
-- document or import, P4), a confirmed import answers already-confirmed with
-- the same event (P1, P8) or MANIFEST_MISMATCH, then for a pending one
-- MANIFEST_MISMATCH (P2), EXPIRED (P3), IMPORT_NOT_ALLOWED (P7) and
-- REVISION_CHANGED (P9). A logout between preparing and confirming is ZD401
-- from the session fence (P6). Cancelling is not part of this step.
--
-- Lock order: import row, then document (FOR SHARE, lock_document_for_write);
-- the commit and submission paths take no lock of schema collaboration.
-- Nothing here writes schema evidence; the current revision is read through
-- document_import_revision, owned by the evidence role like document_scope.
-- Errors carry no input: ZD401 no session, ZD403 not the student owner or not
-- there (one answer), ZD409 a rewrite of the record, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
GRANT USAGE, CREATE ON SCHEMA collaboration TO ductus_evidence;

-- The current revision of a document of the caller's institution, or NULL.
SET LOCAL ROLE ductus_evidence;
CREATE FUNCTION collaboration.document_import_revision(p_document_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT d.current_revision
    FROM evidence.document d
    JOIN app.current_actor() a ON a.institution_id = d.institution_id
   WHERE d.id = p_document_id
$$;
REVOKE ALL ON FUNCTION collaboration.document_import_revision(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.document_import_revision(text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The manifest as prepare_import takes it: a JSON object of the closed v1 shape
-- whose id, document, kind, format and length are the columns of its row, and
-- whose text has the SHA-256 given. The canonical JCS form is the server's
-- (server/import, parseImportManifestV1Text); here every column a query reads
-- is held to the manifest, the source of truth. Never raises.
CREATE FUNCTION collaboration.is_import_manifest(
  p_manifest text, p_sha256 text, p_import_id uuid, p_document_id text,
  p_import_kind text, p_file_format text, p_raw_byte_length integer
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_manifest IS NULL OR octet_length(p_manifest) NOT BETWEEN 2 AND 4096
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex') <> p_sha256 THEN
    RETURN false;
  END IF;
  BEGIN
    v := p_manifest::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  RETURN coalesce(
    jsonb_typeof(v) = 'object'
    AND v ->> 'manifestSchema' = 'ductus-import-manifest-v1'
    AND v ->> 'importId' = p_import_id::text
    AND v ->> 'documentId' = p_document_id
    AND v ->> 'importKind' = p_import_kind
    AND v ->> 'fileFormat' = p_file_format
    AND jsonb_typeof(v -> 'rawByteLength') = 'number'
    AND (v ->> 'rawByteLength') = p_raw_byte_length::text
    AND v ->> 'rawSha256' ~ '^[0-9a-f]{64}$'
    AND v ->> 'contentSha256' ~ '^[0-9a-f]{64}$'
    AND NOT v ? 'fileName' AND NOT v ? 'manifestSha256',
    false);
END
$$;

-- A normalised file name (D-292, normalizeImportFileName): 1 to 200 code
-- points, NFC, no control, format or bidirectional character, not . or ..
CREATE FUNCTION collaboration.is_import_file_name(p_name text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_name IS NULL OR (
    char_length(p_name) BETWEEN 1 AND 200 AND p_name IS NFC NORMALIZED
    AND p_name = btrim(p_name) AND p_name NOT IN ('.', '..')
    AND p_name !~ '[/\\[:cntrl:]]'
    AND p_name !~ E'[­؜᠎​-‏‪-‮⁠-⁯﻿]')
$$;

CREATE TABLE collaboration.import_event (
  import_id uuid PRIMARY KEY CHECK (import_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  institution_id uuid NOT NULL,
  document_id text NOT NULL CHECK (length(document_id) BETWEEN 1 AND 256),
  assignment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  base_revision bigint NOT NULL CHECK (base_revision BETWEEN 0 AND 9007199254740991),
  manifest text NOT NULL,
  manifest_sha256 text NOT NULL,
  import_kind text NOT NULL CHECK (import_kind IN ('file-upload', 'cloud-version')),
  file_format text NOT NULL CHECK (file_format IN ('docx', 'pdf')),
  raw_byte_length integer NOT NULL CHECK (raw_byte_length BETWEEN 1 AND 2097152),
  file_name text CHECK (collaboration.is_import_file_name(file_name)),
  prepared_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (manifest_sha256),
  UNIQUE (import_id, institution_id, document_id, owner_id),
  CHECK (collaboration.is_import_manifest(manifest, manifest_sha256, import_id, document_id,
                                          import_kind, file_format, raw_byte_length)),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX import_event_document_idx ON collaboration.import_event (document_id, institution_id, prepared_at);

CREATE TABLE collaboration.import_confirmation (
  import_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  owner_id uuid NOT NULL,
  -- The id of the one import event of this import (E2): unique, never reused.
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  confirmed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (import_id, institution_id, document_id, owner_id)
    REFERENCES collaboration.import_event (import_id, institution_id, document_id, owner_id)
);

ALTER TABLE collaboration.import_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.import_event FORCE ROW LEVEL SECURITY;
CREATE POLICY import_event_owner ON collaboration.import_event TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE collaboration.import_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.import_confirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY import_confirmation_owner ON collaboration.import_confirmation TO ductus_identity USING (true) WITH CHECK (true);

-- Append only, for every role and the owner too: no update, delete or truncate.
CREATE FUNCTION collaboration.refuse_import_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'append only' USING ERRCODE = 'ZD409';
END
$$;
CREATE TRIGGER import_event_append_only BEFORE UPDATE OR DELETE ON collaboration.import_event
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_import_rewrite();
CREATE TRIGGER import_event_no_truncate BEFORE TRUNCATE ON collaboration.import_event
  FOR EACH STATEMENT EXECUTE FUNCTION collaboration.refuse_import_rewrite();
CREATE TRIGGER import_confirmation_append_only BEFORE UPDATE OR DELETE ON collaboration.import_confirmation
  FOR EACH ROW EXECUTE FUNCTION collaboration.refuse_import_rewrite();
CREATE TRIGGER import_confirmation_no_truncate BEFORE TRUNCATE ON collaboration.import_confirmation
  FOR EACH STATEMENT EXECUTE FUNCTION collaboration.refuse_import_rewrite();

-- Does the work take an import now: "Dopušten uvoz" on the current version of
-- its assignment (D-282) and the work not submitted. Internal; not granted.
CREATE FUNCTION collaboration.work_takes_import(p_document_id text, p_assignment_id uuid, p_institution_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT v.import_allowed
      FROM institution.assignment a
      JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
     WHERE a.id = p_assignment_id AND a.institution_id = p_institution_id
  ), false) AND NOT app.document_submitted(p_document_id)
$$;

-- The scope of a work for its student owner, or ZD403 (another's, a teacher's
-- view, a missing work: one answer). Internal; not granted.
CREATE FUNCTION collaboration.import_owner_scope(
  p_document_id text, OUT institution_id uuid, OUT assignment_id uuid, OUT owner_id uuid
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  scope record;
BEGIN
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  institution_id := scope.institution_id;
  assignment_id := scope.assignment_id;
  owner_id := scope.principal_id;
END
$$;

-- May the student owner import into the work now: 'allowed' or 'not_allowed'.
-- The route asks this before it reads a file, so a refused import costs no read.
CREATE FUNCTION collaboration.import_gate(p_document_id text)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scope record;
BEGIN
  PERFORM 1 FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.import_owner_scope(p_document_id);
  RETURN QUERY SELECT CASE WHEN collaboration.work_takes_import(p_document_id, scope.assignment_id, scope.institution_id)
                           THEN 'allowed' ELSE 'not_allowed' END;
END
$$;

-- The server stores the manifest it built from the received bytes. The base
-- revision is the document's current one, read here under the document lock.
-- 'prepared' with the base revision and the time, or 'not_allowed'.
CREATE FUNCTION collaboration.prepare_import(
  p_document_id text, p_import_id uuid, p_manifest text, p_manifest_sha256 text, p_file_name text
)
RETURNS TABLE (outcome text, base_revision bigint, prepared_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scope record;
  v_manifest jsonb;
  v_revision bigint;
  v_at timestamptz := statement_timestamp();
BEGIN
  PERFORM 1 FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.import_owner_scope(p_document_id);
  PERFORM collaboration.lock_document_for_write(p_document_id);
  IF NOT collaboration.work_takes_import(p_document_id, scope.assignment_id, scope.institution_id) THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_import_id IS NULL OR NOT collaboration.is_import_file_name(p_file_name) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  BEGIN
    v_manifest := p_manifest::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END;
  IF jsonb_typeof(v_manifest) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_manifest -> 'rawByteLength') IS DISTINCT FROM 'number'
     OR (v_manifest ->> 'rawByteLength') !~ '^[1-9][0-9]{0,6}$'
     OR (v_manifest ->> 'rawByteLength')::integer > 2097152
     OR NOT collaboration.is_import_manifest(p_manifest, p_manifest_sha256, p_import_id, p_document_id,
          v_manifest ->> 'importKind', v_manifest ->> 'fileFormat', (v_manifest ->> 'rawByteLength')::integer)
     OR v_manifest ->> 'importKind' NOT IN ('file-upload', 'cloud-version')
     OR v_manifest ->> 'fileFormat' NOT IN ('docx', 'pdf')
     OR p_import_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR EXISTS (SELECT 1 FROM collaboration.import_event e
                 WHERE e.import_id = p_import_id OR e.manifest_sha256 = p_manifest_sha256) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_revision := collaboration.document_import_revision(p_document_id);
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO collaboration.import_event
    (import_id, institution_id, document_id, assignment_id, owner_id, base_revision, manifest, manifest_sha256,
     import_kind, file_format, raw_byte_length, file_name, prepared_at)
  VALUES (p_import_id, scope.institution_id, p_document_id, scope.assignment_id, scope.owner_id, v_revision,
          p_manifest, p_manifest_sha256, v_manifest ->> 'importKind', v_manifest ->> 'fileFormat',
          (v_manifest ->> 'rawByteLength')::integer, p_file_name, v_at);
  RETURN QUERY SELECT 'prepared'::text, v_revision, v_at;
END
$$;

-- The student's review confirmation (contract §5). Outcome 'confirmed' or
-- 'already-confirmed' with the one event id, or a rejection code of
-- IMPORT_CONFIRM_REJECT_CODES with a NULL event id. Another's import, another
-- work, a teacher and a missing import read the same: NOT_FOUND (P4).
CREATE FUNCTION collaboration.confirm_import(p_document_id text, p_import_id uuid, p_manifest_sha256 text)
RETURNS TABLE (outcome text, event_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  scope record;
  v_row record;
  v_event uuid;
  v_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO scope FROM collaboration.document_scope(p_document_id);
  IF collaboration.actor_role(scope.institution_id, scope.assignment_id, scope.principal_id) IS DISTINCT FROM 'student'
     OR p_import_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT e.manifest_sha256, e.base_revision, e.prepared_at INTO v_row
    FROM collaboration.import_event e
   WHERE e.import_id = p_import_id AND e.institution_id = scope.institution_id
     AND e.document_id = p_document_id AND e.owner_id = actor.user_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT c.event_id INTO v_event FROM collaboration.import_confirmation c WHERE c.import_id = p_import_id;
  IF v_event IS NOT NULL THEN
    IF v_row.manifest_sha256 IS DISTINCT FROM p_manifest_sha256 THEN
      RETURN QUERY SELECT 'MANIFEST_MISMATCH'::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'already-confirmed'::text, v_event;
    END IF;
    RETURN;
  END IF;
  IF v_row.manifest_sha256 IS DISTINCT FROM p_manifest_sha256 THEN
    RETURN QUERY SELECT 'MANIFEST_MISMATCH'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_now < v_row.prepared_at OR v_now >= v_row.prepared_at + interval '60 minutes' THEN
    RETURN QUERY SELECT 'EXPIRED'::text, NULL::uuid;
    RETURN;
  END IF;
  PERFORM collaboration.lock_document_for_write(p_document_id);
  IF NOT collaboration.work_takes_import(p_document_id, scope.assignment_id, scope.institution_id) THEN
    RETURN QUERY SELECT 'IMPORT_NOT_ALLOWED'::text, NULL::uuid;
    RETURN;
  END IF;
  IF collaboration.document_import_revision(p_document_id) IS DISTINCT FROM v_row.base_revision THEN
    RETURN QUERY SELECT 'REVISION_CHANGED'::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO collaboration.import_confirmation (import_id, institution_id, document_id, owner_id, confirmed_at)
  VALUES (p_import_id, scope.institution_id, p_document_id, actor.user_id, v_now)
  RETURNING import_confirmation.event_id INTO v_event;
  RETURN QUERY SELECT 'confirmed'::text, v_event;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.is_import_manifest(text, text, uuid, text, text, text, integer),
  collaboration.is_import_file_name(text),
  collaboration.refuse_import_rewrite(),
  collaboration.work_takes_import(text, uuid, uuid),
  collaboration.import_owner_scope(text),
  collaboration.import_gate(text),
  collaboration.prepare_import(text, uuid, text, text, text),
  collaboration.confirm_import(text, uuid, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.import_gate(text),
  collaboration.prepare_import(text, uuid, text, text, text),
  collaboration.confirm_import(text, uuid, text)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
REVOKE USAGE, CREATE ON SCHEMA collaboration FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.confirm_import(text, uuid, text);
DROP FUNCTION collaboration.prepare_import(text, uuid, text, text, text);
DROP FUNCTION collaboration.import_gate(text);
DROP FUNCTION collaboration.import_owner_scope(text);
DROP FUNCTION collaboration.work_takes_import(text, uuid, uuid);
DROP TABLE collaboration.import_confirmation;
DROP TABLE collaboration.import_event;
DROP FUNCTION collaboration.refuse_import_rewrite();
DROP FUNCTION collaboration.is_import_file_name(text);
DROP FUNCTION collaboration.is_import_manifest(text, text, uuid, text, text, text, integer);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
DROP FUNCTION collaboration.document_import_revision(text);
