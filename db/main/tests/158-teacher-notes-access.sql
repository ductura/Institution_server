-- SRV-8B (wave 8, Ductus#2051): the mentor's working records of D-130,
-- private notes and comment templates (20261121120000). The access matrix of
-- both tables: only the author reads a note, and only while a teacher of the
-- work; the student of the work, another teacher of the same work, a stranger,
-- an administrator and another institution never do. Templates belong to
-- their author alone. Nothing here touches the document, its hash chain or
-- the access log, and the notes go with the document. Every person, document
-- and text below is invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

INSERT INTO ref VALUES
  ('anchor', '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}');

-- Marko teaches K1 too, from before Ana's work, so a second teacher of the
-- same work is there to be refused.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher', now() - interval '1 day');

-- The evidence schema and the access log as one value each, to show that
-- nothing below writes them.
CREATE FUNCTION pg_temp.schema_print(p_schema text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t text;
  part text;
  acc text := '';
BEGIN
  FOR t IN SELECT relname FROM pg_class WHERE relnamespace = p_schema::regnamespace AND relkind IN ('r', 'p') ORDER BY relname LOOP
    EXECUTE format('SELECT string_agg(row_to_json(x)::text, ''|'' ORDER BY row_to_json(x)::text) FROM %I.%I x', p_schema, t) INTO part;
    acc := acc || t || ':' || coalesce(part, '') || ';';
  END LOOP;
  RETURN md5(acc);
END
$$;
CREATE TEMP TABLE print_before AS SELECT pg_temp.schema_print('evidence') AS evidence, pg_temp.schema_print('audit') AS audit;

-- 1. Catalogue: owner, forced RLS, one owner policy, no direct privilege.
SELECT bag_eq(
  $$ SELECT relname::text FROM pg_class WHERE relnamespace = 'collaboration'::regnamespace AND relkind = 'r'
      AND relname IN ('teacher_note', 'comment_template')
      AND relowner = 'ductus_identity'::regrole AND relrowsecurity AND relforcerowsecurity $$,
  $$ VALUES ('teacher_note'), ('comment_template') $$,
  'the identity role owns both tables and RLS is forced on each');
SELECT bag_eq(
  $$ SELECT tablename::text, policyname::text, roles::text, cmd FROM pg_policies
      WHERE schemaname = 'collaboration' AND tablename IN ('teacher_note', 'comment_template') $$,
  $$ VALUES ('teacher_note', 'teacher_note_owner', '{ductus_identity}', 'ALL'),
            ('comment_template', 'comment_template_owner', '{ductus_identity}', 'ALL') $$,
  'each table has one policy, for its owner alone');
SELECT is_empty(
  $$ SELECT r || ' ' || p || ' ' || t FROM unnest(ARRAY['teacher_note', 'comment_template']) AS t
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      WHERE has_table_privilege(r, 'collaboration.' || t, p) $$,
  'no runtime role reads or writes a note or a template directly');
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('collaboration.create_teacher_note(text,text,jsonb)'::regprocedure,
        'collaboration.list_teacher_notes(text)'::regprocedure, 'collaboration.delete_teacher_note(uuid)'::regprocedure,
        'collaboration.delete_teacher_notes(text,uuid)'::regprocedure,
        'collaboration.create_comment_template(text,text)'::regprocedure,
        'collaboration.list_comment_templates()'::regprocedure, 'collaboration.delete_comment_template(uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_identity'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the seven functions are SECURITY DEFINER functions of the identity role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'ductus_test_stranger']) AS r
      CROSS JOIN unnest(ARRAY['collaboration.create_teacher_note(text,text,jsonb)', 'collaboration.list_teacher_notes(text)',
        'collaboration.delete_teacher_note(uuid)', 'collaboration.delete_teacher_notes(text,uuid)',
        'collaboration.create_comment_template(text,text)', 'collaboration.list_comment_templates()',
        'collaboration.delete_comment_template(uuid)']) AS f
      WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  $$ VALUES ('ductus_app collaboration.create_teacher_note(text,text,jsonb)'),
            ('ductus_app collaboration.list_teacher_notes(text)'),
            ('ductus_app collaboration.delete_teacher_note(uuid)'),
            ('ductus_app collaboration.create_comment_template(text,text)'),
            ('ductus_app collaboration.list_comment_templates()'),
            ('ductus_app collaboration.delete_comment_template(uuid)'),
            ('ductus_retention collaboration.delete_teacher_notes(text,uuid)') $$,
  'the web role writes, reads and removes, the retention role alone deletes a document''s notes');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'collaboration', 'CREATE'),
  'after the migration the identity role keeps no CREATE on the schema');
