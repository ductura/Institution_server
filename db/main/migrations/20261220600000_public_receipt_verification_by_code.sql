-- DIZAJN-27-11 1.1 (3) (Ductus#2059 c.7217617528): the public check of a
-- submission receipt by its "Kod potvrde" alone, behind
-- POST /api/v1/public/verification/code. The receipt PDF prints the code and
-- its QR carries it (fragment k=). The code has 80 random bits
-- (20261220530000), so the code stands in for the pair of
-- app.public_receipt_verification. The pair stays for receipts already handed
-- out with the old QR.
--
-- As the pair check, the function runs without a session and never reads one:
-- it is not a way to sign in (D-09) and gives no access to a work (C-23). It
-- answers "match" only when a bound receipt exists for the submission the code
-- was issued to; it then returns the submission id and its artifact hash with
-- the signed receipt and its one key, so the web process checks the Ed25519
-- signature against the database's own values and answers the public only
-- whether it matches, when the text was submitted and signed, and the key id.
-- Every other case (an unknown code, a malformed one, a submission without a
-- bound receipt) is the same bare "no_match".
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;

CREATE FUNCTION app.public_receipt_verification_by_code(p_code text)
RETURNS TABLE (
  outcome text, submission_id uuid, artifact_sha256 text,
  receipt_payload text, payload_digest_sha256 text, signature jsonb,
  key_base64url text, key_evidence_domain_id uuid, key_purpose text,
  key_valid_from timestamptz, key_valid_to timestamptz, key_revoked_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_code IS NOT NULL AND p_code ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$' THEN
    RETURN QUERY
      SELECT 'match'::text, s.id, s.artifact_hash, r.receipt_payload, r.payload_digest_sha256, r.signature,
             k.key_base64url, k.evidence_domain_id, k.purpose, k.valid_from, k.valid_to, k.revoked_at
        FROM evidence.submission_confirmation_code c
        JOIN evidence.submission_receipt r
          ON r.submission_id = c.submission_id AND r.institution_id = c.institution_id
        JOIN evidence.submission s ON s.id = r.submission_id AND s.institution_id = r.institution_id
        JOIN evidence.signing_key k ON k.key_id = r.key_id AND k.key_version = r.key_version
       WHERE c.code = p_code;
    IF FOUND THEN RETURN; END IF;
  END IF;
  RETURN QUERY SELECT 'no_match'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::jsonb,
    NULL::text, NULL::uuid, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz;
END
$$;
REVOKE ALL ON FUNCTION app.public_receipt_verification_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.public_receipt_verification_by_code(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_evidence;
SET LOCAL ROLE ductus_evidence;
DROP FUNCTION app.public_receipt_verification_by_code(text);
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_evidence;
