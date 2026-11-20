-- SRV-1102 (Ductus#2051; editor E§3.4 "proofs", B-8): the proofs of a
-- source, the JPEG excerpts a student attaches to a source of the own work.
-- The student attaches and reads the own; a reader of the work (teacher of
-- the course, seminar group teacher, mentor) reads them; nobody else, and no
-- role alone (C-23). A whole PDF is refused. Every person, course, source and
-- image below is invented (fixtures/institution.inc, fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(99);

INSERT INTO ref VALUES
  ('src_a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('src_b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('src_c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('src_d', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

-- An invented JPEG: the start of a JPEG, a word, the end marker.
CREATE FUNCTION pg_temp.jpeg(p_word text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'ffd8ffe0' || encode(convert_to(p_word, 'UTF8'), 'hex') || 'ffd9'
$$;
CREATE FUNCTION pg_temp.source_json(p_id text) RETURNS text LANGUAGE sql AS $$
  SELECT format('{"id": "%s", "type": "book", "year": 2024, '
                '"authors": [{"kind": "person", "family": "Izmišljenić", "given": "Mara"}], '
                '"title": "Kućno kompostiranje", "place": "Zagreb", "publisher": "Izmišljena naklada"}', p_id)
$$;
CREATE FUNCTION pg_temp.source(p_actor text, p_assignment text, p_id text) RETURNS text LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format('SELECT ''ok'' FROM institution.save_work_source(%s, %L::jsonb)',
                                            p_assignment, pg_temp.source_json((SELECT val FROM ref WHERE '{' || name || '}' = p_id)))), 1, 5)
$$;
-- 'ok' or the SQLSTATE of the refusal; the image is given as hex.
CREATE FUNCTION pg_temp.proof(p_actor text, p_assignment text, p_source text, p_page text,
                              p_note text, p_hex text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r = 'ok' THEN 'ok' ELSE substr(r, 1, 5) END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT ''ok'' FROM institution.add_source_proof(%s, %s, %L, %L, decode(%L, ''hex''))',
      p_assignment, p_source, p_page, p_note, p_hex)) AS r) x
$$;
-- The pages (with the note, '-' for none) of one source, oldest first and
-- joined with '|', '-' for none, or the SQLSTATE.
CREATE FUNCTION pg_temp.pages(p_actor text, p_assignment text, p_source text, p_student text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(page || ''/'' || coalesce(note, ''-''), ''|'' ORDER BY created_at, id), ''-'') FROM institution.source_proofs(%s, %s, %s)',
      p_assignment, p_source, p_student)) AS r) x
$$;
-- The bytes of one proof as text, or the SQLSTATE.
CREATE FUNCTION pg_temp.image(p_actor text, p_assignment text, p_source text, p_proof text, p_student text)
RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT convert_from(substr(image, 5, octet_length(image) - 6), ''UTF8'') FROM institution.read_source_proof_image(%s, %s, %s, %s)',
      p_assignment, p_source, p_proof, p_student)) AS r) x
$$;

-- 1. Catalogue: the table, its RLS and who may call what.
SELECT table_owner_is('institution', 'source_proof', 'ductus_identity', 'the owner role owns the proofs');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.source_proof'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'institution' AND tablename = 'source_proof' $$,
  ARRAY['source_proof_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.add_source_proof(uuid,uuid,text,text,bytea)',
                             'institution.source_proofs(uuid,uuid,uuid)',
                             'institution.read_source_proof_image(uuid,uuid,uuid,uuid)',
                             'institution.source_proof_text_valid(text,integer,boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the RPCs; nobody else, nor PUBLIC'
);
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.source_proof_text_valid(text,integer,boolean)', 'EXECUTE'),
  'the web role does not execute the shape check');
SELECT ok(NOT has_table_privilege('ductus_app', 'institution.source_proof', 'SELECT'),
  'the web role holds no privilege on the table');

-- Fixture: Ana's sources A and B on Z1, Dora's source A on Z1, Tomo's A on Z3.
SELECT is(pg_temp.source('ana', '{z1}', '{src_a}'), 'ok', 'fixture: Ana adds source A');
SELECT is(pg_temp.source('ana', '{z1}', '{src_b}'), 'ok', 'fixture: Ana adds source B');
SELECT is(pg_temp.source('dora', '{z1}', '{src_a}'), 'ok', 'fixture: Dora adds a source A of her own');
SELECT is(pg_temp.source('tomo', '{z3}', '{src_a}'), 'ok', 'fixture: Tomo adds source A on Z3');

