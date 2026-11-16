-- DAN-838-2a (contract on Ductus#1836): identity.use_webauthn_credential
-- records an assertion the route has verified. The signature counter never
-- falls: a new counter must be above the stored one, except that a counter
-- of 0 on both sides is an authenticator without a counter (WebAuthn L3 7.2).
-- Person and institution come from the session, never from a parameter.
-- Personas of institution.inc; every person and byte below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, revoked_at)
SELECT p.id, p.institution_id, v.credential, '\x01', v.count, CASE WHEN v.revoked THEN statement_timestamp() END
  FROM (VALUES ('ana', '\xa1'::bytea, 5::bigint, false), ('ana', '\xa2', 0, false), ('ana', '\xa3', 1, true),
               ('ana', '\xa4', 7, false), ('dora', '\xd1', 1, false), ('tomo', '\xb1', 1, false)) AS v (who, credential, count, revoked)
  JOIN person p ON p.name = v.who;

-- One use as p_actor through the web role: "ok" or the SQLSTATE.
CREATE FUNCTION pg_temp.use(p_actor text, p_credential bytea, p_count bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r = 'ok' THEN r ELSE left(r, 5) END FROM pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM identity.use_webauthn_credential(%L::bytea, %s::bigint)',
    p_credential, coalesce(p_count::text, 'NULL'))) AS r
$$;
-- The stored counter and whether a use is recorded.
CREATE FUNCTION pg_temp.row(p_credential bytea) RETURNS text
LANGUAGE sql AS $$
  SELECT sign_count || CASE WHEN last_used_at IS NULL THEN ' unused' ELSE ' used' END
    FROM identity.webauthn_credential WHERE credential_id = p_credential
$$;

-- 1. A counter at or below the stored one is refused and changes nothing.
SELECT is(pg_temp.use('ana', '\xa1', 5), 'ZD409', 'the stored counter again is refused');
SELECT is(pg_temp.use('ana', '\xa1', 4), 'ZD409', 'a lower counter is refused');
SELECT is(pg_temp.use('ana', '\xa1', 0), 'ZD409', 'a counter back at 0 is refused');
SELECT is(pg_temp.row('\xa1'), '5 unused', 'a refused use changes neither the counter nor the last use');
SELECT is(pg_temp.use('ana', '\xa1', 6), 'ok', 'a higher counter is accepted');
SELECT is(pg_temp.row('\xa1'), '6 used', 'the accepted counter and the use are stored');
SELECT is(pg_temp.use('ana', '\xa1', 6), 'ZD409', 'the same assertion twice is refused');

-- 2. Without a counter (0 on both sides), and the 32-bit bounds.
SELECT is(pg_temp.use('ana', '\xa2', 0), 'ok', 'an authenticator without a counter is accepted');
SELECT is(pg_temp.use('ana', '\xa2', 0), 'ok', 'and again: 0 and 0 is no counter, not a repeat');
SELECT is(pg_temp.use('ana', '\xa2', 3), 'ok', 'a counter may start after 0');
SELECT is(pg_temp.use('ana', '\xa2', 0), 'ZD409', 'once it counted, 0 is a fall');
SELECT is(pg_temp.row('\xa2'), '3 used', 'the counter stays at 3');
SELECT is(pg_temp.use('ana', '\xa4', 4294967295), 'ok', 'the largest 32-bit counter is accepted');
SELECT is(pg_temp.use('ana', '\xa4', 4294967295), 'ZD409', 'nothing follows the largest counter');
SELECT is(pg_temp.use(v.who, v.credential, v.count), 'ZD422', v.what)
FROM (VALUES ('ana', '\xa4'::bytea, -1::bigint, 'a negative counter'),
             ('ana', '\xa4', 4294967296, 'a counter above 32 bits'),
             ('ana', '\xa4', NULL, 'no counter'),
             ('ana', NULL, 9, 'no credential id')) AS v (who, credential, count, what);
SELECT is(pg_temp.row('\xa4'), '4294967295 used', 'invalid input changes nothing');

-- 3. Only the caller's own credential that is not revoked; one answer for the rest.
SELECT is(pg_temp.use(v.who, v.credential, 99), 'ZD403', v.what)
FROM (VALUES ('dora', '\xa1'::bytea, 'another account of the institution'),
             ('tomo', '\xa1', 'an account of another institution'),
             ('ana', '\xd1', 'Ana with Dora''s credential'),
             ('ana', '\xb1', 'Ana with a credential of fak-b'),
             ('ana', '\xff', 'a credential nobody has'),
             ('ana', '\xa3', 'Ana''s own revoked credential')) AS v (who, credential, what);
SELECT is(pg_temp.row(v.credential), v.expect, 'unchanged: ' || v.expect)
FROM (VALUES ('\xa1'::bytea, '6 used'), ('\xa3', '1 unused'), ('\xd1', '1 unused'), ('\xb1', '1 unused')) AS v (credential, expect);
SELECT is(pg_temp.use(t, '\xa1', 99), 'ZD401', 'no session: ' || t)
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t;
SELECT is(pg_temp.use('anon', NULL, NULL), 'ZD401', 'the session is checked before the input');
SELECT is(pg_temp.row('\xa1'), '6 used', 'a call without a session changes nothing');

-- 4. The function from the catalogue; only the web role calls it.
SELECT is(
  (SELECT p.prosecdef::text || ' ' || p.proowner::regrole::text || ' ' || p.provolatile::text || ' '
          || array_to_string(p.proconfig, ',') || ' ' || pg_get_function_result(p.oid)
     FROM pg_proc p WHERE p.oid = 'identity.use_webauthn_credential(bytea, bigint)'::regprocedure),
  'true ductus_identity v search_path="" void', 'a volatile definer of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND NOT rolcanlogin
                            UNION ALL SELECT 'public') AS r
      WHERE has_function_privilege(r.rolname, 'identity.use_webauthn_credential(bytea, bigint)', 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_identity'], 'only the web role and the owner may call it');
SELECT is(pg_temp.ask_as('ductus_auth', 'ana', 'SELECT ''ok'' FROM identity.use_webauthn_credential(''\xa1'', 99)'),
  '42501: permission denied for function use_webauthn_credential', 'the login role cannot call it');
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM identity.webauthn_credential'),
  '42501: permission denied for table webauthn_credential', 'the web role still cannot read the table');

SELECT * FROM finish();
ROLLBACK;
