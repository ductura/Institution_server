-- migrate:up
-- DAN-838-2b (contract on Ductus#1836): one registration of a WebAuthn
-- credential, after the route has verified the attestation (not here). The
-- person and institution come from the session; neither is a parameter.
--
-- The table's constraints answer for the input; their SQLSTATEs map to ZD
-- codes by constraint name, and anything else is raised unchanged.
--   no session                                       ZD401
--   REPEATABLE READ or SERIALIZABLE                  25000
--   the account holds a credential not revoked       ZD403 second factor required
--   the account is gone (23503 of the account key)   ZD403 account not found
--   the credential id exists, revoked or not, any    ZD409
--     account's (23505; WebAuthn Level 3, 7.1)
--   NULL, or outside the bounds of the table         ZD422
--     (23502, 23514)
--
-- Beside a credential that is not revoked nothing is added until the
-- ceremony (DAN-840) can prove a second factor in the session; otherwise a
-- stolen session adds its own authenticator. The account row is locked first,
-- so two first registrations at the same time are one after the other and the
-- second sees the first.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION identity.add_webauthn_credential(p_credential_id bytea, p_public_key bytea, p_sign_count bigint)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_id uuid;
  v_constraint text;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  -- The lock below orders two registrations only if the check after it takes
  -- a fresh snapshot; under REPEATABLE READ both could miss each other.
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'read committed required' USING ERRCODE = '25000';
  END IF;
  -- No row is no error here: a missing account answers through 23503 below.
  PERFORM 1 FROM identity.user_account u
   WHERE u.id = v_user AND u.institution_id = v_institution FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM identity.webauthn_credential c
              WHERE c.user_id = v_user AND c.institution_id = v_institution AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'second factor required' USING ERRCODE = 'ZD403';
  END IF;

  BEGIN
    INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count)
    VALUES (v_user, v_institution, p_credential_id, p_public_key, p_sign_count)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation OR foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'webauthn_credential_credential_id_key' THEN
        RAISE EXCEPTION 'credential already registered' USING ERRCODE = 'ZD409';
      ELSIF v_constraint = 'webauthn_credential_user_id_institution_id_fkey' THEN
        RAISE EXCEPTION 'account not found' USING ERRCODE = 'ZD403';
      END IF;
      RAISE;
    WHEN check_violation OR not_null_violation THEN
      RAISE EXCEPTION 'invalid credential' USING ERRCODE = 'ZD422';
  END;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION identity.add_webauthn_credential(bytea, bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.add_webauthn_credential(bytea, bytea, bigint) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.add_webauthn_credential(bytea, bytea, bigint);
SET LOCAL ROLE ductus_migrator;
