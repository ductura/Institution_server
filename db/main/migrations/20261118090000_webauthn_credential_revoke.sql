-- migrate:up
-- DAN-1095 (S-1E-f-3; contract on Ductus#2028, c.6970898042): the caller
-- revokes a WebAuthn credential of their own. The person and institution
-- come from the session; neither is a parameter.
--
-- A session alone does not revoke. Otherwise a stolen session revokes the
-- owner's key, and add_webauthn_credential then accepts the thief's key,
-- because the account no longer holds one that is not revoked (838-2b). The
-- call carries the counter of an assertion of this very key, which the route
-- has verified (not here), and spends it by the rule of
-- use_webauthn_credential: a counter above the stored one, or 0 on both
-- sides. Revocation, counter and last use are one UPDATE, so a use or a second
-- revocation at the same time waits on the row lock, re-reads it as revoked
-- and is refused.
--   no session                                       ZD401
--   another account's, unknown or revoked credential ZD403 (one answer)
--   counter not accepted                             ZD409
--   NULL or a counter outside 0 .. 2^32 - 1          ZD422
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE FUNCTION identity.revoke_webauthn_credential(p_credential_id bytea, p_sign_count bigint)
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
    RAISE EXCEPTION 'invalid credential revocation' USING ERRCODE = 'ZD422';
  END IF;

  UPDATE identity.webauthn_credential c
     SET sign_count = p_sign_count,
         last_used_at = GREATEST(pg_catalog.statement_timestamp(), c.created_at),
         revoked_at = GREATEST(pg_catalog.statement_timestamp(), c.created_at)
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
REVOKE ALL ON FUNCTION identity.revoke_webauthn_credential(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.revoke_webauthn_credential(bytea, bigint) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.revoke_webauthn_credential(bytea, bigint);
SET LOCAL ROLE ductus_migrator;
