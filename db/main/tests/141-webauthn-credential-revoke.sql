-- DAN-1095 (S-1E-f-3; contract on Ductus#2028, c.6970898042):
-- identity.revoke_webauthn_credential revokes the caller's own credential
-- with an assertion of that key the route has verified, and spends the
-- assertion by the counter rule of use_webauthn_credential. Another's,
-- unknown and revoked credentials get one answer and change nothing; a
-- revoked credential can no longer be used. Person and institution come from
-- the session. Personas of institution.inc; every person and byte below is
-- invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, revoked_at)
SELECT p.id, p.institution_id, v.credential, '\x01', v.count, CASE WHEN v.revoked THEN statement_timestamp() END
  FROM (VALUES ('ana', '\xa1'::bytea, 5::bigint, false), ('ana', '\xa3', 1, true), ('dora', '\xd1', 1, false),
               ('tomo', '\xb1', 1, false), ('marko', '\x31', 4, false), ('boris', '\x41', 0, false))
       AS v (who, credential, count, revoked)
  JOIN person p ON p.name = v.who;
-- Nina's credential is dated an hour ahead: the revocation must not precede it.
INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, created_at)
SELECT p.id, p.institution_id, '\x71', '\x07', 2, now() + interval '1 hour' FROM person p WHERE p.name = 'nina';

-- One call as p_actor through the web role: "ok" or "SQLSTATE: message".
CREATE FUNCTION pg_temp.revoke(p_actor text, p_credential bytea, p_count bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM identity.revoke_webauthn_credential(%L::bytea, %s::bigint)',
    p_credential, coalesce(p_count::text, 'NULL')))
$$;
-- The whole table as one value, to show that a refused call changed no row.
CREATE FUNCTION pg_temp.snapshot() RETURNS text
LANGUAGE sql AS $$ SELECT md5(string_agg(c::text, '|' ORDER BY c.id)) FROM identity.webauthn_credential c $$;
CREATE TEMP TABLE before AS SELECT pg_temp.snapshot() AS v;

-- 1. Without a session: ZD401, before the input is read.
SELECT is(pg_temp.revoke(t, '\xa1', 6), 'ZD401: not authenticated', 'no session: ' || t)
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t;
SELECT is(pg_temp.revoke('anon', NULL, NULL), 'ZD401: not authenticated', 'the session is checked before the input');

-- 2. Another's, unknown and revoked credentials: one answer.
SELECT is(pg_temp.revoke(v.who, v.credential, 99), 'ZD403: not allowed', v.what)
FROM (VALUES ('dora', '\xa1'::bytea, 'another account of the institution'),
             ('tomo', '\xa1', 'an account of another institution'),
             ('ana', '\xd1', 'Ana with Dora''s credential'),
             ('ana', '\xb1', 'Ana with a credential of fak-b'),
             ('ana', '\xff', 'a credential nobody has'),
             ('ana', '\x', 'an empty credential id'),
             ('ana', decode(repeat('ab', 1024), 'hex'), 'a credential id of 1024 bytes'),
             ('ana', '\xa3', 'Ana''s own revoked credential')) AS v (who, credential, what);

-- 3. The assertion: a counter that is not accepted, or input outside the bounds.
SELECT is(pg_temp.revoke('marko', '\x31', v.count), 'ZD409: signature counter did not increase', v.what)
FROM (VALUES (4::bigint, 'the stored counter again'), (3, 'a lower counter'), (0, 'a counter back at 0')) AS v (count, what);
SELECT is(pg_temp.revoke(v.who, v.credential, v.count), 'ZD422: invalid credential revocation', v.what)
FROM (VALUES ('marko', '\x31'::bytea, -1::bigint, 'a negative counter'),
             ('marko', '\x31', 4294967296, 'a counter above 32 bits'),
             ('marko', '\x31', NULL, 'no counter'),
             ('marko', NULL, 9, 'no credential id')) AS v (who, credential, count, what);
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'no refused call changed any row');

