-- migrate:up
-- SRV-1110 (wave 11, N-18, C-16, D4): the Merlin package of an assignment.
-- The teacher of the assignment asks for a ZIP with the roster CSV of
-- SRV-1109, the PDF and DOCX of every submitted work and the fingerprints of
-- those same bytes; the server builds it once and keeps it for 24 hours
-- (C-16 "poveznica 24 h"). A repeated request with the same key is the same
-- package, never a second one. Every download is recorded, append-only, in
-- the same transaction that hands out the bytes.
--
-- Only through the RPCs: no role but the owner holds a privilege on either
-- table, and their only policies are the owner's. Who may ask, read and
-- download comes from the caller's relation to the work
-- (institution.work_relation: the teacher of the course or the mentor of the
-- mentorship, C-23) and from being the one who asked: another teacher of the
-- same course does not see a colleague's package.
--
--   institution.merlin_package           the packages; forced RLS, a guard
--                                        trigger allows only the state moves
--                                        below and nothing after ready
--   institution.merlin_package_download  every download; forced RLS,
--                                        append-only by trigger
--   institution.request_merlin_package   ask (or ask again) by request key;
--                                        claimed tells the caller to build
--   institution.complete_merlin_package  the builder stores the ZIP: queued
--                                        to ready, expires 24 hours later
--   institution.fail_merlin_package      the builder records a closed code:
--                                        queued to failed; a new request with
--                                        the same key builds again
--   institution.merlin_package_status    state, fingerprint and expiry
--   institution.download_merlin_package  the bytes of a ready package that
--                                        has not expired, and the record
--
-- States: queued, ready, failed; expired is read, never stored (a ready
-- package at or after expires_at). The institution and the author come from
-- the session, never from a parameter. Errors carry no input: ZD401 no
-- session, ZD403 no relation or not the caller's package (one answer for
-- every refusal, also for an id that does not exist), ZD409 not ready (queued
-- or failed), ZD410 expired, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.merlin_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  -- The client's idempotency key (for example a UUID it made once).
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'failed')),
  -- A closed code of the builder, never the text of an exception.
  failure_code text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- The ZIP itself; its SHA-256 is computed here, never taken from the caller.
  content bytea,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer CHECK (byte_size > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- When a builder last took the package; a queued package older than ten
  -- minutes may be taken again (the builder died).
  claimed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ready_at timestamptz,
  expires_at timestamptz,
  UNIQUE (requested_by, assignment_id, request_key),
  CHECK ((state = 'ready') = (content IS NOT NULL)),
  CHECK ((content IS NULL) = (sha256 IS NULL) AND (content IS NULL) = (byte_size IS NULL)
         AND (content IS NULL) = (ready_at IS NULL) AND (content IS NULL) = (expires_at IS NULL)),
  CHECK (expires_at = ready_at + interval '24 hours'),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (requested_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX merlin_package_assignment_idx ON institution.merlin_package (assignment_id);

CREATE TABLE institution.merlin_package_download (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  package_id uuid NOT NULL REFERENCES institution.merlin_package (id),
  assignment_id uuid NOT NULL,
  downloaded_by uuid NOT NULL,
  -- The fingerprint of the bytes handed out.
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  downloaded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (downloaded_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX merlin_package_download_package_idx ON institution.merlin_package_download (package_id);
CREATE INDEX merlin_package_download_assignment_idx ON institution.merlin_package_download (assignment_id);
CREATE INDEX merlin_package_download_reader_idx ON institution.merlin_package_download (downloaded_by);

ALTER TABLE institution.merlin_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.merlin_package FORCE ROW LEVEL SECURITY;
CREATE POLICY merlin_package_owner ON institution.merlin_package TO ductus_identity USING (true) WITH CHECK (true);
ALTER TABLE institution.merlin_package_download ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.merlin_package_download FORCE ROW LEVEL SECURITY;
CREATE POLICY merlin_package_download_owner ON institution.merlin_package_download TO ductus_identity
  USING (true) WITH CHECK (true);

-- The moves of a package: queued -> ready | failed | queued (taken again),
-- failed -> queued. Who asked, for what and when never changes; a ready
-- package never changes and no package is removed (the retention of expired
-- packages changes this guard in its own migration).
CREATE FUNCTION institution.guard_merlin_package() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.state = 'ready'
     OR (OLD.state = 'failed' AND NEW.state <> 'queued') THEN
    RAISE EXCEPTION 'merlin package change refused' USING ERRCODE = 'ZD403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merlin_package_guard BEFORE UPDATE OR DELETE ON institution.merlin_package
  FOR EACH ROW EXECUTE FUNCTION institution.guard_merlin_package();
CREATE TRIGGER merlin_package_no_truncate BEFORE TRUNCATE ON institution.merlin_package
  FOR EACH STATEMENT EXECUTE FUNCTION institution.guard_merlin_package();

CREATE FUNCTION institution.refuse_merlin_package_download_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'merlin package download is append-only' USING ERRCODE = 'ZD403';
END
$$;
CREATE TRIGGER merlin_package_download_immutable BEFORE UPDATE OR DELETE ON institution.merlin_package_download
  FOR EACH ROW EXECUTE FUNCTION institution.refuse_merlin_package_download_change();
CREATE TRIGGER merlin_package_download_no_truncate BEFORE TRUNCATE ON institution.merlin_package_download
  FOR EACH STATEMENT EXECUTE FUNCTION institution.refuse_merlin_package_download_change();

-- The caller's package p_package_id of p_assignment_id, locked, while the
-- caller still teaches the work; else ZD403. No grant: only the definer
-- functions below call it.
CREATE FUNCTION institution.own_merlin_package(p_assignment_id uuid, p_package_id uuid)
RETURNS institution.merlin_package
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_row institution.merlin_package;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  SELECT p.* INTO v_row FROM institution.merlin_package p
   WHERE p.id = p_package_id AND p.assignment_id = p_assignment_id
     AND p.institution_id = v_institution AND p.requested_by = v_user
     FOR UPDATE;
  IF NOT FOUND OR institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN v_row;
END
$$;

-- The state as read: a ready package at or after its expiry is expired.
CREATE FUNCTION institution.merlin_package_state(p_state text, p_expires_at timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_state = 'ready' AND statement_timestamp() >= p_expires_at THEN 'expired' ELSE p_state END
$$;

-- The teacher of the assignment asks for its package with a request key. A
-- new key makes a queued package the caller must build (claimed). The same
-- key again is the same package: claimed again only when it failed or a
-- builder took it more than ten minutes ago and never finished.
CREATE FUNCTION institution.request_merlin_package(p_assignment_id uuid, p_request_key text)
RETURNS TABLE (id uuid, state text, claimed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
  v_id uuid;
  v_row institution.merlin_package;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9_-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  INSERT INTO institution.merlin_package AS p (institution_id, assignment_id, requested_by, request_key)
  SELECT v_institution, a.id, v_user, p_request_key
    FROM institution.assignment a WHERE a.id = p_assignment_id AND a.institution_id = v_institution
  ON CONFLICT (requested_by, assignment_id, request_key) DO NOTHING
  RETURNING p.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'queued'::text, true;
    RETURN;
  END IF;
  SELECT p.* INTO v_row FROM institution.merlin_package p
   WHERE p.requested_by = v_user AND p.assignment_id = p_assignment_id AND p.request_key = p_request_key
     AND p.institution_id = v_institution
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF v_row.state = 'failed'
     OR (v_row.state = 'queued' AND v_row.claimed_at < statement_timestamp() - interval '10 minutes') THEN
    UPDATE institution.merlin_package p
       SET state = 'queued', failure_code = NULL, claimed_at = statement_timestamp()
     WHERE p.id = v_row.id;
    RETURN QUERY SELECT v_row.id, 'queued'::text, true;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_row.id, institution.merlin_package_state(v_row.state, v_row.expires_at), false;
END
$$;

-- The builder stores the ZIP of a queued package of the caller's: at most
-- 64 MiB, a ZIP by its first bytes. The fingerprint is computed here and
-- returned, so the builder can compare it with its own before the commit.
CREATE FUNCTION institution.complete_merlin_package(p_assignment_id uuid, p_package_id uuid, p_content bytea)
RETURNS TABLE (id uuid, state text, sha256 text, byte_size integer, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row institution.merlin_package;
BEGIN
  v_row := institution.own_merlin_package(p_assignment_id, p_package_id);
  IF p_content IS NULL OR length(p_content) < 22 OR length(p_content) > 67108864
     OR substr(p_content, 1, 4) <> '\x504b0304'::bytea THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF v_row.state <> 'queued' THEN
    RAISE EXCEPTION 'not queued' USING ERRCODE = 'ZD409';
  END IF;
  RETURN QUERY
    UPDATE institution.merlin_package p
       SET state = 'ready', content = p_content, sha256 = encode(pg_catalog.sha256(p_content), 'hex'),
           byte_size = length(p_content), ready_at = statement_timestamp(),
           expires_at = statement_timestamp() + interval '24 hours'
     WHERE p.id = v_row.id
    RETURNING p.id, p.state, p.sha256, p.byte_size, p.expires_at;
END
$$;

-- The builder records why a queued package of the caller's could not be built.
CREATE FUNCTION institution.fail_merlin_package(p_assignment_id uuid, p_package_id uuid, p_code text)
RETURNS TABLE (id uuid, state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row institution.merlin_package;
BEGIN
  v_row := institution.own_merlin_package(p_assignment_id, p_package_id);
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF v_row.state <> 'queued' THEN
    RAISE EXCEPTION 'not queued' USING ERRCODE = 'ZD409';
  END IF;
  RETURN QUERY
    UPDATE institution.merlin_package p SET state = 'failed', failure_code = p_code
     WHERE p.id = v_row.id
    RETURNING p.id, p.state;
END
$$;

-- The state of the caller's package; the fingerprint and the expiry once
-- built. Writes nothing.
CREATE FUNCTION institution.merlin_package_status(p_assignment_id uuid, p_package_id uuid)
RETURNS TABLE (id uuid, state text, sha256 text, byte_size integer, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF institution.work_relation(v_user, p_assignment_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT p.id, institution.merlin_package_state(p.state, p.expires_at), p.sha256, p.byte_size, p.expires_at
      FROM institution.merlin_package p
     WHERE p.id = p_package_id AND p.assignment_id = p_assignment_id
       AND p.institution_id = v_institution AND p.requested_by = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
END
$$;

-- The bytes of the caller's ready package before its expiry, with the
-- record of the download written in the same transaction.
CREATE FUNCTION institution.download_merlin_package(p_assignment_id uuid, p_package_id uuid)
RETURNS TABLE (content bytea, sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row institution.merlin_package;
BEGIN
  v_row := institution.own_merlin_package(p_assignment_id, p_package_id);
  IF v_row.state <> 'ready' THEN
    RAISE EXCEPTION 'not ready' USING ERRCODE = 'ZD409';
  END IF;
  IF statement_timestamp() >= v_row.expires_at THEN
    RAISE EXCEPTION 'expired' USING ERRCODE = 'ZD410';
  END IF;
  INSERT INTO institution.merlin_package_download (institution_id, package_id, assignment_id, downloaded_by, sha256)
  VALUES (v_row.institution_id, v_row.id, v_row.assignment_id, v_row.requested_by, v_row.sha256);
  RETURN QUERY SELECT v_row.content, v_row.sha256;
END
$$;

REVOKE ALL ON FUNCTION institution.guard_merlin_package() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.refuse_merlin_package_download_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.own_merlin_package(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.merlin_package_state(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.request_merlin_package(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.complete_merlin_package(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.fail_merlin_package(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.merlin_package_status(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION institution.download_merlin_package(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.request_merlin_package(uuid, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.complete_merlin_package(uuid, uuid, bytea) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.fail_merlin_package(uuid, uuid, text) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.merlin_package_status(uuid, uuid) TO ductus_app;
GRANT EXECUTE ON FUNCTION institution.download_merlin_package(uuid, uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION institution.download_merlin_package(uuid, uuid);
DROP FUNCTION institution.merlin_package_status(uuid, uuid);
DROP FUNCTION institution.fail_merlin_package(uuid, uuid, text);
DROP FUNCTION institution.complete_merlin_package(uuid, uuid, bytea);
DROP FUNCTION institution.request_merlin_package(uuid, text);
DROP FUNCTION institution.merlin_package_state(text, timestamptz);
DROP FUNCTION institution.own_merlin_package(uuid, uuid);
DROP TABLE institution.merlin_package_download;
DROP TABLE institution.merlin_package;
DROP FUNCTION institution.refuse_merlin_package_download_change();
DROP FUNCTION institution.guard_merlin_package();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
