-- PIL-K-RAZGOVOR-SRV (Ductus#2052): the student's note attached to the
-- interview preparation. Only the student who owns the work attaches it, only
-- after the invitation and before the interview is held; a plain text or a
-- PDF up to the limit. The attachment goes to the trail. Every person, course,
-- document and file below is invented (fixtures/institution.inc; the documents
-- are those of 222).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- 1. Catalogue: the table, its RLS and who may call the RPC.
SELECT table_owner_is('institution', 'work_interview_note', 'ductus_identity', 'the notes are owned by the owner role');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.work_interview_note'::regclass),
  'work_interview_note: ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE tablename = 'work_interview_note' $$,
  ARRAY['work_interview_note_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the notes but through the RPC');
SELECT is_empty(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['ductus_app', 'public']) r
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
      WHERE has_table_privilege(r, 'institution.work_interview_note', p) $$,
  'the web role has no privilege on the notes');
SELECT is_empty(
  $$ SELECT r.rolname || ' may use ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.add_work_interview_note(text,text,text,bytea)',
                             'institution.is_work_interview_note(text,bytea)',
                             'institution.work_interview_note_max_bytes()',
                             'institution.work_interview_note_max_count()']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the RPC');
SELECT ok(has_function_privilege('ductus_app', 'institution.add_work_interview_note(text,text,text,bytea)', 'EXECUTE'),
  'the web role calls the RPC');
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.is_work_interview_note(text,bytea)', 'EXECUTE'),
  'the web role does not call the helper');
SELECT is(institution.work_interview_note_max_bytes(), 1048576, 'a note holds at most 1 MiB');

-- 2. Before the invitation the student attaches nothing; nor does anyone without the relation.
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Moja bilješka.', 'UTF8')) $$),
  'ZD403: forbidden', 'the student attaches no note to a work with no interview');
SELECT matches(pg_temp.ask('vesna', $$ SELECT (institution.add_work_interview_question('doc-a', NULL, 'Kako si radila?'))->>'id' $$),
  '^[0-9a-f-]{36}$', 'Vesna prepares a question');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Moja bilješka.', 'UTF8')) $$),
  'ZD403: forbidden', 'the student attaches no note before the invitation');
SELECT matches(pg_temp.ask('vesna', $$ SELECT institution.invite_work_interview('doc-a')->>'invitedAt' $$), '^20',
  'Vesna invites the student');

-- 3. After the invitation: the owner attaches; nobody else does.
SELECT is(pg_temp.ask(a.name, $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Tuđa bilješka.', 'UTF8')) $$),
  'ZD403: forbidden', a.name || ' attaches no note to Ana''s work')
FROM (VALUES ('vesna'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask(t.name, $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('x', 'UTF8')) $$),
  '^ZD401', 'a note with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-b', 'biljeska.txt', 'text/plain', convert_to('x', 'UTF8')) $$),
  'ZD403: forbidden', 'a work of another institution reads as a forbidden one');

INSERT INTO ref SELECT 'n1', pg_temp.ask('ana',
  $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Moja bilješka uz razgovor.', 'UTF8'))->>'id' $$);
SELECT matches((SELECT val FROM ref WHERE name = 'n1'), '^[0-9a-f-]{36}$', 'Ana attaches a text note');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Moja bilješka uz razgovor.', 'UTF8'))->>'id' $$),
  (SELECT val FROM ref WHERE name = 'n1'), 'the same bytes again answer the note already kept');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'skica.pdf', 'application/pdf', '\x255044462d312e340a'::bytea) - 'id' - 'createdAt' $$),
  jsonb_build_object('fileName', 'skica.pdf', 'mediaType', 'application/pdf', 'byteSize', 9,
                     'sha256', encode(sha256('\x255044462d312e340a'::bytea), 'hex'))::text,
  'Ana attaches a PDF; the server derives the size and the SHA-256');
SELECT is((SELECT count(*)::int FROM institution.work_interview_note), 2, 'two notes are kept');
SELECT row_eq(
  $$ SELECT n.institution_id, n.author_id FROM institution.work_interview_note n WHERE n.id = pg_temp.id('n1') $$,
  ROW(pg_temp.id('fak_a'), pg_temp.id('ana')),
  'the note takes its scope from the work and its author from the session');
SELECT is((SELECT string_agg(kind, ',' ORDER BY occurred_at, kind) FROM audit.work_interview_event WHERE kind = 'note_attached'),
  'note_attached,note_attached', 'each new note is on the trail once');

-- 4. Only a text or a PDF, within the limits.
SELECT is(pg_temp.ask('ana', format($$ SELECT institution.add_work_interview_note('doc-a', %L, %L, %L::bytea) $$, f.name, f.media, f.content)),
  'ZD422: invalid input', f.why)
FROM (VALUES
  ('slika.png', 'image/png', '\x89504e470d0a1a0a', 'an image is refused'),
  ('lazni.pdf', 'application/pdf', '\x6e6973746f', 'a PDF without its header is refused'),
  ('binarno.txt', 'text/plain', '\x00ff', 'a text that is not UTF-8 is refused'),
  ('kontrola.txt', 'text/plain', '\x610762', 'a text with a control character is refused'),
  ('', 'text/plain', '\x61', 'an empty file name is refused'),
  ('mapa/biljeska.txt', 'text/plain', '\x61', 'a file name with a path is refused'),
  (' biljeska.txt', 'text/plain', '\x61', 'a file name with surrounding spaces is refused'),
  ('prazno.txt', 'text/plain', '\x', 'an empty file is refused')
) AS f (name, media, content, why);
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'veliko.txt', 'text/plain', convert_to(repeat('a', 1048577), 'UTF8')) $$),
  'ZD422: invalid input', 'a file over 1 MiB is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'tocno.txt', 'text/plain', convert_to(repeat('b', 1048576), 'UTF8'))->>'byteSize' $$),
  '^1048576$', 'a file of exactly 1 MiB is kept');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', NULL) $$),
  'ZD422: invalid input', 'no content is refused');

-- 5. A work at its bound of notes takes no more.
SELECT is(pg_temp.ask('ana', format($$ SELECT institution.add_work_interview_note('doc-a', 'b.txt', 'text/plain', convert_to(%L, 'UTF8'))->>'mediaType' $$, 'Bilješka ' || n)),
  'text/plain', 'note ' || n || ' is kept')
FROM generate_series(4, 20) AS n;
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'b.txt', 'text/plain', convert_to('Dvadeset i prva.', 'UTF8')) $$),
  'ZD422: invalid input', 'the 21st note is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'biljeska.txt', 'text/plain', convert_to('Moja bilješka uz razgovor.', 'UTF8'))->>'id' $$),
  (SELECT val FROM ref WHERE name = 'n1'), 'a note already kept is still answered at the bound');

-- 6. A held interview takes no new note.
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', current_date)->>'heldOn' $$),
  to_char(current_date, 'YYYY-MM-DD'), 'Vesna marks the interview held');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_note('doc-a', 'kasno.txt', 'text/plain', convert_to('Kasna bilješka.', 'UTF8')) $$),
  'ZD409: not allowed', 'a held interview takes no new note');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_note('doc-a', 'kasno.txt', 'text/plain', convert_to('Kasna bilješka.', 'UTF8')) $$),
  'ZD403: forbidden', 'the teacher is refused before the state is looked at');
SELECT throws_ok($$ UPDATE audit.work_interview_event SET kind = 'held' WHERE kind = 'note_attached' $$, NULL, NULL,
  'the trail stays append-only');

SELECT * FROM finish();
ROLLBACK;
