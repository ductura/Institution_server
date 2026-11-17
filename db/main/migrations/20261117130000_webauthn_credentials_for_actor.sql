-- migrate:up
-- DAN-840-3a (contract on Ductus#1836; orchestrator's order on
-- ductura/server#208): the WebAuthn credentials of the caller, for the routes
-- of 840-3b. The challenge lists them as allowCredentials, and an assertion
-- picks its row by id to check the signature against the stored COSE key and
-- counter. ductus_app has no right on identity.webauthn_credential, so the
-- keys reach the web process only through this function.
--
-- Person and institution come from the session; there is no parameter. Only
-- credentials that are not revoked, of the caller's account in the caller's
-- institution; another account's credential is simply not in the list (C-23:
-- another's is nonexistent), never an error. ZD401 without a live session
-- (app.current_actor() returns no row for a closed, expired, idle or unknown
-- one). The function only reads, in one statement: no lock, so it never waits
-- on an open use, and a concurrent write is seen whole or not at all. The last
-- word on the counter stays with identity.use_webauthn_credential.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION identity.webauthn_credentials_for_actor()
RETURNS TABLE (credential_id bytea, public_key bytea, sign_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
    SELECT c.credential_id, c.public_key, c.sign_count
      FROM identity.webauthn_credential c
     WHERE c.user_id = v_user AND c.institution_id = v_institution AND c.revoked_at IS NULL
     ORDER BY c.created_at, c.id;
END
$$;
REVOKE ALL ON FUNCTION identity.webauthn_credentials_for_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.webauthn_credentials_for_actor() TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.webauthn_credentials_for_actor();
SET LOCAL ROLE ductus_migrator;
