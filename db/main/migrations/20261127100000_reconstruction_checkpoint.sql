-- SRV-1503 (plan M3.3, B-12): reconstruction checkpoints. After every N
-- accepted segments the worker keeps the document it reconstructed, so a later
-- read of a revision replays only the segments after the newest checkpoint at
-- or before it, not the whole record (server/evidence/reconstruction/).
--
-- A checkpoint is a cache the record vouches for, never evidence of its own:
-- * its text must hash to the hash the revision was committed with (the
--   foreign key below), and the database computes that hash from the bytes;
-- * the revision must be the one a receipt of the same package issued for the
--   named segment, so a checkpoint cannot sit at a position of another chain;
-- * rows are append-only: no update, delete or truncate. Unlike
--   evidence.document_checkpoint (the client's snapshot, thinned later) these
--   rows stay until a retention migration says otherwise.
--
-- The worker writes and reads through two RPCs of its own evidence domain;
-- the owning student reads the newest checkpoint of the own document through a
-- third. Nobody reads the table directly (D-71, D-74, D-102), and identity and
-- institution come from the package or current_actor(), never a parameter.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.reconstruction_checkpoint (
  evidence_package_id text NOT NULL,
  institution_id uuid NOT NULL,
  document_id text NOT NULL,
  principal_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  segment_hash text NOT NULL CHECK (segment_hash ~ '^[0-9a-f]{64}$'),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2097152),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (evidence_package_id, institution_id, revision),
  FOREIGN KEY (evidence_package_id, institution_id, document_id, principal_id)
    REFERENCES evidence.package (id, institution_id, document_id, principal_id),
  FOREIGN KEY (document_id, institution_id, revision, content_hash)
    REFERENCES evidence.document_revision (document_id, institution_id, revision, content_hash)
);
CREATE INDEX reconstruction_checkpoint_document
  ON evidence.reconstruction_checkpoint (document_id, institution_id, revision);

-- The writer gives only the bytes: hash and time are the database's.
CREATE FUNCTION evidence.seal_reconstruction_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.content_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.body, 'UTF8')), 'hex');
  NEW.created_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION evidence.seal_reconstruction_checkpoint() FROM PUBLIC;
CREATE TRIGGER reconstruction_checkpoint_seal BEFORE INSERT ON evidence.reconstruction_checkpoint
  FOR EACH ROW EXECUTE FUNCTION evidence.seal_reconstruction_checkpoint();
CREATE TRIGGER reconstruction_checkpoint_immutable BEFORE UPDATE OR DELETE ON evidence.reconstruction_checkpoint
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER reconstruction_checkpoint_no_truncate BEFORE TRUNCATE ON evidence.reconstruction_checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.reconstruction_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.reconstruction_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_reconstruction_checkpoint_owner ON evidence.reconstruction_checkpoint
  TO ductus_evidence USING (true) WITH CHECK (true);

-- The worker's request shape, shared by its two RPCs: a domain, a package id
-- of the package format and a revision of the document's range.
CREATE FUNCTION evidence.reconstruction_checkpoint_request_valid(
  p_evidence_domain_id uuid, p_evidence_package_id text, p_revision bigint)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_evidence_domain_id IS NOT NULL AND p_evidence_package_id IS NOT NULL
     AND p_evidence_package_id ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
     AND p_revision IS NOT NULL AND p_revision BETWEEN 1 AND 9007199254740991
$$;
REVOKE ALL ON FUNCTION evidence.reconstruction_checkpoint_request_valid(uuid, text, bigint) FROM PUBLIC;

