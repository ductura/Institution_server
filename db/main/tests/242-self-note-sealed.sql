-- SRV-NF6-SIFRA (Ductus#2055; owner decision B2 of 24 Nov 2026,
-- docs/contracts/self-note-sealed-v1.md): the sealed note to self and the
-- wrapped note key (20261217150000). Personas of institution.inc,
-- evidence-acceptance.inc and mentorship.inc, all invented: Ana writes doc-a
-- in Vesna's course K1 and zm1 under her mentor Marko; Dora is another
-- student of K1. The bytes are invented patterns, not real ciphertext.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

-- 1. Catalogue: owner, forced RLS, one owner policy, no direct privilege.
SELECT ok((SELECT relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity
             FROM pg_class WHERE oid = 'collaboration.self_note_key'::regclass),
  'the identity role owns the key table and RLS is forced on it');
SELECT bag_eq(
  $$ SELECT policyname::text || ' ' || roles::text || ' ' || cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename = 'self_note_key' $$,
  $$ VALUES ('self_note_key_owner {ductus_identity} ALL') $$,
  'the key table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.self_note_key', p) $$,
  'no runtime role reads or writes the key table directly');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.get_self_note_key()',
        'collaboration.put_self_note_key(uuid,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea)',
        'collaboration.delete_self_note_key()', 'collaboration.set_work_sealed_self_note(text,uuid,bytea,bytea)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.get_self_note_key()'),
            ('ductus_app collaboration.put_self_note_key(uuid,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea)'),
            ('ductus_app collaboration.delete_self_note_key()'),
            ('ductus_app collaboration.set_work_sealed_self_note(text,uuid,bytea,bytea)') $$,
  'the web role alone calls the four new RPCs');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.get_self_note_key()'::regprocedure,
        'collaboration.put_self_note_key(uuid,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea)'::regprocedure,
        'collaboration.delete_self_note_key()'::regprocedure,
        'collaboration.set_work_sealed_self_note(text,uuid,bytea,bytea)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the RPCs are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT is_empty(
  $$ SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace = 'collaboration'::regnamespace
      AND proname IN ('set_work_self_note', 'is_self_note_text') $$,
  'no function writes or checks a note in the clear any more');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

-- 2. No text of the note in the tables: only bytes of fixed length.
SELECT bag_eq(
  $$ SELECT column_name::text || ' ' || data_type::text FROM information_schema.columns
      WHERE table_schema = 'collaboration' AND table_name = 'work_self_note' $$,
  $$ VALUES ('institution_id uuid'), ('document_id text'), ('owner_id uuid'), ('note_updated_at timestamp with time zone'),
            ('reading_place jsonb'), ('reading_updated_at timestamp with time zone'),
            ('note_key_id uuid'), ('note_iv bytea'), ('note_ct bytea') $$,
  'the note row keeps a key id, an iv and a ciphertext; the work id and the reading place are the only text');
SELECT is_empty(
  $$ SELECT column_name::text FROM information_schema.columns
      WHERE table_schema = 'collaboration' AND table_name = 'self_note_key'
        AND data_type NOT IN ('uuid', 'integer', 'bytea', 'timestamp with time zone') $$,
  'the key row has no text column: no phrase, no recovery code, no key in the clear');

-- Patterns of invented bytes, distinct per seed.
CREATE FUNCTION pg_temp.bytes(p_seed integer, p_length integer) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(string_agg(lpad(to_hex((i * 7 + p_seed) % 256), 2, '0'), '' ORDER BY i), 'hex')
    FROM generate_series(1, p_length) AS i
$$;
CREATE FUNCTION pg_temp.put_key(p_actor text, p_key uuid, p_version text, p_seed integer,
  p_lengths integer[] DEFAULT ARRAY[16, 12, 48, 16, 12, 48], p_iterations integer DEFAULT 600000) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT version || '|' || (phrase_ct = %L::bytea) || '|' || (recovery_salt = %L::bytea)
          FROM collaboration.put_self_note_key(%L::uuid, %s, %s, %L, %L, %L, %L, %L, %L) $q$,
    pg_temp.bytes(p_seed + 3, p_lengths[3]), pg_temp.bytes(p_seed + 4, p_lengths[4]),
    p_key, coalesce(p_version, 'NULL'), p_iterations,
    pg_temp.bytes(p_seed + 1, p_lengths[1]), pg_temp.bytes(p_seed + 2, p_lengths[2]), pg_temp.bytes(p_seed + 3, p_lengths[3]),
    pg_temp.bytes(p_seed + 4, p_lengths[4]), pg_temp.bytes(p_seed + 5, p_lengths[5]), pg_temp.bytes(p_seed + 6, p_lengths[6])))