-- 2. The input: checked before the relation, so a refusal says nothing of
-- the assignment or the source.
SELECT is(pg_temp.proof('ana', '{z1}', '{src_a}', t.page, t.note, t.hex), 'ZD422', t.label)
FROM (VALUES
  ('', NULL, pg_temp.jpeg('a'), 'an empty page is refused'),
  (NULL, NULL, pg_temp.jpeg('a'), 'no page is refused'),
  (repeat('1', 31), NULL, pg_temp.jpeg('a'), 'a page over 30 characters is refused'),
  (' 14', NULL, pg_temp.jpeg('a'), 'a page with a space in front is refused'),
  ('14 ', NULL, pg_temp.jpeg('a'), 'a page with a space at the end is refused'),
  (E'1\n4', NULL, pg_temp.jpeg('a'), 'a page with a line break is refused'),
  ('14', '', pg_temp.jpeg('a'), 'an empty note is refused (no note is null)'),
  ('14', E'a\tb', pg_temp.jpeg('a'), 'a note with a tab is refused'),
  ('14', repeat('n', 2001), pg_temp.jpeg('a'), 'a note over 2000 characters is refused'),
  ('14', NULL, NULL, 'no image is refused'),
  ('14', NULL, 'ffd8ff', 'an image of three bytes is refused'),
  ('14', NULL, encode(convert_to('%PDF-1.7 izmisljeni dokument %%EOF', 'UTF8'), 'hex'), 'a whole PDF is refused'),
  ('14', NULL, '89504e470d0a1a0a0000', 'a PNG is refused: only the JPEG excerpt is kept'),
  ('14', NULL, 'ffd8ffe0' || repeat('00', 1048573), 'an image over 1 MiB is refused')
) AS t (page, note, hex, label);
SELECT is(pg_temp.proof('boris', '{z1}', '{src_c}', '', NULL, pg_temp.jpeg('a')), 'ZD422',
  'the input is checked first, so its refusal says nothing of the assignment');

-- 3. Ana attaches two proofs to source A; read again, each is bound to the
-- same source and page.
SELECT is(pg_temp.proof('ana', '{z1}', '{src_a}', '14', E'Prvi odlomak\ndrugi red', pg_temp.jpeg('prva')), 'ok',
  'Ana attaches an excerpt of page 14 with a note');
SELECT is(pg_temp.proof('ana', '{z1}', '{src_a}', 'xii', NULL, pg_temp.jpeg('druga')), 'ok',
  'and one of page xii without a note');
SELECT is(pg_temp.proof('ana', '{z1}', '{src_a}', repeat('9', 30), repeat('n', 2000),
                        'ffd8ffe0' || repeat('00', 1048572)), 'ok',
  'a page of 30, a note of 2000 and an image of exactly 1 MiB pass');
SELECT is(pg_temp.pages('ana', '{z1}', '{src_a}', 'NULL'),
  E'14/Prvi odlomak\ndrugi red|xii/-|' || repeat('9', 30) || '/' || repeat('n', 2000),
  'read again: the three proofs of source A, oldest first, with their pages');
