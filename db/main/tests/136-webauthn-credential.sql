-- DAN-838-1 (contract on Ductus#1836, c.6931320229): one WebAuthn credential
-- belongs to one account. identity.webauthn_credential is the table only;
-- the calls that add, use and revoke a credential come in 838-2 and 838-3.
-- Personas of institution.inc; every person and byte below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- One credential as the owner (the RPCs of 838-2 run as it): the SQLSTATE of
-- the failure, or "ok".
CREATE FUNCTION pg_temp.put(p_person text, p_credential bytea, p_key bytea DEFAULT '\x01',
                            p_count bigint DEFAULT 0, p_institution text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r = 'ok' THEN r ELSE left(r, 5) END FROM pg_temp.ask_as('ductus_identity', 'anon', format(
    'WITH x AS (INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key, sign_count)
     VALUES (%L, %L, %L, %L, %s) RETURNING 1) SELECT ''ok'' FROM x',
    pg_temp.id(p_person), coalesce(pg_temp.id(p_institution), (SELECT institution_id FROM person WHERE name = p_person)),
    p_credential, p_key, coalesce(p_count::text, 'NULL'))) AS r
$$;

-- 1. One credential, one account, revoked or not.
SELECT is(pg_temp.put('ana', '\xc0ffee01'), 'ok', 'Ana adds a credential');
SELECT is(pg_temp.put('dora', '\xc0ffee01'), '23505', 'the same credential on another account of the institution is refused');
SELECT is(pg_temp.put('tomo', '\xc0ffee01'), '23505', 'the same credential on an account of another institution is refused');
SELECT is(pg_temp.put('ana', '\xc0ffee01'), '23505', 'the same credential twice on one account is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
  'WITH x AS (UPDATE identity.webauthn_credential SET revoked_at = created_at RETURNING 1) SELECT count(*)::text FROM x'),
  '1', 'Ana''s credential is revoked');
SELECT is(pg_temp.put('dora', '\xc0ffee01'), '23505', 'a revoked credential does not free its id for another account');
SELECT is(
  (SELECT string_agg(pg_get_indexdef(i.indexrelid), ' | ') FROM pg_index i
    WHERE i.indrelid = 'identity.webauthn_credential'::regclass AND i.indisunique AND NOT i.indisprimary),
  'CREATE UNIQUE INDEX webauthn_credential_credential_id_key ON identity.webauthn_credential USING btree (credential_id)',
  'the only unique index is on credential_id alone: not partial, not an expression, not per account');
SELECT is(pg_temp.put('dora', '\xc0ffee'), 'ok', 'a prefix of an existing id is another credential');
SELECT is(pg_temp.put('dora', '\xc0ffee02'), 'ok', 'an id that differs in the last byte is another credential');

-- 2. The bytes as given: no normalisation, bounded lengths and counter.
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
                     || CASE WHEN a.attgenerated <> '' THEN ' generated' ELSE '' END, ', ' ORDER BY a.attnum)
     FROM pg_attribute a WHERE a.attrelid = 'identity.webauthn_credential'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'id uuid not null, user_id uuid not null, institution_id uuid not null, credential_id bytea not null, public_key bytea not null, '
  || 'sign_count bigint not null, created_at timestamp with time zone not null, last_used_at timestamp with time zone, '
  || 'revoked_at timestamp with time zone',
  'the columns, none generated');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'identity.webauthn_credential'::regclass AND NOT tgisinternal), 0,
  'no trigger rewrites a row');
SELECT is(pg_temp.put(v.who, v.credential, v.key, v.count), v.expect, v.what)
FROM (VALUES
  ('boris', '\x'::bytea, '\x01'::bytea, 0::bigint, '23514', 'an empty credential id'),
  ('boris', NULL, '\x01', 0, '23502', 'no credential id'),
  ('boris', decode(repeat('ab', 1024), 'hex'), '\x01', 0, '23514', 'a credential id of 1024 bytes'),
  ('boris', '\x0b', '\x01', 0, 'ok', 'a credential id of one byte'),
  ('boris', decode(repeat('cd', 1023), 'hex'), '\x01', 0, 'ok', 'a credential id of 1023 bytes (WebAuthn L3)'),
  ('nina', '\x0c', '\x', 0, '23514', 'an empty public key'),
  ('nina', '\x0d', NULL, 0, '23502', 'no public key'),
  ('nina', '\x0e', decode(repeat('ef', 4097), 'hex'), 0, '23514', 'a public key of 4097 bytes'),
  ('nina', '\x0f', decode(repeat('ef', 4096), 'hex'), 0, 'ok', 'a public key of 4096 bytes'),
  ('marko', '\x10', '\x01', -1, '23514', 'a negative counter'),
  ('marko', '\x11', '\x01', 4294967296, '23514', 'a counter above 32 bits'),
  ('marko', '\x12', '\x01', NULL, '23502', 'no counter'),
  ('marko', '\x13', '\x01', 4294967295, 'ok', 'the largest 32-bit counter')
) AS v (who, credential, key, count, expect, what);

-- 3. The row's institution is its account's.
SELECT is(pg_temp.put('ana', '\x20', p_institution => 'fak_b'), '23503', 'an institution other than the account''s is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO identity.webauthn_credential (user_id, institution_id, credential_id, public_key) VALUES (%L, %L, ''\x21'', ''\x01'')',
  pg_temp.id('nobody'), pg_temp.id('fak_a'))) LIKE '23503:%', true, 'an account that does not exist is refused');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', format(
  'UPDATE identity.webauthn_credential SET %s WHERE credential_id = ''\x0b''', c.col)) LIKE '23514:%', true, c.what)
FROM (VALUES ('revoked_at = created_at - interval ''1 second''', 'a revocation before the credential existed is refused'),
             ('last_used_at = created_at - interval ''1 second''', 'a use before the credential existed is refused')) AS c (col, what);

-- 4. The owner, RLS and the access matrix: nobody but ductus_identity.
SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
             FROM pg_class c WHERE c.oid = 'identity.webauthn_credential'::regclass),
  'webauthn_credential has ENABLE and FORCE ROW LEVEL SECURITY and belongs to ductus_identity');
SELECT is((SELECT string_agg(pol.polname || ' ' || pol.polcmd::text || ' ' || array_to_string(pol.polroles::regrole[], ','), ' | ')
             FROM pg_policy pol WHERE pol.polrelid = 'identity.webauthn_credential'::regclass),
  'webauthn_credential_owner * ductus_identity', 'the only policy is the owner''s');
SELECT ok(has_table_privilege('ductus_identity', 'identity.webauthn_credential', o.op), format('ductus_identity: %s', o.op))
FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS o (op);
SELECT is(left(pg_temp.ask_as(r.rolname::text, 'anon', CASE o.op
    WHEN 'SELECT' THEN 'SELECT count(*)::text FROM identity.webauthn_credential'
    WHEN 'INSERT' THEN 'INSERT INTO identity.webauthn_credential DEFAULT VALUES'
    WHEN 'UPDATE' THEN 'UPDATE identity.webauthn_credential SET sign_count = 0'
    WHEN 'DELETE' THEN 'DELETE FROM identity.webauthn_credential' END), 5),
  '42501', format('%s: %s on webauthn_credential is refused', r.rolname, o.op))
FROM pg_roles r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS o (op)
WHERE r.rolname LIKE 'ductus\_%' AND NOT r.rolsuper AND NOT r.rolcanlogin AND r.rolname <> 'ductus_identity';

SELECT * FROM finish();
ROLLBACK;