$$;
CREATE FUNCTION pg_temp.seal(p_actor text, p_doc text, p_key uuid, p_seed integer,
  p_iv integer DEFAULT 12, p_ct integer DEFAULT 1296) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT (note_iv = %L::bytea) || '|' || (note_ct = %L::bytea) || '|' || note_key_id
          FROM collaboration.set_work_sealed_self_note(%L, %L::uuid, %L, %L) $q$,
    pg_temp.bytes(p_seed, p_iv), pg_temp.bytes(p_seed + 1, p_ct),
    p_doc, p_key, pg_temp.bytes(p_seed, p_iv), pg_temp.bytes(p_seed + 1, p_ct)))
$$;
INSERT INTO ref VALUES ('key_a', '00000000-0000-4000-8000-0000000006a1'), ('key_d', '00000000-0000-4000-8000-0000000006d1');

-- 3. The wrapped key: the caller's own.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_self_note_key() $$), '0', 'Ana keeps no key yet');
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM collaboration.get_self_note_key() $$), '^ZD401', 'reading a key needs a session');
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_a'), 10), 'ZD409: conflict', 'without a key no note is sealed');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), NULL, 20, b.lengths, b.iterations), 'ZD422: invalid input',
  'a key ' || b.why || ' is refused')
  FROM (VALUES (ARRAY[15, 12, 48, 16, 12, 48], 600000, 'with a short phrase salt'),
               (ARRAY[16, 11, 48, 16, 12, 48], 600000, 'with a short phrase iv'),
               (ARRAY[16, 12, 47, 16, 12, 48], 600000, 'with a short phrase wrap'),
               (ARRAY[16, 12, 48, 17, 12, 48], 600000, 'with a long recovery salt'),
               (ARRAY[16, 12, 48, 16, 13, 48], 600000, 'with a long recovery iv'),
               (ARRAY[16, 12, 48, 16, 12, 49], 600000, 'with a long recovery wrap'),
               (ARRAY[16, 12, 48, 16, 12, 48], 599999, 'under 600000 iterations'),
               (ARRAY[16, 12, 48, 16, 12, 48], 10000001, 'over 10000000 iterations')) AS b (lengths, iterations, why);
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*) FROM collaboration.put_self_note_key(%L::uuid, NULL, 600000, %L, %L, %L, %L, %L, %L) $$,
    pg_temp.id('key_a'), pg_temp.bytes(1, 16), pg_temp.bytes(2, 12), pg_temp.bytes(3, 48), pg_temp.bytes(1, 16), pg_temp.bytes(5, 12), pg_temp.bytes(6, 48))),
  'ZD422: invalid input', 'the two wraps never share a salt');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.put_self_note_key(NULL, NULL, 600000, NULL, NULL, NULL, NULL, NULL, NULL) $$),
  'ZD422: invalid input', 'a key without its parts is refused');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), NULL, 20), '1|true|true', 'Ana sets her key; it comes back as written');
SELECT is(pg_temp.ask('ana', format($$ SELECT key_id || '|' || version || '|' || kdf_iterations || '|' || (phrase_salt = %L::bytea) || '|' || (recovery_ct = %L::bytea) FROM collaboration.get_self_note_key() $$,
    pg_temp.bytes(21, 16), pg_temp.bytes(26, 48))),
  pg_temp.id('key_a') || '|1|600000|true|true', 'and reads it back unchanged');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), NULL, 30), 'ZD409: conflict', 'a second first set is refused');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), '2', 30), 'ZD409: conflict', 'a rewrap under a version that is not the current one is refused');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_d'), '1', 30), 'ZD409: conflict', 'a rewrap that names another key is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT version FROM collaboration.get_self_note_key() $$), '1', 'and none of them changed the key');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_a'), '1', 30), '2|true|true', 'Ana rewraps the same key under a new phrase');
SELECT is(pg_temp.ask(a, $$ SELECT count(*) FROM collaboration.get_self_note_key() $$), '0', a || ' reads no key of Ana''s')
  FROM (VALUES ('dora'), ('marko'), ('vesna')) AS t (a);
SELECT is(pg_temp.put_key('dora', pg_temp.id('key_a'), '2', 40), 'ZD409: conflict', 'Dora cannot rewrap Ana''s key');
SELECT is(pg_temp.put_key('dora', pg_temp.id('key_d'), NULL, 40), '1|true|true', 'Dora sets a key of her own');
SELECT is(pg_temp.ask('ana', $$ SELECT version || '|' || key_id FROM collaboration.get_self_note_key() $$), '2|' || pg_temp.id('key_a'),
  'Ana''s key is untouched by Dora''s');

-- 4. The sealed note: stored and answered byte for byte, the owner's alone.
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_a'), 50), 'true|true|' || pg_temp.id('key_a'),
  'Ana seals a note on doc-a; the iv and the ciphertext come back unchanged');
