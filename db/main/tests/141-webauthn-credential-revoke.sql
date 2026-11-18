-- DAN-1095-2 (S-1E-f-3; contracts on Ductus#2028, c.6970898042 and the
-- DAN-1095-2 contract): identity.revoke_webauthn_credential revokes the
-- caller's own credential with an assertion of that key the route has
-- verified, and spends the assertion by the counter rule of
-- use_webauthn_credential. Another's, unknown and revoked credentials get one
-- answer whatever the counter; every refused call is checked against a
-- fingerprint of the whole table taken just before it. A revoked credential
-- can no longer be used. Person and institution come from the session.
-- Personas of institution.inc; every person and byte below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- Stored counters at the bounds: 0, 1, 2, 4, 5, 2^32 - 2 and 2^32 - 1. Ana has
-- a second live credential, so a revocation of more than the named row shows.
INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, revoked_at)
SELECT p.id, p.institution_id, v.credential, '\x01', v.count, CASE WHEN v.revoked THEN statement_timestamp() END
  FROM (VALUES ('ana', '\xa1'::bytea, 5::bigint, false), ('ana', '\xa2', 2, false), ('ana', '\xa3', 1, true), ('dora', '\xd1', 1, false),
               ('tomo', '\xb1', 1, false), ('marko', '\x31', 4, false), ('boris', '\x41', 0, false),
               ('petra', '\x91', 0, false), ('iva', '\x51', 4294967294, false), ('lea', '\x81', 4294967295, false))
       AS v (who, credential, count, revoked)
  JOIN person p ON p.name = v.who;
-- Nina's credential is dated an hour ahead: the revocation must not precede it.
INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count, created_at)
SELECT p.id, p.institution_id, '\x71', '\x07', 2, now() + interval '1 hour' FROM person p WHERE p.name = 'nina';

