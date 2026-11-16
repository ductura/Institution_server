-- DAN-838-2b (contract on Ductus#1836): identity.add_webauthn_credential
-- stores a registration the route has verified. The table's own constraints
-- answer for the input, and their SQLSTATEs map to ZD codes: 23505 -> ZD409,
-- 23503 -> ZD403, 23514 and 23502 -> ZD422. Person and institution come from
-- the session, never from a parameter. While an account holds a credential
-- that is not revoked, another is refused until the ceremony (DAN-840) can
-- prove a second factor in the session.
-- Personas of institution.inc; every person and byte below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- One registration as p_actor through the web role: "ok" or "SQLSTATE: message".
CREATE FUNCTION pg_temp.add(p_actor text, p_credential bytea, p_key bytea, p_count bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM identity.add_webauthn_credential(%L::bytea, %L::bytea, %s::bigint)',
    p_credential, p_key, coalesce(p_count::text, 'NULL')))
$$;
CREATE FUNCTION pg_temp.rows() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM identity.webauthn_credential $$;
CREATE FUNCTION pg_temp.revoke(p_actor text) RETURNS void
LANGUAGE sql AS $$
  UPDATE identity.webauthn_credential SET revoked_at = statement_timestamp()
   WHERE user_id = pg_temp.id(p_actor) AND revoked_at IS NULL
$$;

-- 1. 23505: a credential id that exists, revoked or not, own or not -> ZD409.
SELECT is(pg_temp.add('vesna', '\xa1', '\x01', 0), 'ok', 'a first credential is stored');
SELECT pg_temp.revoke('vesna');
SELECT is(pg_temp.add(v.who, '\xa1', '\x01', 0), 'ZD409: credential already registered', v.what)
FROM (VALUES ('vesna', 'the own revoked id is never free again'),
             ('marko', 'the id of another account of the institution'),
             ('lea', 'the id of an account of another institution')) AS v (who, what);
SELECT is(pg_temp.rows(), 1::bigint, 'a refused id adds no row');

-- 2. 23514 and 23502: the bounds of the table -> ZD422.
SELECT is(pg_temp.add('boris', v.credential, v.key, v.count), 'ZD422: invalid credential', v.what)
FROM (VALUES ('\x'::bytea, '\x01'::bytea, 0::bigint, 'an empty id'),
             (decode(repeat('b1', 1024), 'hex'), '\x01', 0, 'an id of 1024 bytes'),
             ('\xb1', '\x', 0, 'an empty key'),
             ('\xb1', decode(repeat('01', 4097), 'hex'), 0, 'a key of 4097 bytes'),
             ('\xb1', '\x01', -1, 'a negative counter'),
             ('\xb1', '\x01', 4294967296, 'a counter above 32 bits'),
             (NULL, '\x01', 0, 'no id'),
             ('\xb1', NULL, 0, 'no key'),
             ('\xb1', '\x01', NULL, 'no counter: an explicit NULL takes no default')) AS v (credential, key, count, what);
SELECT is(pg_temp.rows(), 1::bigint, 'invalid input adds no row');
SELECT is(pg_temp.add('boris', decode(repeat('b1', 1023), 'hex'), decode(repeat('01', 4096), 'hex'), 4294967295),
  'ok', 'an id of 1023 bytes, a key of 4096 bytes and the largest counter are accepted');

-- 3. The institution is no parameter: the row is the session's.
SELECT is(pg_get_function_identity_arguments('identity.add_webauthn_credential(bytea, bytea, bigint)'::regprocedure),
  'p_credential_id bytea, p_public_key bytea, p_sign_count bigint', 'neither person nor institution is a parameter');
CREATE TEMP TABLE added AS
SELECT pg_temp.ask('tomo', 'SELECT identity.add_webauthn_credential(''\xb3'', ''\x02'', 3)::text') AS id;
SELECT is(
  (SELECT (c.user_id = pg_temp.id('tomo') AND c.institution_id = pg_temp.id('fak_b') AND c.sign_count = 3
           AND c.public_key = '\x02' AND c.last_used_at IS NULL AND c.revoked_at IS NULL)::text
     FROM identity.webauthn_credential c JOIN added a ON c.id::text = a.id),
  'true', 'the returned id is a row of Tomo in fak-b');

-- 4. Limit (a): beside a credential that is not revoked, nothing is added.
SELECT is(pg_temp.add('ana', '\xa4', '\x01', 0), 'ok', 'Ana''s first credential');
SELECT is(pg_temp.add('ana', v.credential, v.key, 0), 'ZD403: second factor required', v.what)
FROM (VALUES ('\xa5'::bytea, '\x01'::bytea, 'a second credential'),
             ('\xa1', '\x01', 'an id that exists: ZD403 comes first'),
             ('\x', '\x01', 'invalid input: ZD403 comes first')) AS v (credential, key, what);
SELECT pg_temp.revoke('ana');
SELECT is(pg_temp.add('ana', '\xa5', '\x01', 0), 'ok', 'after the revocation Ana may add one');

-- 5. Without a session nothing is read; the catalogue; only the web role calls it.
SELECT is(left(pg_temp.add(t, '\xc1', '\x01', 0), 5), 'ZD401', 'no session: ' || t)
FROM unnest(ARRAY['anon', 'expired', 'closed', 'unknown']) AS t;
SELECT is(left(pg_temp.add('anon', NULL, NULL, NULL), 5), 'ZD401', 'the session is checked before the input');
SELECT is(
  (SELECT p.prosecdef::text || ' ' || p.proowner::regrole::text || ' ' || p.provolatile::text || ' '
          || array_to_string(p.proconfig, ',') || ' ' || pg_get_function_result(p.oid)
     FROM pg_proc p WHERE p.oid = 'identity.add_webauthn_credential(bytea, bytea, bigint)'::regprocedure),
  'true ductus_identity v search_path="" uuid', 'a volatile definer of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus%' AND NOT rolsuper AND NOT rolcanlogin
                            UNION ALL SELECT 'public') AS r
      WHERE has_function_privilege(r.rolname, 'identity.add_webauthn_credential(bytea, bytea, bigint)', 'EXECUTE') $$,
  ARRAY['ductus_app', 'ductus_identity'], 'only the web role and the owner may call it');
SELECT is(pg_temp.ask_as('ductus_auth', 'iva', 'SELECT ''ok'' FROM identity.add_webauthn_credential(''\xc1'', ''\x01'', 0)'),
  '42501: permission denied for function add_webauthn_credential', 'the login role cannot call it');

-- 6. 23503, last, as it removes an account: Nina's session outlives her
-- account only with the foreign keys off for the delete; the insert -> ZD403.
SET LOCAL session_replication_role = replica;
DELETE FROM identity.user_account WHERE id = pg_temp.id('nina');
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.add('nina', '\xc1', '\x01', 0), 'ZD403: account not found', 'an account that is gone');
SELECT is((SELECT count(*) FROM identity.webauthn_credential WHERE credential_id = '\xc1'), 0::bigint, 'and no row');

SELECT * FROM finish();
ROLLBACK;