SELECT is(pg_temp.pages('ana', '{z1}', '{src_b}', 'NULL'), '-', 'source B holds none of them');
SELECT results_eq(
  $$ SELECT p.name, s.institution_id, s.source_id::text, s.page, s.byte_size, s.sha256 = encode(sha256(s.image), 'hex')
       FROM institution.source_proof s JOIN person p ON p.id = s.student_id
      WHERE s.page IN ('14', 'xii') ORDER BY s.created_at, s.id $$,
  $$ VALUES ('ana', pg_temp.id('fak_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '14', 10, true),
            ('ana', pg_temp.id('fak_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'xii', 11, true) $$,
  'stored as Ana''s, of her institution, on source A, with size and hash of the exact bytes'
);
SELECT ok((SELECT bool_and(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
             FROM institution.source_proof),
  'every id is a lowercase UUID v4');
INSERT INTO ref SELECT 'pf_14', id::text FROM institution.source_proof WHERE page = '14';
INSERT INTO ref SELECT 'pf_xii', id::text FROM institution.source_proof WHERE page = 'xii';
SELECT is(pg_temp.image('ana', '{z1}', '{src_a}', '{pf_14}', 'NULL'), 'prva', 'Ana reads the bytes of page 14');
SELECT is(pg_temp.image('ana', '{z1}', '{src_a}', '{pf_xii}', '{ana}'), 'druga', 'and of page xii');
SELECT is(pg_temp.image('ana', '{z1}', '{src_b}', '{pf_14}', 'NULL'), 'ZD403',
  'the proof is not found under another source');
SELECT is(pg_temp.image('ana', '{zm1}', '{src_a}', '{pf_14}', 'NULL'), 'ZD403',
  'nor under another assignment of hers');
SELECT is(pg_temp.image('ana', '{z1}', '{src_a}', '''eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee''', 'NULL'), 'ZD403',
  'a proof that does not exist is ZD403');
SELECT is(pg_temp.proof('ana', '{z1}', '{src_c}', '3', NULL, pg_temp.jpeg('c')), 'ZD403',
  'a source that is not in her work takes no proof');
SELECT is(pg_temp.pages('ana', '{z1}', '{src_c}', 'NULL'), 'ZD403', 'and lists none: ZD403');

-- 4. Who attaches: only the student of the work, on a source of that work.
SELECT is(pg_temp.proof(c.actor, c.assignment, c.source, '5', NULL, pg_temp.jpeg('x')), c.outcome,
  format('%s attaches a proof to %s on %s: %s', c.actor, c.source, c.assignment, c.outcome))
FROM (VALUES
  ('dora', '{z1}', '{src_a}', 'ok'), ('dora', '{z1}', '{src_b}', 'ZD403'), ('vesna', '{z1}', '{src_a}', 'ZD403'),
  ('marko', '{z1}', '{src_a}', 'ZD403'), ('iva', '{z1}', '{src_a}', 'ZD403'), ('boris', '{z1}', '{src_a}', 'ZD403'),
  ('nina', '{z1}', '{src_a}', 'ZD403'), ('tomo', '{z1}', '{src_a}', 'ZD403'), ('lea', '{z1}', '{src_a}', 'ZD403'),
  ('petra', '{z3}', '{src_a}', 'ZD403'), ('tomo', '{z3}', '{src_a}', 'ok'), ('anon', '{z1}', '{src_a}', 'ZD401')
) AS c (actor, assignment, source, outcome);
INSERT INTO ref SELECT 'pf_dora', id::text FROM institution.source_proof WHERE student_id = pg_temp.id('dora');

-- 5. Who reads: the student and a reader of the work; another student's work
-- is not found; an administrator role alone opens nothing (C-23).
SELECT is(pg_temp.pages(c.actor, c.assignment, '{src_a}', c.student), c.outcome,
  format('%s reads the proofs of %s on %s: %s', c.actor, c.student, c.assignment, c.outcome))
FROM (VALUES
  ('vesna', '{z1}', '{dora}', '5/-'), ('dora', '{z1}', 'NULL', '5/-'), ('ana', '{z1}', '{dora}', 'ZD403'),
  ('dora', '{z1}', '{ana}', 'ZD403'), ('marko', '{z1}', '{ana}', 'ZD403'), ('iva', '{z1}', '{ana}', 'ZD403'),
  ('boris', '{z1}', '{ana}', 'ZD403'), ('nina', '{z1}', '{ana}', 'ZD403'), ('petra', '{z1}', '{ana}', 'ZD403'),
  ('lea', '{z1}', '{ana}', 'ZD403'), ('petra', '{z3}', '{tomo}', '5/-'), ('vesna', '{z3}', '{tomo}', 'ZD403'),
  ('anon', '{z1}', '{ana}', 'ZD401')
) AS c (actor, assignment, student, outcome);
SELECT is(pg_temp.image(c.actor, '{z1}', '{src_a}', c.proof, c.student), c.outcome,
  format('%s reads the image %s of %s: %s', c.actor, c.proof, c.student, c.outcome))
FROM (VALUES
  ('vesna', '{pf_14}', '{ana}', 'prva'), ('dora', '{pf_14}', 'NULL', 'ZD403'), ('dora', '{pf_14}', '{ana}', 'ZD403'),
  ('ana', '{pf_dora}', '{dora}', 'ZD403'), ('ana', '{pf_dora}', 'NULL', 'ZD403'), ('dora', '{pf_dora}', 'NULL', 'x'),
  ('marko', '{pf_14}', '{ana}', 'ZD403'), ('iva', '{pf_14}', '{ana}', 'ZD403'), ('lea', '{pf_14}', '{ana}', 'ZD403'),
  ('petra', '{pf_14}', '{ana}', 'ZD403'), ('anon', '{pf_14}', '{ana}', 'ZD401')
) AS c (actor, proof, student, outcome);

-- 6. A seminar group teacher and a mentor read; a teacher's source takes the
-- student's proof.
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.pages('marko', '{z1}', '{src_a}', '{ana}'),
  E'14/Prvi odlomak\ndrugi red|xii/-|' || repeat('9', 30) || '/' || repeat('n', 2000),
  'the seminar group teacher reads Ana''s proofs');
SELECT is(pg_temp.pages('marko', '{z1}', '{src_a}', '{dora}'), 'ZD403', 'but not Dora''s, outside his group');
SELECT is(pg_temp.source('ana', '{zm1}', '{src_a}'), 'ok', 'fixture: Ana adds a source on the mentorship''s assignment');
SELECT is(pg_temp.proof('ana', '{zm1}', '{src_a}', '7', NULL, pg_temp.jpeg('mentor')), 'ok',
  'Ana attaches a proof there');
SELECT is(pg_temp.pages('marko', '{zm1}', '{src_a}', '{ana}'), '7/-', 'her mentor reads it');
SELECT is(pg_temp.pages('vesna', '{zm1}', '{src_a}', '{ana}'), 'ZD403', 'the teacher of K1 does not');
SELECT is(substr(pg_temp.ask('vesna', format(
  'SELECT ''ok'' FROM institution.save_teacher_work_source({z1}, {ana}, %L::jsonb, ''required'')',
  pg_temp.source_json('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))), 1, 5), 'ok',
  'fixture: Vesna requires source D of Ana');
SELECT is(pg_temp.proof('ana', '{z1}', '{src_d}', '2', NULL, pg_temp.jpeg('d')), 'ok',
  'Ana attaches a proof to the required source');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no read of the proofs writes the access log');

-- 7. The table itself: one institution, the exact bytes, a JPEG.
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256) VALUES (%L, %L, %L, %L, %L, %L::bytea, 6, encode(sha256(%L::bytea), ''hex''))',
  pg_temp.id('fak_b'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('src_a'), '1', '\xffd8ff00ffd9', '\xffd8ff00ffd9')), 1, 5),
  '23503', 'a proof cannot combine an assignment and a student of another institution');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256) VALUES (%L, %L, %L, %L, %L, %L::bytea, 6, %L)',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('src_a'), '1', '\xffd8ff00ffd9', repeat('a', 64))), 1, 5),
  '23514', 'the table refuses a hash that is not the hash of the bytes');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256) VALUES (%L, %L, %L, %L, %L, %L::bytea, 8, encode(sha256(%L::bytea), ''hex''))',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('src_a'), '1', '%PDF-1.7', '%PDF-1.7')), 1, 5),
  '23514', 'the table refuses a PDF even from the owner role');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256) VALUES (%L, %L, %L, %L, %L, %L::bytea, 6, encode(sha256(%L::bytea), ''hex''))',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('src_c'), '1', '\xffd8ff00ffd9', '\xffd8ff00ffd9')), 1, 5),
  '23503', 'a proof cannot name a source that is not in the work');