-- The whole table as one value: every column of every row.
CREATE FUNCTION pg_temp.snapshot() RETURNS text
LANGUAGE sql AS $$ SELECT md5(string_agg(c::text, '|' ORDER BY c.id)) FROM identity.webauthn_credential c $$;
-- p_sql as p_actor through the web role: "ok" or "SQLSTATE: message", with
-- " (table changed)" when the fingerprint after the call differs from the one
-- just before it.
CREATE FUNCTION pg_temp.run(p_actor text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_before text;
  v_answer text;
BEGIN
  v_before := pg_temp.snapshot();
  v_answer := pg_temp.ask(p_actor, p_sql);
  RETURN v_answer || CASE WHEN pg_temp.snapshot() = v_before THEN '' ELSE ' (table changed)' END;
END
$$;
CREATE FUNCTION pg_temp.revoke(p_actor text, p_credential bytea, p_count bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.run(p_actor, format(
    'SELECT ''ok'' FROM identity.revoke_webauthn_credential(%L::bytea, %L::bigint)', p_credential, p_count))
$$;
-- Whether the fingerprint sees p_change; the change is undone afterwards.
-- Foreign keys are off inside, so one column can change on its own.
CREATE FUNCTION pg_temp.seen(p_change text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_before text;
  v_after text;
BEGIN
  v_before := pg_temp.snapshot();
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    EXECUTE p_change;
    v_after := pg_temp.snapshot();
    RAISE EXCEPTION 'undo';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  RETURN v_after IS DISTINCT FROM v_before;
END
$$;
CREATE TEMP TABLE before AS SELECT pg_temp.snapshot() AS v;

-- 0. The fingerprint sees a change of each column of one row, an added row
-- and a removed one; and the change is undone. A refused call is rolled back
-- by pg_temp.ask, so the fingerprints below check that rollback and the state
-- between blocks; the function's own refusals are checked by their full text.
SELECT ok(pg_temp.seen(v.change), 'the fingerprint sees ' || v.what)
FROM (VALUES ('UPDATE identity.webauthn_credential SET id = gen_random_uuid() WHERE credential_id = ''\xd1''', 'id'),
             (format('UPDATE identity.webauthn_credential SET user_id = %L WHERE credential_id = ''\xd1''', pg_temp.id('vesna')), 'user_id'),
             (format('UPDATE identity.webauthn_credential SET institution_id = %L WHERE credential_id = ''\xd1''', pg_temp.id('fak_b')), 'institution_id'),
             ('UPDATE identity.webauthn_credential SET credential_id = ''\xee'' WHERE credential_id = ''\xd1''', 'credential_id'),
             ('UPDATE identity.webauthn_credential SET public_key = ''\x02'' WHERE credential_id = ''\xd1''', 'public_key'),
             ('UPDATE identity.webauthn_credential SET sign_count = 2 WHERE credential_id = ''\xd1''', 'sign_count'),
             ('UPDATE identity.webauthn_credential SET created_at = created_at - interval ''1 day'' WHERE credential_id = ''\xd1''', 'created_at'),
             ('UPDATE identity.webauthn_credential SET last_used_at = created_at WHERE credential_id = ''\xd1''', 'last_used_at'),
             ('UPDATE identity.webauthn_credential SET revoked_at = created_at WHERE credential_id = ''\xd1''', 'revoked_at'),
             ('INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key) SELECT user_id, institution_id, ''\xe1'', ''\x01'' FROM identity.webauthn_credential WHERE credential_id = ''\xd1''', 'an added row'),
             ('DELETE FROM identity.webauthn_credential WHERE credential_id = ''\xd1''', 'a removed row'))
       AS v (change, what);
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'the probes left the table as it was');

-- 1. Without a session: ZD401 for any input, before the input is read.
SELECT is(pg_temp.revoke(t, '\xa1', c.count), 'ZD401: not authenticated', 'no session: ' || t || ', counter ' || coalesce(c.count::text, 'NULL'))
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t
CROSS JOIN unnest(ARRAY[0, 6, 4294967295, -1, 4294967296, NULL]::bigint[]) AS c (count);
SELECT is(pg_temp.revoke('anon', NULL, NULL), 'ZD401: not authenticated', 'the session is checked before the input');
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'block 1 left the table as it was');

-- The credentials Ana may not revoke: another account's, unknown, her revoked one.
CREATE TEMP TABLE barred (who, credential, what) AS
VALUES ('dora', '\xa1'::bytea, 'another account of the institution'),
       ('tomo', '\xa1', 'an account of another institution'),
       ('ana', '\xd1', 'Ana with Dora''s credential'),
       ('ana', '\xb1', 'Ana with a credential of fak-b'),
       ('ana', '\xff', 'a credential nobody has'),
       ('ana', '\x', 'an empty credential id'),
       ('ana', decode(repeat('ab', 1024), 'hex'), 'a credential id of 1024 bytes'),
       ('ana', '\xa3', 'Ana''s own revoked credential');

-- 2. One answer for every barred credential, whatever the counter: 0, below
-- the stored one, equal to it (stale), one above it, above it and the largest
-- (stored 5 for Ana's, 1 for Dora's, Tomo's and the revoked one).
SELECT is(pg_temp.revoke(b.who, b.credential, c.count), 'ZD403: not allowed', b.what || ', counter ' || c.count)
FROM barred b CROSS JOIN unnest(ARRAY[0, 1, 2, 5, 6, 99, 4294967295]::bigint[]) AS c (count);
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'block 2 left the table as it was');

-- 3. Input outside the bounds: ZD422 for a barred credential as for Ana's own,
-- so the answer does not tell whether the credential exists.
SELECT is(pg_temp.revoke(b.who, b.credential, c.count), 'ZD422: invalid credential revocation',
          b.what || ', counter ' || coalesce(c.count::text, 'NULL'))
FROM (SELECT * FROM barred UNION ALL SELECT 'ana', '\xa1', 'Ana''s own credential') b
CROSS JOIN unnest(ARRAY[-1, 4294967296, NULL, 9223372036854775807, -9223372036854775808]::bigint[]) AS c (count);
SELECT is(pg_temp.revoke('ana', NULL, 6), 'ZD422: invalid credential revocation', 'no credential id');
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'block 3 left the table as it was');

