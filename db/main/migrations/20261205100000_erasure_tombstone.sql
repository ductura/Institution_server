-- migrate:up
-- SRV-1301 (M10.0-S1; D-272 MQ04, MQ05): one erasure contract. A row of a
-- protected table is removed only through a narrow definer function that the
-- retention role alone may call, and every removal leaves a tombstone in the
-- same transaction. The tombstone holds the institution, the data class, the id of the erased
-- subject, the SHA-256 of what was erased, the reason, the job and the time,
-- never the erased content itself.
--
--   evidence.erasure         the tombstones; append-only for the owner too,
--                            forced RLS with only the owner's policy, no
--                            privilege for any other role
--   app.erasure_append       erases one subject of a data class and writes its
--                            tombstone; executable only by ductus_retention
--   app.erasure_of           the tombstone of one subject; the same
--   app.erasure_recorded     whether a subject has a tombstone; executable
--                            only by ductus_identity, for the guard of
--                            audit.access_log
--   app.access_log_hash      private steps of erasure_append for the class
--   app.access_log_erase     access_log: lock and hash one row, then delete
--                            it; executable only by the evidence role, which
--                            owns erasure_append
--
-- The retention role (20261003210000_roles.sql) gets USAGE on schema app and
-- EXECUTE on erasure_append and erasure_of, nothing else. Neither the web role nor
-- the identity role may execute them. The identity role owns audit.access_log
-- and has no right on schema evidence, the evidence role has no right on
-- schema audit: each step runs as the owner of the table it touches.
--
-- Until 20261125100100_access_log_erasure_trigger.sql narrows the guard of
-- audit.access_log, the delete of access_log_erase is still refused (ZD403
-- append-only row) and erasure_append keeps nothing: the tombstone it wrote
-- is rolled back with the failed delete.
--
-- The data classes and reasons are closed lists; a later step (M10.2) widens
-- them in the migration that adds the class. Errors carry no input: ZD422
-- invalid input, ZD404 no such subject, ZD409 subject already erased.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
-- The retention role names the two functions; it holds no other privilege
-- in the schema (EXECUTE is granted function by function).
GRANT USAGE ON SCHEMA app TO ductus_retention;

SET LOCAL ROLE ductus_evidence;

-- The institution is the scope of the erased subject, copied from it when the
-- tombstone is written. There is no foreign key, as for audit.access_log
-- (docs/BACKEND.md 4.11): a tombstone never blocks nor follows the removal of
-- what it names. subject_id is text so that a later class may erase a subject
-- whose id is not a uuid (a document id, a version). The SHA-256 is lowercase hex, as
-- every content hash of the schema. job_id is the id of the retention job
-- (pg-boss, M10.0-S2); NULL for a run outside a job.
CREATE TABLE evidence.erasure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('access_log')),
  subject_id text NOT NULL
    CHECK (length(subject_id) BETWEEN 1 AND 256 AND subject_id = btrim(subject_id) AND subject_id !~ '[[:cntrl:]]'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('retention_expired', 'erasure_request')),
  job_id uuid,
  erased_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_class, subject_id)
);

-- Statement triggers: an UPDATE or DELETE fails even when RLS or its WHERE
-- leaves no row, so a change is never a silent no-op.
CREATE TRIGGER erasure_append_only BEFORE UPDATE OR DELETE ON evidence.erasure
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER erasure_no_truncate BEFORE TRUNCATE ON evidence.erasure
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

ALTER TABLE evidence.erasure ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.erasure FORCE ROW LEVEL SECURITY;
CREATE POLICY erasure_owner ON evidence.erasure TO ductus_evidence USING (true) WITH CHECK (true);

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The two steps of erasure_append on audit.access_log, both private to the
-- evidence role. access_log_hash locks one row for the rest of the
-- transaction and returns its institution and SHA-256, no row when there is
-- no such row; the hash is over the row as a jsonb text with the time in UTC, so it does not
-- depend on the session's time zone. access_log_erase deletes it; the guard
-- of the table (20261125100100) lets the delete through only when the row's
-- tombstone is already written.
CREATE FUNCTION app.access_log_hash(p_id uuid) RETURNS TABLE (institution_id uuid, content_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row audit.access_log;
BEGIN
  SELECT * INTO v_row FROM audit.access_log l WHERE l.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_row.institution_id, encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'id', v_row.id,
    'institution_id', v_row.institution_id,
    'document_id', v_row.document_id,
    'assignment_id', v_row.assignment_id,
    'owner_id', v_row.owner_id,
    'reader_id', v_row.reader_id,
    'reader_role', v_row.reader_role,
    'surface', v_row.surface,
    'opened_at', to_char(v_row.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text, 'UTF8')), 'hex');
