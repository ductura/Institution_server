-- migrate:up
-- SRV-NF6-SIFRA-2 (Ductus#2055; review of SRV #676, S2;
-- docs/contracts/self-note-sealed-v1.md §4.2): starting over may name the key
-- the device holds. collaboration.delete_self_note_key() of 20261217150000
-- deletes whatever key the caller keeps, so a device that read the key before
-- another device started over (or rewrapped it) could delete a key it never
-- saw, and every note sealed under it. delete_self_note_key_checked deletes
-- only the named key, and, when a version is named, only that version of it:
-- anything else is ZD409 and changes nothing. The unchecked function stays
-- for the route of 1.110.0, whose contract cannot change (contracts:breaking).
--
--       collaboration.delete_self_note_key_checked  the owner starts over under the key (and version) named
--
-- Access is the caller's own, as delete_self_note_key: no parameter names a
-- user. Errors carry no input: ZD401 no session, ZD409 no key, another key or
-- another version, ZD422 no key named or a version under 1.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION collaboration.delete_self_note_key_checked(p_key_id uuid, p_expected_version integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  kept record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF p_key_id IS NULL OR (p_expected_version IS NOT NULL AND p_expected_version < 1) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- The key first, in the order a sealed write and delete_self_note_key take it.
  SELECT k.key_id, k.version INTO kept FROM collaboration.self_note_key k
   WHERE k.owner_id = actor.user_id AND k.institution_id = actor.institution_id
   FOR UPDATE;
  IF NOT FOUND OR kept.key_id <> p_key_id
     OR (p_expected_version IS NOT NULL AND kept.version <> p_expected_version) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  -- The same caller, the row already locked: the notes, then the key.
  RETURN collaboration.delete_self_note_key();
END
$$;

REVOKE ALL ON FUNCTION collaboration.delete_self_note_key_checked(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration.delete_self_note_key_checked(uuid, integer) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA collaboration TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION collaboration.delete_self_note_key_checked(uuid, integer);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA collaboration FROM ductus_identity;
