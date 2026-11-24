-- SRV-MENTOR-3B (Ductus#2055; review of #669): the retention role removes the
-- rows of works that no longer exist, through the per-work deletions, and a
-- student without the student role on a work still reads and deletes the own
-- note to self (20261217120000). Personas of institution.inc and
-- evidence-acceptance.inc, all invented: Ana writes doc-a in Vesna's course
-- K1; Dora is another student of K1; Tomo belongs to the other institution.
-- "doc-nestao" is a work whose document is gone. Since 20261217150000 the
-- note is sealed (SRV-NF6-SIFRA): the notes here are invented bytes under
-- each owner's wrapped key, never text.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- 1. Catalogue: the retention role alone calls the purge; nobody calls the helper.
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.purge_orphan_work_data()', 'collaboration.self_note_owner_scope(text)',
        'collaboration.get_work_self_note(text)', 'collaboration.clear_work_self_note(text,text)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_retention collaboration.purge_orphan_work_data()'),
            ('ductus_app collaboration.get_work_self_note(text)'),
            ('ductus_app collaboration.clear_work_self_note(text,text)') $$,
  'the retention role alone purges, the web role keeps reading and deleting the note, nobody calls the owner scope');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.purge_orphan_work_data()'::regprocedure, 'collaboration.get_work_self_note(text)'::regprocedure,
        'collaboration.clear_work_self_note(text,text)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the purge and the two replaced RPCs are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'collaboration.self_note_owner_scope(text)'::regprocedure), 's',
  'the owner scope only reads');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');

-- 2. Rows of a work that exists, written through the RPCs.
INSERT INTO ref VALUES ('key_ana', '00000000-0000-4000-8000-0000000007a1'), ('key_tomo', '00000000-0000-4000-8000-0000000007b1');
CREATE FUNCTION pg_temp.sealed(p_hex text, p_length integer) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(repeat(p_hex, p_length), 'hex')
$$;
SELECT is(pg_temp.ask('ana', format($$ SELECT version FROM collaboration.put_self_note_key(%L::uuid, NULL, 600000, %L, %L, %L, %L, %L, %L) $$,
    pg_temp.id('key_ana'), pg_temp.sealed('01', 16), pg_temp.sealed('02', 12), pg_temp.sealed('03', 48),
    pg_temp.sealed('04', 16), pg_temp.sealed('05', 12), pg_temp.sealed('06', 48))),
  '1', 'Ana keeps her wrapped note key');
-- Tomo's key in the other institution, written directly as its owner would.
INSERT INTO collaboration.self_note_key (institution_id, owner_id, key_id, version, kdf_iterations, phrase_salt, phrase_iv, phrase_ct,
  recovery_salt, recovery_iv, recovery_ct)
VALUES (pg_temp.id('fak_b'), pg_temp.id('tomo'), pg_temp.id('key_tomo'), 1, 600000, pg_temp.sealed('11', 16), pg_temp.sealed('12', 12),
        pg_temp.sealed('13', 48), pg_temp.sealed('14', 16), pg_temp.sealed('15', 12), pg_temp.sealed('16', 48));
CREATE FUNCTION pg_temp.seal(p_actor text, p_doc text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT (note_ct = %L::bytea)::text FROM collaboration.set_work_sealed_self_note(%L, %L::uuid, %L, %L) $q$,
    pg_temp.sealed('a2', 1296), p_doc, pg_temp.id('key_ana'), pg_temp.sealed('a1', 12), pg_temp.sealed('a2', 1296)))
$$;
SELECT is(pg_temp.seal('ana', 'doc-a'), 'true', 'Ana seals a note on her existing work');
SELECT ok(pg_temp.ask('ana', $$ SELECT message_id::text FROM collaboration.create_work_message('doc-a', 'Pitanje o izvoru.') $$) ~ '^[0-9a-f-]{36}$',
  'Ana sends a message on it');

-- Rows left behind by works whose document is gone (written directly: no RPC
-- writes on a work that does not exist), and a row under the id of an
-- existing document but in another institution, where no such document is.
INSERT INTO collaboration.work_self_note (institution_id, document_id, owner_id, note_key_id, note_iv, note_ct, note_updated_at, reading_place, reading_updated_at)
VALUES (pg_temp.id('fak_a'), 'doc-nestao', pg_temp.id('ana'), pg_temp.id('key_ana'), pg_temp.sealed('c1', 12), pg_temp.sealed('c2', 1296), now(),
        '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 3}', now()),
       (pg_temp.id('fak_b'), 'doc-a', pg_temp.id('tomo'), pg_temp.id('key_tomo'), pg_temp.sealed('b1', 12), pg_temp.sealed('b2', 1296), now(), NULL, NULL);
INSERT INTO collaboration.work_item_seen (institution_id, document_id, item_kind, item_id, viewer_id)
VALUES (pg_temp.id('fak_a'), 'doc-nestao', 'message', '00000000-0000-4000-8000-000000000391', pg_temp.id('ana'));
INSERT INTO collaboration.work_message (institution_id, document_id, assignment_id, owner_id, author_id, sender_role, body)
VALUES (pg_temp.id('fak_a'), 'doc-nestao', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'teacher', 'Stara poruka.');
INSERT INTO collaboration.teacher_note (institution_id, document_id, assignment_id, owner_id, author_id, body)
VALUES (pg_temp.id('fak_a'), 'doc-nestao', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'Stara bilješka nastavnika.');