-- 8. Removing a source removes its proofs; the others stay.
SELECT is(pg_temp.proof('ana', '{z1}', '{src_b}', '3', NULL, pg_temp.jpeg('b')), 'ok', 'Ana attaches a proof to B');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.delete_work_source({z1}, {src_b})::text $$), 'true',
  'Ana removes source B');
SELECT is((SELECT count(*) FROM institution.source_proof WHERE source_id = pg_temp.id('src_b')), 0::bigint,
  'its proof went with it');
SELECT is((SELECT count(*) FROM institution.source_proof WHERE student_id = pg_temp.id('ana')
             AND assignment_id = pg_temp.id('z1') AND source_id = pg_temp.id('src_a')), 3::bigint,
  'the proofs of source A stay');

-- 9. At most 200 proofs per work.
INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), pg_temp.id('src_a'), n::text,
       decode(pg_temp.jpeg(n::text), 'hex'), octet_length(decode(pg_temp.jpeg(n::text), 'hex')),
       encode(sha256(decode(pg_temp.jpeg(n::text), 'hex')), 'hex')
  FROM generate_series(1, 199) n;
SELECT is(pg_temp.proof('dora', '{z1}', '{src_a}', '9', NULL, pg_temp.jpeg('y')), 'ZD422',
  'the 201st proof of a work is refused');

-- 10. A removed student neither attaches nor reads.
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('ana') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.proof('ana', '{z1}', '{src_a}', '1', NULL, pg_temp.jpeg('z')), 'ZD403', 'removed: no new proof');
SELECT is(pg_temp.image('ana', '{z1}', '{src_a}', '{pf_14}', 'NULL'), 'ZD403', 'removed: no read');

-- 11. A mistaken grant to the web role still reaches no row.
GRANT SELECT, INSERT, UPDATE, DELETE ON institution.source_proof TO ductus_app;
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM institution.source_proof'), '0',
  'mistaken grant: SELECT sees 0 rows');
SELECT is(substr(pg_temp.ask('dora', format(
  'INSERT INTO institution.source_proof (institution_id, assignment_id, student_id, source_id, page, image, byte_size, sha256) VALUES (%L, %L, %L, %L, %L, %L::bytea, 6, encode(sha256(%L::bytea), ''hex''))',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), pg_temp.id('src_a'), '1', '\xffd8ff00ffd9', '\xffd8ff00ffd9')), 1, 5),
  '42501', 'mistaken grant: INSERT is refused by RLS');

SELECT * FROM finish();
ROLLBACK;