-- 4. Ana's own credential with an assertion that is not accepted: ZD409. At
-- the top (2^32 - 1) no counter is accepted any more.
SELECT is(pg_temp.revoke(v.who, v.credential, v.count), 'ZD409: signature counter did not increase', v.what)
FROM (VALUES ('marko', '\x31'::bytea, 4::bigint, 'the stored counter again'),
             ('marko', '\x31', 3, 'a lower counter'),
             ('marko', '\x31', 0, 'a counter back at 0'),
             ('lea', '\x81', 4294967295, 'the largest counter again'),
             ('lea', '\x81', 1, 'below the largest counter'),
             ('lea', '\x81', 0, 'back at 0 from the largest counter')) AS v (who, credential, count, what);
SELECT is(pg_temp.snapshot(), (SELECT v FROM before), 'block 4 left the table as it was');

-- 5. Ana revokes her own; then it can be neither revoked again nor used.
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(encode(credential_id, ''hex''), '' '' ORDER BY credential_id) FROM identity.webauthn_credentials_for_actor()'),
  'a1 a2', 'before: Ana''s live credentials are listed');
CREATE TEMP TABLE other AS SELECT * FROM identity.webauthn_credential WHERE credential_id <> '\xa1';
CREATE TEMP TABLE mine AS SELECT * FROM identity.webauthn_credential WHERE credential_id = '\xa1';
CREATE TEMP TABLE called AS SELECT clock_timestamp() AS at;
SELECT is(pg_temp.revoke('ana', '\xa1', 6), 'ok (table changed)', 'Ana revokes her own credential with a fresh assertion');
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
SELECT is(pg_temp.revoke('ana', '\xa1', 7), 'ZD403: not allowed', 'a revoked credential cannot be revoked again');
SELECT is(pg_temp.run('ana', 'SELECT ''ok'' FROM identity.use_webauthn_credential(''\xa1'', 8)'),
  'ZD403: not allowed', 'a revoked credential cannot be used');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(encode(credential_id, ''hex''), '' '' ORDER BY credential_id) FROM identity.webauthn_credentials_for_actor()'),
  'a2', 'the revoked credential is no longer listed; her other one is');

-- 6. The other accepted assertions, at the bounds of the counter.
SELECT is(pg_temp.revoke(v.who, v.credential, v.count), 'ok (table changed)', v.what)
FROM (VALUES ('marko', '\x31'::bytea, 5::bigint, 'one above the stored counter revokes'),
             ('boris', '\x41', 0, 'an authenticator without a counter (0 and 0) revokes'),
             ('petra', '\x91', 1, 'a first counter after 0 revokes'),
             ('iva', '\x51', 4294967295, 'the largest 32-bit counter revokes'),
             ('nina', '\x71', 3, 'a credential dated ahead of the call revokes')) AS v (who, credential, count, what);
SELECT is((SELECT (revoked_at = created_at AND last_used_at = created_at)::text
             FROM identity.webauthn_credential WHERE credential_id = '\x71'),
  'true', 'and its revocation and last use are not earlier than the credential');
SELECT is((SELECT string_agg(encode(credential_id, 'hex') || ' ' || sign_count, ', ' ORDER BY credential_id)
             FROM identity.webauthn_credential WHERE revoked_at IS NOT NULL),
  '31 5, 41 0, 51 4294967295, 71 3, 91 1, a1 6, a3 1', 'exactly the revoked rows, with the counters of their assertions');

-- 7. The function from the catalogue; only the web role calls it.
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
