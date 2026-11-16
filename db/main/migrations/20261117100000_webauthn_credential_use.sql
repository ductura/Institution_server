-- migrate:up
-- DAN-838-2a (contract on Ductus#1836): one use of a WebAuthn credential,
-- after the route has verified the assertion's signature (not here). The
-- person and institution come from the session; neither is a parameter.
--
-- The signature counter never falls. A new counter is accepted when it is
-- above the stored one, or when both are 0: WebAuthn Level 3, 7.2, checks
-- the counter only "if authData.signCount is nonzero or storedSignCount is
-- nonzero", since an authenticator without a counter (a synced passkey)
-- always sends 0. For a counter at or below the stored one Level 3 leaves the
-- choice to the relying party; we refuse. So 0 after a counter above 0 is a
-- fall, and nothing follows 2^32 - 1.
--
-- The check and the write are one UPDATE: a second use with the same counter
-- waits on the row lock, re-reads the committed counter and is refused.
--   no session                                       ZD401
--   another account's, unknown or revoked credential ZD403 (one answer)
--   counter not accepted                             ZD409
--   NULL or a counter outside 0 .. 2^32 - 1          ZD422
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION identity.use_webauthn_credential(p_credential_id bytea, p_sign_count bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF p_credential_id IS NULL OR p_sign_count IS NULL OR p_sign_count NOT BETWEEN 0 AND 4294967295 THEN
    RAISE EXCEPTION 'invalid credential use' USING ERRCODE = 'ZD422';
  END IF;

  UPDATE identity.webauthn_credential c
     SET sign_count = p_sign_count,
         last_used_at = GREATEST(pg_catalog.statement_timestamp(), c.created_at)
   WHERE c.credential_id = p_credential_id AND c.user_id = v_user AND c.institution_id = v_institution
     AND c.revoked_at IS NULL
     AND (p_sign_count > c.sign_count OR (p_sign_count = 0 AND c.sign_count = 0));
  IF FOUND THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM identity.webauthn_credential c
              WHERE c.credential_id = p_credential_id AND c.user_id = v_user
                AND c.institution_id = v_institution AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'signature counter did not increase' USING ERRCODE = 'ZD409';
  END IF;
  RAISE EXCEPTION 'not allowed' USING ERRCODE = 'ZD403';
END
$$;
REVOKE ALL ON FUNCTION identity.use_webauthn_credential(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.use_webauthn_credential(bytea, bigint) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.use_webauthn_credential(bytea, bigint);