SELECT is(pg_get_function_arguments('collaboration.create_teacher_note(text,text,jsonb)'::regprocedure),
  'p_document_id text, p_body text, p_anchor jsonb DEFAULT NULL::jsonb',
  'a note takes no author, owner, institution or time: they come from the session and the document');
SELECT is(pg_get_function_result('collaboration.list_teacher_notes(text)'::regprocedure),
  'TABLE(note_id uuid, body text, anchor jsonb, created_at timestamp with time zone)',
  'the note listing names no person: every row is the caller''s own');
SELECT is(pg_get_function_arguments('collaboration.create_comment_template(text,text)'::regprocedure),
  'p_body text, p_kind text DEFAULT ''must''::text', 'a template takes no author or institution either');

-- 2. Writing a note: the teacher of the work alone.
INSERT INTO ref SELECT 'n1', pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Provjeriti izvor u drugom odlomku.', {anchor}::jsonb) $$);
SELECT matches((SELECT val FROM ref WHERE name = 'n1'), '^[0-9a-f-]{36}$', 'the teacher of K1 writes an anchored note on Ana''s document');
INSERT INTO ref SELECT 'n2', pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Na konzultacijama pitati o strukturi.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'n2'), '^[0-9a-f-]{36}$', 'a note without an anchor is on the work as a whole');
INSERT INTO ref SELECT 'm1', pg_temp.ask('marko', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Moja zasebna bilješka.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'm1'), '^[0-9a-f-]{36}$', 'a second teacher of the same work writes a note of his own');
INSERT INTO ref SELECT 'p1', pg_temp.ask('petra', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-b', 'Bilješka uz rad iz K3.') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'p1'), '^[0-9a-f-]{36}$', 'the teacher of K3 writes a note on Tomo''s document');
SELECT is(pg_temp.ask(a.name, $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Tekst.') $$), 'ZD403: forbidden',
  a.name || ' cannot write a note on Ana''s document')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-nema', 'Tekst.') $$), 'ZD403: forbidden',
  'a missing document reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Tekst.') $$), '^ZD401',
  'a note with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('vesna', format($$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', %L) $$, b.body)), 'ZD422: invalid input',
  'a note body ' || b.why || ' is refused')
FROM (VALUES (NULL, 'missing'), ('   ', 'of blanks only'), (repeat('a', 2001), 'over 2000 characters'),
             (E'a‮b', 'with a bidirectional override')) AS b (body, why);
SELECT is(pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Tekst.', '{"nodeId":"x"}'::jsonb) $$),
  'ZD422: invalid input', 'an anchor that is not a text anchor is refused');

-- The row: scope from the document, author from the session.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, owner_id, author_id, anchor = (SELECT val FROM ref WHERE name = 'anchor')::jsonb
      FROM collaboration.teacher_note WHERE id = pg_temp.id('n1') $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), true),
  'the note takes its scope from the document and its author from the session');

-- 3. Reading: the author alone, while a teacher of the work.
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(body, ' / ' ORDER BY created_at, note_id) FROM collaboration.list_teacher_notes('doc-a') $$),
  'Provjeriti izvor u drugom odlomku. / Na konzultacijama pitati o strukturi.',
  'Vesna reads her two notes and not Marko''s');
