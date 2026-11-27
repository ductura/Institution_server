-- SRV-KOD-POTVRDE (Ductus#2059, S-08): the server issues and stores a
-- "Kod potvrde" when a submission receipt is bound: 16 characters in 4 groups
-- from the alphabet without I, L, O and U (e.g. DK7M-4Q9P-X2HT-R8VN). A
-- submission still waiting for its signature (ceka) has no code. No J-02 code
-- existed before (the page /kako-radi is static), so this is the first issue.
--
-- evidence.submission_confirmation_code: one row per bound receipt, written
-- only by the trigger below, append-only, no grant for the web role. It is read
-- through app.my_submission_confirmation_code (the student of the assignment;
-- anyone else gets not_found, C-23). Existing bound receipts are backfilled.
-- migrate:up
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_identity, ductus_evidence;
GRANT CREATE ON SCHEMA evidence TO ductus_evidence;
GRANT ductus_evidence TO ductus_identity WITH INHERIT FALSE, SET TRUE;

SET LOCAL ROLE ductus_evidence;

CREATE TABLE evidence.submission_confirmation_code (
  -- No foreign key: the trigger on evidence.submission_receipt is the only writer,
  -- and a key would make the receipts' own append-only TRUNCATE guards unreachable.
  submission_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  code text NOT NULL UNIQUE
    CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$'),
  issued_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE evidence.submission_confirmation_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.submission_confirmation_code FORCE ROW LEVEL SECURITY;
CREATE POLICY submission_confirmation_code_owner ON evidence.submission_confirmation_code
  TO ductus_evidence USING (true) WITH CHECK (true);
CREATE TRIGGER submission_confirmation_code_immutable
  BEFORE UPDATE OR DELETE ON evidence.submission_confirmation_code
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_append_only_change();
CREATE TRIGGER submission_confirmation_code_no_truncate
  BEFORE TRUNCATE ON evidence.submission_confirmation_code
  FOR EACH STATEMENT EXECUTE FUNCTION evidence.reject_append_only_change();

-- 16 symbols of 5 random bits each (80 bits) from a hashed pair of random uuids;
-- 256 is a multiple of 32, so the mapping has no bias.
CREATE FUNCTION evidence.new_confirmation_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := pg_catalog.sha256(
    pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()));
  v_code text := '';
BEGIN
  FOR i IN 0..15 LOOP
    IF i IN (4, 8, 12) THEN v_code := v_code || '-'; END IF;
    v_code := v_code || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) & 31) + 1, 1);
  END LOOP;
  RETURN v_code;
END
$$;

CREATE FUNCTION evidence.issue_confirmation_code() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_done boolean := false;
BEGIN
  FOR attempt IN 1..5 LOOP
    INSERT INTO evidence.submission_confirmation_code (submission_id, institution_id, principal_id, code)
    VALUES (NEW.submission_id, NEW.institution_id, NEW.principal_id, evidence.new_confirmation_code())
    ON CONFLICT (code) DO NOTHING;
    IF FOUND THEN v_done := true; EXIT; END IF;
  END LOOP;
  IF NOT v_done THEN
    RAISE EXCEPTION 'confirmation code not issued' USING ERRCODE = 'ZD500';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION evidence.new_confirmation_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION evidence.issue_confirmation_code() FROM PUBLIC;

CREATE TRIGGER submission_receipt_issue_confirmation_code
  AFTER INSERT ON evidence.submission_receipt
  FOR EACH ROW EXECUTE FUNCTION evidence.issue_confirmation_code();

-- Receipts bound before this migration get a code as well.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT submission_id, institution_id, principal_id FROM evidence.submission_receipt LOOP
    LOOP
      INSERT INTO evidence.submission_confirmation_code (submission_id, institution_id, principal_id, code)
      VALUES (r.submission_id, r.institution_id, r.principal_id, evidence.new_confirmation_code())
      ON CONFLICT (code) DO NOTHING;
      EXIT WHEN FOUND;
    END LOOP;
  END LOOP;
END
$$;

-- The code of the live (not withdrawn) submission whose receipt is bound, or NULL.
CREATE FUNCTION app.submission_confirmation_code_of(p_assignment_id uuid, p_student_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.code
    FROM app.current_actor() a
    JOIN evidence.submission x
      ON x.assignment_id = p_assignment_id AND x.institution_id = a.institution_id
     AND x.principal_id = p_student_id AND NOT evidence.submission_withdrawn(x.id)
    JOIN evidence.submission_confirmation_code c
      ON c.submission_id = x.id AND c.institution_id = x.institution_id AND c.principal_id = x.principal_id
   WHERE a.institution_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.submission_confirmation_code_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submission_confirmation_code_of(uuid, uuid) TO ductus_identity;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

-- The caller's own code. outcome not_found: not a student of the assignment
-- (a teacher, a removed student, anyone else, an unknown id); found with code
-- NULL: no submission, a withdrawn one, or one still waiting for its receipt.
CREATE FUNCTION app.my_submission_confirmation_code(p_assignment_id uuid)
RETURNS TABLE (outcome text, code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_user, v_institution FROM institution.require_actor() r;
  IF p_assignment_id IS NULL
     OR collaboration.actor_role(v_institution, p_assignment_id, v_user) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text, app.submission_confirmation_code_of(p_assignment_id, v_user);
END
$$;
REVOKE ALL ON FUNCTION app.my_submission_confirmation_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_submission_confirmation_code(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity, ductus_evidence;
REVOKE CREATE ON SCHEMA evidence FROM ductus_evidence;
REVOKE ductus_evidence FROM ductus_identity;

-- migrate:down
-- Forward only (docs/BACKEND.md §6): a stored code is shown to a student and
-- must not be dropped; a local database is made again with db:up.
DO $$
BEGIN
  RAISE EXCEPTION 'SRV-KOD-POTVRDE (20261220530000) does not go down; recreate the local database';
END
$$;
