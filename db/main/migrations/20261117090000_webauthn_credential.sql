-- migrate:up
-- DAN-838-1 (contract on Ductus#1836, c.6931320229): the WebAuthn (FIDO2)
-- credentials of an account, the second factor of the network engineer
-- (docs/account-permissions.md). This is the table only; the calls that add,
-- use and revoke a credential are 838-2 and 838-3 and run as its owner.
--
-- One credential belongs to one account: credential_id is unique over the
-- whole table, across accounts and institutions, and a revoked row keeps its
-- id, so revocation never frees it for another account. The id is the raw
-- bytes the authenticator gave; nothing normalises them. At most 1023 bytes
-- (WebAuthn Level 3, 6.1); the lower bound of 1 is our own. The public key is
-- a COSE key: RSA-4096 is about 550 bytes, and 4096 leaves room for larger
-- keys. sign_count is the authenticator's unsigned 32-bit counter.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE identity.webauthn_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  credential_id bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 4096),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz CHECK (last_used_at >= created_at),
  revoked_at timestamptz CHECK (revoked_at >= created_at),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX webauthn_credential_user_idx ON identity.webauthn_credential (user_id, institution_id);

ALTER TABLE identity.webauthn_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.webauthn_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY webauthn_credential_owner ON identity.webauthn_credential TO ductus_identity
  USING (true) WITH CHECK (true);

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP TABLE identity.webauthn_credential;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
