-- SRV-NF6-SIFRA-2 (Ductus#2055; review of SRV #676, S2;
-- docs/contracts/self-note-sealed-v1.md §4.2): starting over under the key
-- and version the device names (20261217160000). Personas of institution.inc,
-- evidence-acceptance.inc and mentorship.inc, all invented: Ana writes doc-a
-- in Vesna's course K1; Dora is another student of K1 with her own work in
-- z1. The bytes are invented patterns, not real ciphertext.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- 1. Catalogue: the web role alone calls it; SECURITY DEFINER, empty search_path.
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      WHERE has_function_privilege(r, 'collaboration.delete_self_note_key_checked(uuid,integer)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'the web role alone calls the checked delete');
SELECT ok((SELECT p.prosecdef AND p.proowner = 'ductus_identity'::regrole AND 'search_path=""' = ANY (p.proconfig)
             FROM pg_proc p WHERE p.oid = 'collaboration.delete_self_note_key_checked(uuid,integer)'::regprocedure),
  'it is a SECURITY DEFINER function of the identity role with an empty search_path');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

CREATE FUNCTION pg_temp.bytes(p_seed integer, p_length integer) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(string_agg(lpad(to_hex((i * 7 + p_seed) % 256), 2, '0'), '' ORDER BY i), 'hex')
    FROM generate_series(1, p_length) AS i
$$;
CREATE FUNCTION pg_temp.put_key(p_actor text, p_key uuid, p_version text, p_seed integer) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT version::text FROM collaboration.put_self_note_key(%L::uuid, %s, 600000, %L, %L, %L, %L, %L, %L) $q$,
    p_key, coalesce(p_version, 'NULL'),
    pg_temp.bytes(p_seed + 1, 16), pg_temp.bytes(p_seed + 2, 12), pg_temp.bytes(p_seed + 3, 48),
    pg_temp.bytes(p_seed + 4, 16), pg_temp.bytes(p_seed + 5, 12), pg_temp.bytes(p_seed + 6, 48)))
$$;
CREATE FUNCTION pg_temp.seal(p_actor text, p_doc text, p_key uuid, p_seed integer) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT octet_length(note_ct)::text FROM collaboration.set_work_sealed_self_note(%L, %L::uuid, %L, %L) $q$,
    p_doc, p_key, pg_temp.bytes(p_seed, 12), pg_temp.bytes(p_seed + 1, 1296)))
$$;
CREATE FUNCTION pg_temp.checked(p_actor text, p_key text, p_version text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT collaboration.delete_self_note_key_checked(%s, %s)::text $q$,
    coalesce(quote_literal(p_key) || '::uuid', 'NULL'), coalesce(p_version, 'NULL')))
$$;
CREATE FUNCTION pg_temp.ddoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('dora') AND p.assignment_id = pg_temp.id('z1')
$$;
INSERT INTO ref VALUES ('key_a', '00000000-0000-4000-8000-0000000006a1'), ('key_a2', '00000000-0000-4000-8000-0000000006a2'),
  ('key_d', '00000000-0000-4000-8000-0000000006d1');

-- 2. Ana holds her key at version 2 and a sealed note; Dora holds her own.
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), NULL, 10), '1', 'Ana sets her key');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), '1', 20), '2', 'and rewraps it on another device');
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_a'), 30), '1296', 'Ana seals a note on doc-a');
SELECT is(pg_temp.put_key('dora', pg_temp.id('key_d'), NULL, 40), '1', 'Dora sets a key of her own');
-- Dora acknowledged only version 1 of z1; the current version is 2.
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
VALUES (pg_temp.id('z1'), 2, pg_temp.id('dora'), pg_temp.id('fak_a'));
SELECT is(substr(pg_temp.ask('dora', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('z1'))), 1, 6),
  'opened', 'Dora opens her work in K1');
SELECT is(pg_temp.seal('dora', pg_temp.ddoc(), pg_temp.id('key_d'), 50), '1296', 'Dora seals a note on it');

-- 3. Refused: nothing changes.
SELECT matches(pg_temp.checked('anon', pg_temp.id('key_a')::text, NULL), '^ZD401', 'starting over needs a session');
SELECT is(pg_temp.checked('ana', NULL, NULL), 'ZD422: invalid input', 'a checked delete must name a key');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a')::text, '0'), 'ZD422: invalid input', 'a version under 1 is refused');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a2')::text, NULL), 'ZD409: conflict', 'another key id is refused');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a')::text, '1'), 'ZD409: conflict',
  'the version a stale device read is refused');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_d')::text, NULL), 'ZD409: conflict',
  'Ana naming Dora''s key deletes nothing of Dora''s: it is not her key');
SELECT is(pg_temp.checked('dora', pg_temp.id('key_a')::text, '2'), 'ZD409: conflict',
  'Dora naming Ana''s key and version deletes nothing of Ana''s');
SELECT is(pg_temp.ask('ana', $$ SELECT key_id || '|' || version FROM collaboration.get_self_note_key() $$),
  pg_temp.id('key_a') || '|2', 'Ana''s key is untouched by every refusal');
SELECT is(pg_temp.ask('ana', $$ SELECT octet_length(note_ct)::text FROM collaboration.get_work_self_note('doc-a') $$), '1296',
  'and so is her note');

-- 4. The named key at its current version: the key and every sealed note go.
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a')::text, '2'), 'true', 'Ana starts over under her key at version 2');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_self_note_key() $$), '0', 'no key of hers is left');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-a') $$), '0', 'the note on doc-a went with it');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a')::text, NULL), 'ZD409: conflict',
  'a second device naming the deleted key is refused, not answered as done');
SELECT is(pg_temp.ask('dora', format($$ SELECT (note_ct = %L::bytea) || '|' || note_key_id FROM collaboration.get_work_self_note(%L) $$,
    pg_temp.bytes(51, 1296), pg_temp.ddoc())),
  'true|' || pg_temp.id('key_d'), 'Dora''s sealed note stays byte for byte under her key');

-- 5. Without a version: the named key, whatever its version.
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a2'), NULL, 60), '1', 'Ana sets a new key');
SELECT is(pg_temp.checked('ana', pg_temp.id('key_a2')::text, NULL), 'true', 'and starts over naming only the key');
SELECT is(pg_temp.ask('dora', $$ SELECT key_id || '|' || version FROM collaboration.get_self_note_key() $$),
  pg_temp.id('key_d') || '|1', 'Dora''s key stays');

SELECT * FROM finish();
ROLLBACK;
