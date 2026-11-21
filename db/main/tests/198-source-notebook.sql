BEGIN;
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT plan(22);

INSERT INTO ref VALUES ('source', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                       ('other_source', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO ref SELECT 'work', pg_temp.ask('ana', $$ SELECT document_id FROM app.open_student_work({zm1}) $$);
SELECT matches((SELECT val FROM ref WHERE name = 'work'), '^[0-9a-f-]{36}$', 'student opens the mentored work');

CREATE FUNCTION pg_temp.source_record(p_id uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'type', 'book', 'year', 2026,
    'title', 'Izmišljeni priručnik o kišnim vrtovima', 'place', 'Zagreb',
    'publisher', 'Naklada Zeleni oblak',
    'authors', '[{"kind":"organization","name":"Izmišljeno društvo za kišne vrtove"}]'::jsonb)
$$;

SELECT is(pg_temp.ask('ana', format($$ SELECT 'ok' FROM institution.save_work_source({zm1}, %L::jsonb) $$,
    pg_temp.source_record('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))),
  'ok', 'student creates a fictional source on a mentored work');
SELECT is(pg_temp.ask('ana', format($$ SELECT 'ok' FROM institution.save_work_source({zm1}, %L::jsonb) $$,
    pg_temp.source_record('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))),
  'ok', 'student creates a second source');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*)::text FROM institution.work_sources({zm1}, {ana}) $$),
  '2', 'mentor can see the work sources');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.source_notes({work}, {source}, 'GET', NULL, NULL)::text $$),
  '[]', 'source starts with an empty notebook');

INSERT INTO ref SELECT 'note', pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'POST', NULL,
    '{"quote":"Vrt upija kišu.","page":"12–14","note":"Usporediti vrste tla."}')->>'id'
$$);
SELECT matches((SELECT val FROM ref WHERE name = 'note'), '^[0-9a-f-]{36}$', 'student creates a note');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.source_notes({work}, {source}, 'GET', NULL, NULL)->0->>'note' $$),
  'Usporediti vrste tla.', 'student reads the private note');
SELECT is(substr(pg_temp.ask(actor, $$
  SELECT institution.source_notes({work}, {source}, 'GET', NULL, NULL)::text
$$), 1, 5), expected, description)
FROM (VALUES ('marko', 'ZD403', 'mentor cannot see the note'),
             ('dora', 'ZD403', 'another student cannot see the note'),
             ('anon', 'ZD401', 'anonymous cannot see the note')) AS cases(actor, expected, description);
SELECT is(substr(pg_temp.ask('ana', $$ SELECT count(*)::text FROM institution.source_note $$), 1, 5),
  '42501', 'application actor has no direct table read');
SELECT is(substr(pg_temp.ask('marko', $$
  SELECT institution.source_notes({work}, {source}, 'PATCH', {note}, '{"note":"Promjena"}')::text
$$), 1, 5), 'ZD403', 'mentor cannot update the note');
SELECT is(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'PATCH', {note}, '{"page":null}')->>'quote'
$$), 'Vrt upija kišu.', 'patch preserves omitted fields');
SELECT is(pg_temp.ask('ana', $$
  SELECT (institution.source_notes({work}, {source}, 'GET', NULL, NULL)->0->'page')::text
$$), 'null', 'patch clears an explicit null field');
SELECT is(substr(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {other_source}, 'DELETE', {note}, NULL)::text
$$), 1, 5), 'ZD403', 'note id cannot be used under another source of the same student');
SELECT is(substr(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'PATCH', {note}, '{"quote":null,"note":null}')::text
$$), 1, 5), 'ZD422', 'patch cannot clear all content');
SELECT is(substr(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'POST', NULL, '{"studentId":"other","note":"tekst"}')::text
$$), 1, 5), 'ZD422', 'database refuses unknown fields');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.source_notes({work}, {source}, 'DELETE', {note}, NULL)::text $$),
  'null', 'student can delete a note');
SELECT is(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'POST', NULL, '{"note":"Bilješka za provjeru brisanja"}')->>'note'
$$), 'Bilješka za provjeru brisanja', 'student adds a note before deleting the source');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.delete_work_source({zm1}, {source})::text $$),
  'true', 'student deletes the parent source');
SELECT is_empty($$ SELECT id FROM institution.source_note $$, 'deleting a source cascades to its notes');
SELECT is(substr(pg_temp.ask('ana', $$
  SELECT institution.source_notes({work}, {source}, 'POST', NULL, '{"note":"Kasni upis"}')::text
$$), 1, 5), 'ZD403', 'a late write cannot recreate a note under the deleted source');

SELECT * FROM finish();
ROLLBACK;