END
$$;

-- Returns the number of rows deleted: 1, or 0 when there was none.
CREATE FUNCTION app.access_log_erase(p_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM audit.access_log l WHERE l.id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION app.access_log_hash(uuid), app.access_log_erase(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_log_hash(uuid), app.access_log_erase(uuid) TO ductus_evidence;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;

-- Erase one subject and write its tombstone, in one transaction: the
-- tombstone is written before the delete and the guard of the table refuses
-- a delete without one, so a row is never gone without its tombstone, and a
-- failed delete rolls the tombstone back with it. Returns the tombstone id.
CREATE FUNCTION app.erasure_append(p_data_class text, p_subject_id text, p_reason text, p_job_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_subject record;
  v_id uuid;
BEGIN
  IF p_data_class IS DISTINCT FROM 'access_log'
     OR p_reason IS NULL OR p_reason NOT IN ('retention_expired', 'erasure_request')
     OR p_subject_id IS NULL
     OR p_subject_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF EXISTS (SELECT 1 FROM evidence.erasure e WHERE e.data_class = p_data_class AND e.subject_id = p_subject_id) THEN
    RAISE EXCEPTION 'already erased' USING ERRCODE = 'ZD409';
  END IF;

  SELECT h.institution_id, h.content_sha256 INTO v_subject FROM app.access_log_hash(p_subject_id::uuid) h;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  INSERT INTO evidence.erasure (institution_id, data_class, subject_id, content_sha256, reason, job_id, erased_at)
  VALUES (v_subject.institution_id, p_data_class, p_subject_id, v_subject.content_sha256, p_reason, p_job_id, now())
  RETURNING id INTO v_id;
  IF app.access_log_erase(p_subject_id::uuid) <> 1 THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'ZD404';
  END IF;
  RETURN v_id;
END
$$;

-- The tombstone of one subject, or no row. It never says more than the
-- tombstone holds.
CREATE FUNCTION app.erasure_of(p_data_class text, p_subject_id text)
RETURNS TABLE (id uuid, institution_id uuid, data_class text, subject_id text, content_sha256 text, reason text,
               job_id uuid, erased_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.id, e.institution_id, e.data_class, e.subject_id, e.content_sha256, e.reason, e.job_id, e.erased_at
    FROM evidence.erasure e
   WHERE e.data_class = p_data_class AND e.subject_id = p_subject_id
$$;

-- For the guard of audit.access_log only, which runs as the table's owner:
-- whether the subject has a tombstone. A tombstone and the delete of its row
-- commit together, so a tombstone that this transaction can see while the row
-- is still there is the one erasure_append has just written.
CREATE FUNCTION app.erasure_recorded(p_data_class text, p_subject_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM evidence.erasure e WHERE e.data_class = p_data_class AND e.subject_id = p_subject_id)
$$;

REVOKE ALL ON FUNCTION app.erasure_append(text, text, text, uuid), app.erasure_of(text, text),
  app.erasure_recorded(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erasure_append(text, text, text, uuid), app.erasure_of(text, text) TO ductus_retention;
GRANT EXECUTE ON FUNCTION app.erasure_recorded(text, text) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.erasure_recorded(text, text);
DROP FUNCTION app.erasure_of(text, text);
DROP FUNCTION app.erasure_append(text, text, text, uuid);
DROP TABLE evidence.erasure;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.access_log_erase(uuid);
DROP FUNCTION app.access_log_hash(uuid);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE USAGE ON SCHEMA app FROM ductus_retention;