SELECT is(pg_temp.ask('marko', $$ SELECT string_agg(body, ' / ') FROM collaboration.list_teacher_notes('doc-a') $$),
  'Moja zasebna bilješka.', 'another teacher of the same work reads only his own note');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_teacher_notes('doc-a') WHERE anchor IS NULL $$), '1',
  'the note on the whole work lists with a null anchor');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_teacher_notes('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no note on Ana''s document')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('nina'), ('petra'), ('tomo'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM collaboration.list_teacher_notes('doc-a') $$), '^ZD401',
  'reading notes needs a session');
SELECT is(pg_temp.ask('petra', $$ SELECT string_agg(body, ' / ') FROM collaboration.list_teacher_notes('doc-b') $$),
  'Bilješka uz rad iz K3.', 'the teacher of K3 reads her note on Tomo''s document');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM collaboration.list_teacher_notes('doc-b') $$), 'ZD403: forbidden',
  'the student of a work never reads the notes on it');
-- The student's own listings carry nothing of a note.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM collaboration.list_comments('doc-a') $$), '0',
  'a note is not a comment: Ana''s comment listing stays empty');

-- 4. Removing: the author alone.
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.delete_teacher_note({n2}) $$), 'ZD403: forbidden',
  a.name || ' cannot remove Vesna''s note')
FROM (VALUES ('marko'), ('ana'), ('iva'), ('petra')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.delete_teacher_note({nobody}) $$), 'ZD403: forbidden',
  'a note that does not exist reads as a forbidden one');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.delete_teacher_note({n2})::text $$), '',
  'Vesna removes her note on the whole work');
SELECT is((SELECT count(*) FROM collaboration.teacher_note WHERE id = pg_temp.id('n2')), 0::bigint, 'the removed note is gone');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.delete_teacher_note({n2}) $$), 'ZD403: forbidden',
  'removing it again is refused like any missing note');

-- 5. Templates: a confirmed teacher saves them; each reads and removes only her own.
INSERT INTO ref SELECT 't1', pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Tvrdnja traži izvor. Odakle je ovaj podatak?') $$);
SELECT matches((SELECT val FROM ref WHERE name = 't1'), '^[0-9a-f-]{36}$', 'Vesna saves a template of the default kind');
INSERT INTO ref SELECT 't2', pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Dobro povezano s prethodnim poglavljem.', 'praise') $$);
SELECT matches((SELECT val FROM ref WHERE name = 't2'), '^[0-9a-f-]{36}$', 'Vesna saves a template of another kind');
SELECT matches(pg_temp.ask('petra', $$ SELECT template_id FROM collaboration.create_comment_template('Dodajte stranicu u navod.', 'must') $$),
  '^[0-9a-f-]{36}$', 'a teacher of another institution saves her own');
SELECT is(pg_temp.ask(a.name, $$ SELECT template_id FROM collaboration.create_comment_template('Tekst.') $$), 'ZD403: forbidden',
  a.name || ' without a confirmed teacher role saves no template')
FROM (VALUES ('ana'), ('boris'), ('nina'), ('iva')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT template_id FROM collaboration.create_comment_template('Tekst.') $$), '^ZD401',
  'saving a template needs a session');
SELECT is(pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Tekst.', 'ocjena') $$), 'ZD422: invalid input',
  'a kind outside the four is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template(' ', 'q') $$), 'ZD422: invalid input',
  'a blank template is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(kind || ':' || body, ' / ' ORDER BY created_at, template_id) FROM collaboration.list_comment_templates() $$),
  'must:Tvrdnja traži izvor. Odakle je ovaj podatak? / praise:Dobro povezano s prethodnim poglavljem.',
  'Vesna reads her two templates');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_comment_templates() $$), a.seen,
  a.name || ' reads ' || a.seen || ' templates: never Vesna''s')
FROM (VALUES ('marko', '0'), ('ana', '0'), ('iva', '0'), ('petra', '1')) AS a (name, seen);
SELECT is(pg_temp.ask(a.name, $$ SELECT collaboration.delete_comment_template({t1}) $$), 'ZD403: forbidden',
  a.name || ' cannot remove Vesna''s template')