-- 4. Ana revokes her own; then it can be neither revoked again nor used.
CREATE TEMP TABLE other AS SELECT * FROM identity.webauthn_credential WHERE credential_id <> '\xa1';
CREATE TEMP TABLE mine AS SELECT * FROM identity.webauthn_credential WHERE credential_id = '\xa1';
CREATE TEMP TABLE called AS SELECT clock_timestamp() AS at;
SELECT is(pg_temp.revoke('ana', '\xa1', 6), 'ok', 'Ana revokes her own credential with a fresh assertion');
SELECT is(
  (SELECT c.sign_count || ' ' || (c.revoked_at = c.last_used_at)::text || ' '
          || (c.revoked_at BETWEEN (SELECT at FROM called) AND clock_timestamp())::text
     FROM identity.webauthn_credential c WHERE c.credential_id = '\xa1'),
  '6 true true', 'the revocation spends the assertion: counter, last use and revocation at the time of the call');
SELECT set_eq(
  'SELECT id, user_id, institution_id, credential_id, public_key, created_at FROM identity.webauthn_credential WHERE credential_id = ''\xa1''',
  'SELECT id, user_id, institution_id, credential_id, public_key, created_at FROM mine',
  'no other column of the revoked row changed');
SELECT set_eq('SELECT * FROM identity.webauthn_credential WHERE credential_id <> ''\xa1''', 'SELECT * FROM other',
  'no other row changed');
CREATE TEMP TABLE revoked AS SELECT pg_temp.snapshot() AS v;
SELECT is(pg_temp.revoke('ana', '\xa1', 7), 'ZD403: not allowed', 'a revoked credential cannot be revoked again');
SELECT is(pg_temp.ask('ana', 'SELECT ''ok'' FROM identity.use_webauthn_credential(''\xa1'', 8)'),
  'ZD403: not allowed', 'a revoked credential cannot be used');
SELECT is(pg_temp.snapshot(), (SELECT v FROM revoked), 'neither changed a row: the first revocation stays');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM identity.webauthn_credentials_for_actor()'), '0',
  'the revoked credential is no longer listed');

-- 5. The other accepted assertions.
SELECT is(pg_temp.revoke('marko', '\x31', 5), 'ok', 'a higher counter revokes');
SELECT is(pg_temp.revoke('boris', '\x41', 0), 'ok', 'an authenticator without a counter (0 and 0) revokes');
SELECT is(pg_temp.revoke('nina', '\x71', 3), 'ok', 'a credential dated ahead of the call revokes');
SELECT is((SELECT (revoked_at = created_at AND last_used_at = created_at)::text
             FROM identity.webauthn_credential WHERE credential_id = '\x71'),
  'true', 'and its revocation and last use are not earlier than the credential');
SELECT is((SELECT string_agg(encode(credential_id, 'hex') || ' ' || sign_count, ', ' ORDER BY credential_id)
             FROM identity.webauthn_credential WHERE revoked_at IS NOT NULL),
  '31 5, 41 0, 71 3, a1 6, a3 1', 'exactly the revoked rows, with the counters of their assertions');

-- 6. The function from the catalogue; only the web role calls it.
SELECT is(
  (SELECT p.prosecdef::text || ' ' || p.proowner::regrole::text || ' ' || p.provolatile::text || ' '
          || array_to_string(p.proconfig, ',') || ' ' || pg_get_function_result(p.oid)
     FROM pg_proc p WHERE p.oid = 'identity.revoke_webauthn_credential(bytea, bigint)'::regprocedure),
  'true ductus_identity v search_path="" void', 'a volatile definer of the identity role with an empty search_path');
SELECT is((SELECT string_agg(pg_get_function_identity_arguments(p.oid), ' | ') FROM pg_proc p
            WHERE p.proname = 'revoke_webauthn_credential'),
  'p_credential_id bytea, p_sign_count bigint', 'one signature; no person or institution among the parameters');
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND NOT rolcanlogin
                            UNION ALL SELECT 'public') AS r
      WHERE has_function_privilege(r.rolname, 'identity.revoke_webauthn_credential(bytea, bigint)', 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_identity'], 'only the web role and the owner may call it');
SELECT is(pg_temp.ask_as('ductus_auth', 'dora', 'SELECT ''ok'' FROM identity.revoke_webauthn_credential(''\xd1'', 99)'),
  '42501: permission denied for function revoke_webauthn_credential', 'the login role cannot call it');
SELECT is(pg_temp.ask('dora', 'UPDATE identity.webauthn_credential SET revoked_at = created_at'),
  '42501: permission denied for table webauthn_credential', 'the web role still cannot write the table');

SELECT * FROM finish();
ROLLBACK;