SELECT is(pg_temp.ask('ana', format($$ SELECT (note_iv = %L::bytea) || '|' || (note_ct = %L::bytea) FROM collaboration.get_work_self_note('doc-a') $$,
    pg_temp.bytes(50, 12), pg_temp.bytes(51, 1296))),
  'true|true', 'and are read back unchanged');
SELECT is((SELECT note_ct = pg_temp.bytes(51, 1296) FROM collaboration.work_self_note WHERE document_id = 'doc-a'), true,
  'the table keeps exactly the ciphertext it was given');
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_d'), 52), 'ZD409: conflict', 'a note under another key is refused');
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_a'), 52, b.iv, b.ct), 'ZD422: invalid input', 'a note ' || b.why || ' is refused')
  FROM (VALUES (11, 1296, 'with a short iv'), (12, 1295, 'with a short ciphertext'), (12, 1297, 'with a long ciphertext'),
               (12, 0, 'with no ciphertext')) AS b (iv, ct, why);
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.set_work_sealed_self_note('doc-a', NULL, NULL, NULL) $$), 'ZD422: invalid input',
  'a note without its parts is refused');
SELECT is(pg_temp.ask(a, $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-a') $$), 'ZD403: forbidden',
  a || ' reads nothing of Ana''s note')
  FROM (VALUES ('dora'), ('vesna'), ('marko'), ('petra'), ('tomo')) AS t (a);
SELECT is(pg_temp.seal('dora', 'doc-a', pg_temp.id('key_d'), 60), 'ZD403: forbidden', 'Dora cannot seal a note on Ana''s work, even under her own key');
SELECT is(pg_temp.seal('vesna', 'doc-a', pg_temp.id('key_a'), 60), 'ZD403: forbidden', 'the teacher of the course cannot write it');
SELECT matches(pg_temp.seal('anon', 'doc-a', pg_temp.id('key_a'), 60), '^ZD401', 'writing a note needs a session');
SELECT is((SELECT note_ct = pg_temp.bytes(51, 1296) FROM collaboration.work_self_note WHERE document_id = 'doc-a'), true,
  'no refused write changed the note');

-- The mentored work of Ana: a second note under the same key.
CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 6),
  'opened', 'Ana opens her mentored work');
SELECT is(pg_temp.seal('ana', pg_temp.mdoc(), pg_temp.id('key_a'), 70), 'true|true|' || pg_temp.id('key_a'), 'Ana seals a note on it too');
SELECT is(pg_temp.ask('marko', format($$ SELECT count(*) FROM collaboration.get_work_self_note(%L) $$, pg_temp.mdoc())), 'ZD403: forbidden',
  'her mentor reads nothing of it');
SELECT is(pg_temp.ask('ana', format($$ SELECT reading_place->>'offset' FROM collaboration.set_work_reading_place(%L, '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 7}') $$, pg_temp.mdoc())),
  '7', 'the reading place next to it is kept as before, not sealed');

-- The database itself keeps a note only under its owner's key.
CREATE FUNCTION pg_temp.as_identity(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_state text := 'done';
BEGIN
  SET LOCAL ROLE ductus_identity;
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_state;
END
$$;
SELECT is(pg_temp.as_identity(format($$ UPDATE collaboration.work_self_note SET note_key_id = %L WHERE document_id = 'doc-a' $$, pg_temp.id('key_d'))),
  '23503', 'a note under the key of another person breaks the foreign key');
SELECT is(pg_temp.as_identity($$ UPDATE collaboration.work_self_note SET note_iv = NULL WHERE document_id = 'doc-a' $$),
  '23514', 'a sealed note is whole or absent');

-- 5. Starting over: the key and every sealed note go, the reading place stays.
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.delete_self_note_key()::text $$), 'true', 'Ana deletes her key');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_self_note_key() $$), '0', 'no key of hers is left');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-a') $$), '0', 'the note on doc-a went with it');
SELECT is(pg_temp.ask('ana', format($$ SELECT coalesce(octet_length(note_ct)::text, '-') || '|' || (reading_place->>'offset') FROM collaboration.get_work_self_note(%L) $$, pg_temp.mdoc())),
  '-|7', 'the note on the mentored work went; its reading place stays');
SELECT is(pg_temp.seal('ana', 'doc-a', pg_temp.id('key_a'), 80), 'ZD409: conflict', 'the old key seals nothing any more');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.delete_self_note_key()::text $$), 'false', 'deleting no key changes nothing');
SELECT is(pg_temp.ask('dora', $$ SELECT version FROM collaboration.get_self_note_key() $$), '1', 'Dora''s key stays');
SELECT matches(pg_temp.ask('anon', $$ SELECT collaboration.delete_self_note_key()::text $$), '^ZD401', 'deleting a key needs a session');
SELECT is(pg_temp.put_key('ana', pg_temp.id('key_d'), NULL, 90), '1|true|true', 'Ana starts over with a new key');

SELECT * FROM finish();
ROLLBACK;