-- Outcomes: recorded (a new row), exists (the revision already has one; the
-- first stays), not_found (no package of this domain, or no receipt of it for
-- this revision and segment: one answer), mismatch (the text does not hash to
-- the hash the revision was committed with; no row is written).
CREATE FUNCTION app.worker_record_reconstruction_checkpoint(
  p_evidence_domain_id uuid, p_evidence_package_id text, p_revision bigint,
  p_segment_hash text, p_body text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_package record;
  v_committed text;
BEGIN
  IF NOT evidence.reconstruction_checkpoint_request_valid(p_evidence_domain_id, p_evidence_package_id, p_revision)
     OR p_segment_hash IS NULL OR p_segment_hash !~ '^[0-9a-f]{64}$'
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 2097152 THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;

  SELECT p.id, p.institution_id, p.document_id, p.principal_id INTO v_package
    FROM evidence.package p
   WHERE p.id = p_evidence_package_id AND p.evidence_domain_id = p_evidence_domain_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM evidence.receipt r
     WHERE r.evidence_package_id = v_package.id AND r.institution_id = v_package.institution_id
       AND r.receipt_payload::jsonb->>'segmentHash' = p_segment_hash
       AND r.receipt_payload::jsonb->>'revision' = p_revision::text) THEN
    RETURN 'not_found';
  END IF;

  SELECT d.content_hash INTO v_committed FROM evidence.document_revision d
   WHERE d.document_id = v_package.document_id AND d.institution_id = v_package.institution_id
     AND d.revision = p_revision;
  IF v_committed IS DISTINCT FROM
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_body, 'UTF8')), 'hex') THEN
    RETURN 'mismatch';
  END IF;

  INSERT INTO evidence.reconstruction_checkpoint (
    evidence_package_id, institution_id, document_id, principal_id, revision, segment_hash, body
  ) VALUES (
    v_package.id, v_package.institution_id, v_package.document_id, v_package.principal_id,
    p_revision, p_segment_hash, p_body
  ) ON CONFLICT (evidence_package_id, institution_id, revision) DO NOTHING;
  RETURN CASE WHEN FOUND THEN 'recorded' ELSE 'exists' END;
END
$$;
REVOKE ALL ON FUNCTION app.worker_record_reconstruction_checkpoint(uuid, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_record_reconstruction_checkpoint(uuid, text, bigint, text, text)
  TO ductus_worker;

-- The newest checkpoint of the package at or before p_revision whose text
-- still hashes to its key; no row when there is none, the package is unknown
-- or of another domain, so the answer never tells them apart.
CREATE FUNCTION app.worker_reconstruction_checkpoint(
  p_evidence_domain_id uuid, p_evidence_package_id text, p_revision bigint)
RETURNS TABLE (revision bigint, segment_hash text, content_hash text, body text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT evidence.reconstruction_checkpoint_request_valid(p_evidence_domain_id, p_evidence_package_id, p_revision) THEN
    RAISE EXCEPTION 'invalid worker request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.revision, c.segment_hash, c.content_hash, c.body
      FROM evidence.package p
      JOIN evidence.reconstruction_checkpoint c
        ON c.evidence_package_id = p.id AND c.institution_id = p.institution_id
     WHERE p.id = p_evidence_package_id
       AND p.evidence_domain_id = p_evidence_domain_id
       AND c.revision <= p_revision
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex') = c.content_hash
     ORDER BY c.revision DESC
     LIMIT 1;
END
$$;
REVOKE ALL ON FUNCTION app.worker_reconstruction_checkpoint(uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_reconstruction_checkpoint(uuid, text, bigint) TO ductus_worker;

-- The owning student's read: the newest checkpoint of the caller's own
-- document at or before p_revision (C-23: from the relation, not the role).
-- Another person's document, one of another institution, an unknown one and
-- a caller without a session all give no row.
CREATE FUNCTION app.read_own_reconstruction_checkpoint(p_document_id text, p_revision bigint)
RETURNS TABLE (revision bigint, segment_hash text, content_hash text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.revision, c.segment_hash, c.content_hash, c.body
    FROM app.current_actor() a
    JOIN evidence.reconstruction_checkpoint c
      ON c.institution_id = a.institution_id AND c.principal_id = a.user_id
   WHERE a.user_id IS NOT NULL
     AND c.document_id = p_document_id
     AND c.revision <= p_revision
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.body, 'UTF8')), 'hex') = c.content_hash
   ORDER BY c.revision DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.read_own_reconstruction_checkpoint(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_own_reconstruction_checkpoint(text, bigint) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA evidence, app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.read_own_reconstruction_checkpoint(text, bigint);
DROP FUNCTION app.worker_reconstruction_checkpoint(uuid, text, bigint);
DROP FUNCTION app.worker_record_reconstruction_checkpoint(uuid, text, bigint, text, text);
DROP FUNCTION evidence.reconstruction_checkpoint_request_valid(uuid, text, bigint);
DROP TABLE evidence.reconstruction_checkpoint;
DROP FUNCTION evidence.seal_reconstruction_checkpoint();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA evidence, app FROM ductus_evidence;
