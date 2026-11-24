-- migrate:up
-- SRV-NF6-SIFRA (Ductus#2055; owner decision of 24 Nov 2026 on c.7119843989,
-- "1. B2 2. Da 3B"; docs/contracts/self-note-sealed-v1.md): the note to self
-- of 20261217100000 is sealed on the student's device. The server and this
-- database keep only a ciphertext of fixed length and the wrapped key, never
-- the text, the place of the note, the phrase, the recovery code or the key.
--
-- (a) collaboration.self_note_key: one row per student and institution, the
--     random note key (AES-256-GCM, made on the device) wrapped twice, by a
--     key derived from a phrase the application generates and by one derived
--     from a recovery code it also generates (PBKDF2-SHA-256). Fixed lengths:
--     salt 16, iv 12, wrapped key 32 + 16 bytes of the GCM tag. The key id
--     never changes; a new phrase rewraps the same key and raises version,
--     which a writer must name (two devices cannot overwrite each other).
-- (b) collaboration.work_self_note: note_text and note_place go; the note is
--     note_key_id, note_iv (12 bytes) and note_ct (exactly 1296 bytes: 1280
--     bytes of JCS({text, place}) padded with zeros, and the GCM tag). The
--     reading place ("Dokle sam stao") stays as it was, not sealed. The notes
--     kept so far (invented data only, no real student) are deleted here:
--     the server has no key to seal them with.
--
--       collaboration.get_self_note_key          the owner reads the wrapped key
--       collaboration.put_self_note_key          the owner sets it, or rewraps it under a version
--       collaboration.delete_self_note_key       the owner starts over: the key and every sealed note go
--       collaboration.get_work_self_note         (again) the owner reads the sealed note and the reading place
--       collaboration.set_work_sealed_self_note  the owner writes a sealed note under the current key
--       collaboration.set_work_reading_place     (again, new return type)
--       collaboration.clear_work_self_note       (again, new return type)
--
-- collaboration.set_work_self_note and is_self_note_text (the text in the
-- clear) are dropped: nothing writes a note in the clear any more.
-- Access is the owner's alone, as before: the key is the caller's own (no
-- parameter names a user); writing a note needs the student owner of the work
-- (self_note_scope); reading and deleting it also the author of a kept note
-- who no longer holds the student role (self_note_owner_scope,
-- 20261217120000). Errors carry no input: ZD401 no session, ZD403 not the
-- owner, ZD409 a key that is not there, is already there, or is not the one
-- named (or its version is not), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE collaboration.self_note_key (
  institution_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  key_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  kdf_iterations integer NOT NULL CHECK (kdf_iterations BETWEEN 600000 AND 10000000),
  phrase_salt bytea NOT NULL CHECK (octet_length(phrase_salt) = 16),
  phrase_iv bytea NOT NULL CHECK (octet_length(phrase_iv) = 12),
  phrase_ct bytea NOT NULL CHECK (octet_length(phrase_ct) = 48),
  recovery_salt bytea NOT NULL CHECK (octet_length(recovery_salt) = 16),
  recovery_iv bytea NOT NULL CHECK (octet_length(recovery_iv) = 12),
  recovery_ct bytea NOT NULL CHECK (octet_length(recovery_ct) = 48),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (owner_id, institution_id),
  UNIQUE (key_id, owner_id, institution_id),
  FOREIGN KEY (owner_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  -- The two wraps never share a salt.
  CHECK (phrase_salt <> recovery_salt)
);
ALTER TABLE collaboration.self_note_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration.self_note_key FORCE ROW LEVEL SECURITY;
CREATE POLICY self_note_key_owner ON collaboration.self_note_key TO ductus_identity USING (true) WITH CHECK (true);

-- The notes in the clear go; a row left with only a reading place stays.
DELETE FROM collaboration.work_self_note WHERE reading_place IS NULL;
UPDATE collaboration.work_self_note SET note_text = NULL, note_place = NULL, note_updated_at = NULL
 WHERE note_text IS NOT NULL;
-- Dropping the columns drops the checks that name them.
ALTER TABLE collaboration.work_self_note DROP COLUMN note_text, DROP COLUMN note_place;
ALTER TABLE collaboration.work_self_note
  ADD COLUMN note_key_id uuid,
  ADD COLUMN note_iv bytea CHECK (note_iv IS NULL OR octet_length(note_iv) = 12),
  ADD COLUMN note_ct bytea CHECK (note_ct IS NULL OR octet_length(note_ct) = 1296),
  ADD CONSTRAINT work_self_note_sealed_whole CHECK (
    (note_key_id IS NULL) = (note_iv IS NULL) AND (note_iv IS NULL) = (note_ct IS NULL)
    AND (note_ct IS NULL) = (note_updated_at IS NULL)),
  -- A row with nothing in it is deleted, never kept.
  ADD CONSTRAINT work_self_note_not_empty CHECK (note_ct IS NOT NULL OR reading_place IS NOT NULL),
  -- A sealed note is under its owner's key; the key goes only after its notes.
  ADD CONSTRAINT work_self_note_key_fkey FOREIGN KEY (note_key_id, owner_id, institution_id)
    REFERENCES collaboration.self_note_key (key_id, owner_id, institution_id);

DROP FUNCTION collaboration.clear_work_self_note(text, text);
DROP FUNCTION collaboration.set_work_reading_place(text, jsonb);
DROP FUNCTION collaboration.set_work_self_note(text, text, jsonb);
DROP FUNCTION collaboration.get_work_self_note(text);
DROP FUNCTION collaboration.is_self_note_text(text);

-- The caller's own key: ZD401 without a session; no parameter names a user.
CREATE FUNCTION collaboration.get_self_note_key()
RETURNS TABLE (key_id uuid, version integer, kdf_iterations integer,
               phrase_salt bytea, phrase_iv bytea, phrase_ct bytea,
               recovery_salt bytea, recovery_iv bytea, recovery_ct bytea, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  RETURN QUERY
    SELECT k.key_id, k.version, k.kdf_iterations, k.phrase_salt, k.phrase_iv, k.phrase_ct,
           k.recovery_salt, k.recovery_iv, k.recovery_ct, k.updated_at
      FROM collaboration.self_note_key k
     WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id;
END
$$;

-- Sets the caller's key (p_expected_version NULL: only when there is none) or
-- rewraps it (p_expected_version the current version, p_key_id the same key).
-- Anything else is ZD409 and changes nothing.
CREATE FUNCTION collaboration.put_self_note_key(
  p_key_id uuid, p_expected_version integer, p_kdf_iterations integer,
  p_phrase_salt bytea, p_phrase_iv bytea, p_phrase_ct bytea,
  p_recovery_salt bytea, p_recovery_iv bytea, p_recovery_ct bytea)
RETURNS TABLE (key_id uuid, version integer, kdf_iterations integer,
               phrase_salt bytea, phrase_iv bytea, phrase_ct bytea,
               recovery_salt bytea, recovery_iv bytea, recovery_ct bytea, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  kept record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- Checked before the table constraints, whose errors would quote the row.
  IF p_key_id IS NULL OR p_kdf_iterations IS NULL OR p_kdf_iterations NOT BETWEEN 600000 AND 10000000
     OR (p_expected_version IS NOT NULL AND p_expected_version < 1)
     OR coalesce(octet_length(p_phrase_salt) <> 16, true) OR coalesce(octet_length(p_phrase_iv) <> 12, true)
     OR coalesce(octet_length(p_phrase_ct) <> 48, true) OR coalesce(octet_length(p_recovery_salt) <> 16, true)
     OR coalesce(octet_length(p_recovery_iv) <> 12, true) OR coalesce(octet_length(p_recovery_ct) <> 48, true)
     OR p_phrase_salt = p_recovery_salt THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT k.key_id, k.version INTO kept FROM collaboration.self_note_key k
   WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id
   FOR UPDATE;
  IF p_expected_version IS NULL THEN
    IF FOUND THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    INSERT INTO collaboration.self_note_key AS k
      (institution_id, owner_id, key_id, version, kdf_iterations, phrase_salt, phrase_iv, phrase_ct,
       recovery_salt, recovery_iv, recovery_ct)
    VALUES (actor.institution_id, actor.user_id, p_key_id, 1, p_kdf_iterations, p_phrase_salt, p_phrase_iv,
            p_phrase_ct, p_recovery_salt, p_recovery_iv, p_recovery_ct)
    -- A concurrent first set of the same caller: one wins, the other is ZD409.
    ON CONFLICT (owner_id, institution_id) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
  ELSE
    IF NOT FOUND OR kept.key_id <> p_key_id OR kept.version <> p_expected_version THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
    END IF;
    UPDATE collaboration.self_note_key k
       SET version = k.version + 1, kdf_iterations = p_kdf_iterations,
           phrase_salt = p_phrase_salt, phrase_iv = p_phrase_iv, phrase_ct = p_phrase_ct,
           recovery_salt = p_recovery_salt, recovery_iv = p_recovery_iv, recovery_ct = p_recovery_ct,
           updated_at = statement_timestamp()
     WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id;
  END IF;
  RETURN QUERY SELECT * FROM collaboration.get_self_note_key();
END
$$;

-- "Počni ispočetka" after both secrets are lost: the caller's sealed notes on
-- every work go, then the key, in one transaction. Reading places stay.
-- Answers whether a key was there; deleting nothing changes nothing.
CREATE FUNCTION collaboration.delete_self_note_key() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- The key first, in the order a sealed write takes it: no deadlock with one.
  PERFORM 1 FROM collaboration.self_note_key k
    WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id
    FOR UPDATE;
  DELETE FROM collaboration.work_self_note n
   WHERE n.owner_id = actor.user_id AND n.institution_id = actor.institution_id AND n.reading_place IS NULL;
  UPDATE collaboration.work_self_note n
     SET note_key_id = NULL, note_iv = NULL, note_ct = NULL, note_updated_at = NULL
   WHERE n.owner_id = actor.user_id AND n.institution_id = actor.institution_id AND n.note_ct IS NOT NULL;
  DELETE FROM collaboration.self_note_key k
   WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id;
  RETURN FOUND;
END
$$;

-- The owner's sealed note and reading place on a work: no row when neither is
-- kept. Read through the owner scope of 20261217120000, as before.
CREATE FUNCTION collaboration.get_work_self_note(p_document_id text)
RETURNS TABLE (note_key_id uuid, note_iv bytea, note_ct bytea, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  RETURN QUERY
    SELECT n.note_key_id, n.note_iv, n.note_ct, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;

-- The owner writes a sealed note, replacing the earlier one, under the key
-- the owner keeps now (ZD409 when there is none or it is another).
CREATE FUNCTION collaboration.set_work_sealed_self_note(p_document_id text, p_key_id uuid, p_iv bytea, p_ct bytea)
RETURNS TABLE (note_key_id uuid, note_iv bytea, note_ct bytea, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF p_key_id IS NULL OR coalesce(octet_length(p_iv) <> 12, true) OR coalesce(octet_length(p_ct) <> 1296, true) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- FOR SHARE: a concurrent delete_self_note_key waits for this write.
  PERFORM 1 FROM collaboration.self_note_key k
    WHERE k.owner_id = v_scope.owner_id AND k.institution_id = v_scope.institution_id AND k.key_id = p_key_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, note_key_id, note_iv, note_ct, note_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_key_id, p_iv, p_ct, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET note_key_id = EXCLUDED.note_key_id, note_iv = EXCLUDED.note_iv, note_ct = EXCLUDED.note_ct,
        note_updated_at = EXCLUDED.note_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;

-- The owner writes the reading place ("Dokle sam stao"), replacing the earlier one.
CREATE FUNCTION collaboration.set_work_reading_place(p_document_id text, p_place jsonb)
RETURNS TABLE (note_key_id uuid, note_iv bytea, note_ct bytea, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF NOT collaboration.is_work_place(p_place) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, reading_place, reading_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_place, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET reading_place = EXCLUDED.reading_place, reading_updated_at = EXCLUDED.reading_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;

-- The owner deletes the note ('note') or the reading place ('reading'); a row
-- left with nothing goes. Deleting what is not there changes nothing. Through
-- the owner scope of 20261217120000, and the answer is read here, as there.
CREATE FUNCTION collaboration.clear_work_self_note(p_document_id text, p_part text)
RETURNS TABLE (note_key_id uuid, note_iv bytea, note_ct bytea, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  IF p_part IS NULL OR p_part NOT IN ('note', 'reading') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  DELETE FROM collaboration.work_self_note n
   WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id
     AND CASE p_part WHEN 'note' THEN n.reading_place IS NULL ELSE n.note_ct IS NULL END;
  IF p_part = 'note' THEN
    UPDATE collaboration.work_self_note n
       SET note_key_id = NULL, note_iv = NULL, note_ct = NULL, note_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  ELSE
    UPDATE collaboration.work_self_note n SET reading_place = NULL, reading_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  END IF;
  RETURN QUERY
    SELECT n.note_key_id, n.note_iv, n.note_ct, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;

REVOKE ALL ON FUNCTION
  collaboration.get_self_note_key(),
  collaboration.put_self_note_key(uuid, integer, integer, bytea, bytea, bytea, bytea, bytea, bytea),
  collaboration.delete_self_note_key(),
  collaboration.get_work_self_note(text),
  collaboration.set_work_sealed_self_note(text, uuid, bytea, bytea),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.get_self_note_key(),
  collaboration.put_self_note_key(uuid, integer, integer, bytea, bytea, bytea, bytea, bytea, bytea),
  collaboration.delete_self_note_key(),
  collaboration.get_work_self_note(text),
  collaboration.set_work_sealed_self_note(text, uuid, bytea, bytea),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- The sealed notes cannot be opened here, so they go; the functions in the
-- clear of 20261217100000 come back.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.clear_work_self_note(text, text);
DROP FUNCTION collaboration.set_work_reading_place(text, jsonb);
DROP FUNCTION collaboration.set_work_sealed_self_note(text, uuid, bytea, bytea);
DROP FUNCTION collaboration.get_work_self_note(text);
DROP FUNCTION collaboration.delete_self_note_key();
DROP FUNCTION collaboration.put_self_note_key(uuid, integer, integer, bytea, bytea, bytea, bytea, bytea, bytea);
DROP FUNCTION collaboration.get_self_note_key();
DELETE FROM collaboration.work_self_note WHERE reading_place IS NULL;
ALTER TABLE collaboration.work_self_note
  DROP CONSTRAINT work_self_note_key_fkey,
  DROP CONSTRAINT work_self_note_not_empty,
  DROP CONSTRAINT work_self_note_sealed_whole;
UPDATE collaboration.work_self_note SET note_updated_at = NULL;
ALTER TABLE collaboration.work_self_note DROP COLUMN note_key_id, DROP COLUMN note_iv, DROP COLUMN note_ct;
DROP TABLE collaboration.self_note_key;
CREATE FUNCTION collaboration.is_self_note_text(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(collaboration.is_comment_body(p_text) AND char_length(p_text) <= 280, false)
$$;
ALTER TABLE collaboration.work_self_note
  ADD COLUMN note_text text CHECK (note_text IS NULL OR collaboration.is_self_note_text(note_text)),
  ADD COLUMN note_place jsonb CHECK (note_place IS NULL OR collaboration.is_work_place(note_place)),
  ADD CHECK ((note_text IS NULL) = (note_updated_at IS NULL)),
  ADD CHECK (note_text IS NOT NULL OR note_place IS NULL),
  ADD CHECK (note_text IS NOT NULL OR reading_place IS NOT NULL);
CREATE FUNCTION collaboration.get_work_self_note(p_document_id text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  RETURN QUERY
    SELECT n.note_text, n.note_place, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;
CREATE FUNCTION collaboration.set_work_self_note(p_document_id text, p_text text, p_place jsonb)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF NOT collaboration.is_self_note_text(p_text)
     OR (p_place IS NOT NULL AND NOT collaboration.is_work_place(p_place)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, note_text, note_place, note_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_text, p_place, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET note_text = EXCLUDED.note_text, note_place = EXCLUDED.note_place, note_updated_at = EXCLUDED.note_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;
CREATE FUNCTION collaboration.set_work_reading_place(p_document_id text, p_place jsonb)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_scope record;
BEGIN
  SELECT * INTO v_scope FROM collaboration.self_note_scope(p_document_id);
  IF NOT collaboration.is_work_place(p_place) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  INSERT INTO collaboration.work_self_note AS n
    (institution_id, document_id, owner_id, reading_place, reading_updated_at)
  VALUES (v_scope.institution_id, p_document_id, v_scope.owner_id, p_place, statement_timestamp())
  ON CONFLICT (document_id, institution_id) DO UPDATE
    SET reading_place = EXCLUDED.reading_place, reading_updated_at = EXCLUDED.reading_updated_at;
  RETURN QUERY SELECT * FROM collaboration.get_work_self_note(p_document_id);
END
$$;
CREATE FUNCTION collaboration.clear_work_self_note(p_document_id text, p_part text)
RETURNS TABLE (note_text text, note_place jsonb, note_updated_at timestamptz,
               reading_place jsonb, reading_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution_id uuid;
BEGIN
  v_institution_id := collaboration.self_note_owner_scope(p_document_id);
  IF p_part IS NULL OR p_part NOT IN ('note', 'reading') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  DELETE FROM collaboration.work_self_note n
   WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id
     AND CASE p_part WHEN 'note' THEN n.reading_place IS NULL ELSE n.note_text IS NULL END;
  IF p_part = 'note' THEN
    UPDATE collaboration.work_self_note n SET note_text = NULL, note_place = NULL, note_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  ELSE
    UPDATE collaboration.work_self_note n SET reading_place = NULL, reading_updated_at = NULL
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
  END IF;
  RETURN QUERY
    SELECT n.note_text, n.note_place, n.note_updated_at, n.reading_place, n.reading_updated_at
      FROM collaboration.work_self_note n
     WHERE n.document_id = p_document_id AND n.institution_id = v_institution_id;
END
$$;
REVOKE ALL ON FUNCTION
  collaboration.is_self_note_text(text),
  collaboration.get_work_self_note(text),
  collaboration.set_work_self_note(text, text, jsonb),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  collaboration.get_work_self_note(text),
  collaboration.set_work_self_note(text, text, jsonb),
  collaboration.set_work_reading_place(text, jsonb),
  collaboration.clear_work_self_note(text, text)
TO ductus_app;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