FROM (VALUES ('marko'), ('ana'), ('petra')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.delete_comment_template({t1})::text $$), '', 'Vesna removes her template');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_comment_templates() $$), '1', 'one template is left');

-- 6. Bounds: 500 notes of one author on one document, 200 templates of one author.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.teacher_note (institution_id, document_id, assignment_id, owner_id, author_id, body)
SELECT pg_temp.id('fak_a'), 'doc-a', pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna'), 'Bilješka ' || g
FROM generate_series(1, 499 - (SELECT count(*) FROM collaboration.teacher_note WHERE author_id = pg_temp.id('vesna'))) g;
INSERT INTO collaboration.comment_template (institution_id, author_id, kind, body)
SELECT pg_temp.id('fak_a'), pg_temp.id('vesna'), 'q', 'Predložak ' || g FROM generate_series(1, 198) g;
RESET ROLE;
SELECT matches(pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Petstota.') $$), '^[0-9a-f-]{36}$',
  'the 500th note of an author on a document is written');
SELECT is(pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Previše.') $$), 'ZD422: invalid input',
  'the 501st is refused');
SELECT matches(pg_temp.ask('marko', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'I dalje može.') $$), '^[0-9a-f-]{36}$',
  'the bound is per author: another teacher of the work still writes');
SELECT matches(pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Dvjestoti.') $$), '^[0-9a-f-]{36}$',
  'the 200th template is saved');
SELECT is(pg_temp.ask('vesna', $$ SELECT template_id FROM collaboration.create_comment_template('Previše.') $$), 'ZD422: invalid input',
  'the 201st is refused');

-- 7. Nothing written in the evidence schema or the access log (D-266, D-130).
SELECT is(pg_temp.schema_print('evidence'), (SELECT evidence FROM print_before),
  'no note or template wrote anything in the evidence schema: the hash chain of the work is untouched');
SELECT is(pg_temp.schema_print('audit'), (SELECT audit FROM print_before),
  'reading and writing notes leaves no row in the access log (PRODUCT §5 rule 17)');

-- 8. A teacher who leaves the course loses the notes at once; they stay for retention.
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('vesna') AND member_to IS NULL;
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.list_teacher_notes('doc-a') $$), 'ZD403: forbidden',
  'Vesna, no longer a teacher of K1, reads none of her notes');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.delete_teacher_note({n1}) $$), 'ZD403: forbidden',
  'nor removes one');
SELECT is(pg_temp.ask('vesna', $$ SELECT note_id FROM collaboration.create_teacher_note('doc-a', 'Tekst.') $$), 'ZD403: forbidden',
  'nor writes one');
SELECT ok((SELECT count(*) FROM collaboration.teacher_note WHERE author_id = pg_temp.id('vesna')) = 500,
  'her notes are still stored, for the retention rule and the student''s right of access');

-- 9. The notes go with the document (D-130), only through the retention role.
SELECT matches(pg_temp.ask('vesna', $$ SELECT collaboration.delete_teacher_notes('doc-a', {fak_a}) $$), '^42501',
  'the web role cannot call the retention delete');
SET LOCAL ROLE ductus_retention;
SELECT collaboration.delete_teacher_notes('doc-b', pg_temp.id('fak_a'));
SELECT collaboration.delete_teacher_notes('doc-a', pg_temp.id('fak_a'));
SELECT collaboration.delete_teacher_notes('doc-nema', pg_temp.id('fak_a'));
RESET ROLE;
SELECT is((SELECT count(*) FROM collaboration.teacher_note WHERE document_id = 'doc-a'), 0::bigint,
  'after the retention delete no note of the document is left, of any author');
SELECT is((SELECT count(*) FROM collaboration.teacher_note WHERE document_id = 'doc-b'), 1::bigint,
  'a delete with another institution leaves the other document''s note alone');
SELECT is((SELECT count(*) FROM collaboration.comment_template WHERE author_id = pg_temp.id('vesna')), 200::bigint,
  'templates name no work and stay with their author');

SELECT * FROM finish();
ROLLBACK;