CREATE FUNCTION pg_temp.rows(p_document text) RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM collaboration.work_self_note WHERE document_id = p_document),
    (SELECT count(*) FROM collaboration.work_item_seen WHERE document_id = p_document),
    (SELECT count(*) FROM collaboration.work_message WHERE document_id = p_document),
    (SELECT count(*) FROM collaboration.teacher_note WHERE document_id = p_document))
$$;
SELECT is(pg_temp.rows('doc-nestao'), '1|1|1|1', 'the gone work has a note, a mark, a message and a teacher''s note');
SELECT is(pg_temp.rows('doc-a'), '2|0|1|0', 'doc-a has Ana''s note and message, and the other institution''s note');

-- 3. The owner reads and deletes the own note of a work that is gone; nobody else does.
SELECT is(pg_temp.ask('ana', format($$ SELECT (note_ct = %L::bytea) || '|' || (reading_place->>'offset') FROM collaboration.get_work_self_note('doc-nestao') $$, pg_temp.sealed('c2', 1296))),
  'true|3', 'Ana still reads her note of a work that is gone');
SELECT is(pg_temp.ask(a, $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-nestao') $$), 'ZD403: forbidden',
  a || ' reads nothing of it')
  FROM (VALUES ('vesna'), ('dora'), ('marko'), ('tomo')) AS t (a);
SELECT is(pg_temp.seal('ana', 'doc-nestao'), 'ZD403: forbidden', 'but cannot write on a work that is gone');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-drugi') $$), 'ZD403: forbidden',
  'a work without her note reads as another''s');
SELECT is(pg_temp.ask('tomo', format($$ SELECT (note_ct = %L::bytea)::text FROM collaboration.get_work_self_note('doc-a') $$, pg_temp.sealed('b2', 1296))), 'true',
  'in his own institution Tomo reads only his own kept note under that id, never Ana''s');
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-nestao') $$), '^ZD401',
  'reading still needs a session');

-- 4. The dry run counts exactly what the purge removes and keeps every row.
CREATE FUNCTION pg_temp.dry_run() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
BEGIN
  BEGIN
    SET LOCAL ROLE ductus_retention;
    v_result := collaboration.purge_orphan_work_data()::text;
    RAISE EXCEPTION USING ERRCODE = 'ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    NULL;
  END;
  RESET ROLE;
  RETURN v_result;
END
$$;
SELECT is(pg_temp.dry_run(), '5', 'the dry run counts the four rows of the gone work and the row of the other institution');
SELECT is(pg_temp.rows('doc-nestao') || ' ' || pg_temp.rows('doc-a'), '1|1|1|1 2|0|1|0', 'and removes nothing');
SELECT is(pg_temp.ask(a, $$ SELECT collaboration.purge_orphan_work_data()::text $$), '42501: permission denied for function purge_orphan_work_data',
  a || ' cannot purge')
  FROM (VALUES ('ana'), ('vesna')) AS t (a);
SELECT matches(pg_temp.ask_as(r, 'ana', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '^42501: permission denied for (function purge_orphan_work_data|schema collaboration)$',
  r || ' cannot purge')
  FROM (VALUES ('ductus_worker'), ('ductus_auth'), ('ductus_evidence'), ('ductus_test_stranger')) AS t (r);

-- 5. The purge removes the rows of works that are gone, and only those.
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '5',
  'the retention role, without a session, removes five rows');
SELECT is(pg_temp.rows('doc-nestao'), '0|0|0|0', 'nothing of the gone work is left');
SELECT is((SELECT count(*) FROM collaboration.work_self_note WHERE document_id = 'doc-a' AND institution_id = pg_temp.id('fak_b')), 0::bigint,
  'nor the row of the other institution');
SELECT is(pg_temp.rows('doc-a'), '1|0|1|0', 'Ana''s note and message on her existing work stay');
SELECT is(pg_temp.ask_as('ductus_retention', 'anon', $$ SELECT collaboration.purge_orphan_work_data()::text $$), '0',
  'a second run finds nothing more');

-- 6. A student who left the course keeps the right to read and delete the own note.
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('ana') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.ask('ana', format($$ SELECT (note_ct = %L::bytea)::text FROM collaboration.get_work_self_note('doc-a') $$, pg_temp.sealed('a2', 1296))), 'true',
  'Ana, no longer a student of K1, reads her note');
SELECT is(pg_temp.seal('ana', 'doc-a'), 'ZD403: forbidden', 'but cannot write it any more');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.set_work_reading_place('doc-a', '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 1}') $$), 'ZD403: forbidden',
  'nor the reading place');
SELECT is(pg_temp.ask(a, $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-a') $$), 'ZD403: forbidden',
  a || ' still reads nothing of Ana''s note')
  FROM (VALUES ('vesna'), ('dora'), ('marko')) AS t (a);
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.clear_work_self_note('doc-a', 'note') $$), 'ZD403: forbidden',
  'and Vesna, the teacher, cannot delete it');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.clear_work_self_note('doc-a', 'sve') $$), 'ZD422: invalid input',
  'Ana still clears only the note or the reading place');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.clear_work_self_note('doc-a', 'note') $$), '0',
  'Ana deletes her note on request; nothing is left to answer');
SELECT is((SELECT count(*) FROM collaboration.work_self_note WHERE document_id = 'doc-a'), 0::bigint, 'and no row is kept');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.get_work_self_note('doc-a') $$), 'ZD403: forbidden',
  'with nothing kept and no role, the work reads as another''s again');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.clear_work_self_note('doc-a', 'note') $$), 'ZD403: forbidden',
  'and deleting again is refused the same way');
SELECT is(pg_temp.rows('doc-a'), '0|0|1|0', 'the work itself and its message are untouched');

SELECT * FROM finish();
ROLLBACK;
