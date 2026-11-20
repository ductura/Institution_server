-- SRV-7B (Ductus#2028, c.7036862354; D-59, D-226): the sources of a student's
-- work. The student adds, changes and removes the own; a reader of the work
-- (teacher or collaborator of the course, seminar group teacher, mentor)
-- reads them; a teacher's source (recommended or required) is not the
-- student's to change. Every person, course, source and text below is
-- invented (fixtures/institution.inc, fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(60);

-- A valid book record with id p_id, merged with p_extra.
CREATE FUNCTION pg_temp.rec(p_id text, p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'type', 'book', 'year', 2024, 'title', 'Kućno kompostiranje',
           'authors', jsonb_build_array(jsonb_build_object('kind', 'person', 'family', 'Izmišljenić', 'given', 'Mara')),
           'place', 'Zagreb', 'publisher', 'Izmišljena naklada') || p_extra
$$;
-- 'ok' for a saved source, else the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.save(p_actor text, p_assignment text, p_record jsonb,
                             p_doi text DEFAULT NULL, p_isbn text DEFAULT NULL,
                             p_undated boolean DEFAULT false) RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM institution.save_work_source(%s, %L::jsonb, %L, %L, %L::boolean)',
    p_assignment, p_record, p_doi, p_isbn, p_undated)), 1, 5)
$$;
-- The titles read, oldest first and joined with '|', '-' for none, or the SQLSTATE.
CREATE FUNCTION pg_temp.titles(p_actor text, p_assignment text, p_student text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE r END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT coalesce(string_agg(record->>''title'', ''|'' ORDER BY created_at, id), ''-'') FROM institution.work_sources(%s, %s)',
      p_assignment, p_student)) AS r) x
$$;
INSERT INTO ref VALUES ('s1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('s2', 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'),
                       ('t1', 'cccccccc-cccc-4ccc-acc0-cccccccccccc');

-- 1. Catalogue: the table, its RLS and who may call what.
SELECT table_owner_is('institution', 'work_source', 'ductus_identity', 'the owner role owns the sources');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'institution.work_source'::regclass),
  'ENABLE and FORCE ROW LEVEL SECURITY');
SELECT bag_eq(
  $$ SELECT policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE schemaname = 'institution' AND tablename = 'work_source' $$,
  ARRAY['work_source_owner ALL to ductus_identity'],
  'only the owner''s policy: no role reads or writes the table but through the RPCs'
);
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.work_source_record_valid(uuid,jsonb)',
                             'institution.work_source_access(uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the owner executes the shape check and the relation helper'
);

-- 2. The record: the closed shape the table keeps, checked before the relation.
SELECT is(pg_temp.save('ana', '{z1}', t.r), t.outcome, t.label)
FROM (VALUES
  (pg_temp.rec('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), 'ZD422', 'an id in capitals is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'), 'ZD422', 'an id of another UUID version is refused'),
  (pg_temp.rec('00000000-0000-0000-0000-000000000000'), 'ZD422', 'the nil id is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"type": "thesis"}'), 'ZD422', 'an unknown type is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"title": ""}'), 'ZD422', 'an empty title is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jsonb_build_object('title', repeat('a', 1001))), 'ZD422',
   'a title of 1001 characters is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"year": "2024"}'), 'ZD422', 'a year as text is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"year": 999}'), 'ZD422', 'a year before 1000 is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"year": 2024.5}'), 'ZD422', 'a year that is not whole is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"authors": []}'), 'ZD422', 'no author is refused'),
  (pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"authors": {}}'), 'ZD422', 'authors that are no list are refused'),
  ('[]'::jsonb, 'ZD422', 'a record that is no object is refused')
) AS t (r, outcome, label);
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jsonb_build_object('authors',
  (SELECT jsonb_agg(jsonb_build_object('kind', 'organization', 'name', 'Udruga ' || n)) FROM generate_series(1, 51) n)))),
  'ZD422', '51 authors are refused');
SELECT is(pg_temp.save('boris', '{z1}', '{}'::jsonb), 'ZD422',
  'the record is checked before the relation, so its refusal says nothing of the assignment');
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), t.doi, t.isbn), t.outcome, t.label)
FROM (VALUES
  ('10.1000/Izmisljeno', NULL, 'ZD422', 'a DOI with capitals is refused (one spelling)'),
  ('doi:10.1000/x', NULL, 'ZD422', 'a DOI with a prefix is refused'),
  ('10.1000/a b', NULL, 'ZD422', 'a DOI with a space is refused'),
  (NULL, '978-953-0-00000-0', 'ZD422', 'an ISBN with hyphens is refused (digits only)'),
  (NULL, '12345', 'ZD422', 'an ISBN of five digits is refused'),
  (NULL, '9771234567890', 'ZD422', 'a thirteen-digit ISBN outside 978 and 979 is refused'),
  ('10.1000/izmisljeno.2024', '9789530000000', 'ok', 'a DOI and an ISBN-13 are kept'),
  (NULL, '953000000X', 'ok', 'an ISBN-10 with X is kept; the change clears the DOI')
) AS t (doi, isbn, outcome, label);
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), NULL, '953000000X', NULL), 'ZD422',
  'no answer to "without a year" is refused');
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), NULL, '953000000X', true), 'ok',
  'a source without a year ("b. g.") is kept, its record still with a year');
SELECT results_eq(
  $$ SELECT p.name, w.institution_id, w.added_by = w.student_id, w.requirement, w.doi, w.isbn, w.undated,
            w.updated_at >= w.created_at
       FROM institution.work_source w JOIN person p ON p.id = w.student_id $$,
  $$ VALUES ('ana', pg_temp.id('fak_a'), true, NULL::text, NULL::text, '953000000X', true, true) $$,
  'one row: Ana''s, of her institution, added by her, without requirement, changed in place'
);
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, added_by) VALUES (%L, %L, %L, %L, %L, %L)',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), pg_temp.id('ana'))), 1, 5), '23514',
  'the table refuses a record whose id is not the row''s');
SELECT is(substr(pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, added_by) VALUES (%L, %L, %L, %L, %L, %L)',
  pg_temp.id('fak_b'), pg_temp.id('z1'), pg_temp.id('ana'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), pg_temp.id('ana'))), 1, 5), '23503',
  'a source cannot combine an assignment and a student of another institution');

-- 3. A teacher's source: Vesna's required reading in Ana's work (written as
-- the owner; the teacher's RPC is a later step). Ana reads it, but neither
-- changes nor removes it, and a row without requirement is the student's.
INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, requirement, added_by)
VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'cccccccc-cccc-4ccc-acc0-cccccccccccc',
        pg_temp.rec('cccccccc-cccc-4ccc-acc0-cccccccccccc', '{"title": "Obvezno štivo"}'), 'required', pg_temp.id('vesna'));
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('cccccccc-cccc-4ccc-acc0-cccccccccccc', '{"title": "Moje"}')), 'ZD403',
  'Ana cannot change the teacher''s source');
SELECT is(substr(pg_temp.ask('ana', $$ SELECT institution.delete_work_source({z1}, {t1})::text $$), 1, 5), 'ZD403',
  'nor remove it');
SELECT is(pg_temp.titles('ana', '{z1}', '{ana}'), 'Kućno kompostiranje|Obvezno štivo', 'Ana reads both, oldest first');
SELECT throws_ok(format(
  'INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, requirement, added_by) VALUES (%L, %L, %L, %L, %L, NULL, %L)',
  pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  pg_temp.rec('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), pg_temp.id('vesna')), '23514', NULL,
  'a source without requirement added by someone else than the student is refused');

-- 4. Who reads besides the student: seminar group teacher, collaborator, mentor.
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.save('dora', '{z1}', pg_temp.rec('bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', '{"title": "Dorin izvor"}')), 'ok',
  'Dora saves a source of her own');
SELECT is(pg_temp.titles(c.actor, c.assignment, c.student), c.outcome,
  format('%s reads the sources of %s on %s: %s', c.actor, c.student, c.assignment, c.outcome))
FROM (VALUES
  ('marko', '{z1}', '{ana}', 'Kućno kompostiranje|Obvezno štivo'), ('marko', '{z1}', '{dora}', 'ZD403'),
  ('vesna', '{z1}', '{dora}', 'Dorin izvor'), ('dora', '{z1}', '{dora}', 'Dorin izvor'),
  ('ana', '{z1}', '{dora}', 'ZD403'), ('vesna', '{z1}', '{vesna}', 'ZD403'), ('vesna', '{z1}', '{nobody}', 'ZD403'),
  ('vesna', 'NULL', '{ana}', 'ZD403')
) AS c (actor, assignment, student, outcome);
SELECT is(pg_temp.save('marko', '{z1}', pg_temp.rec('ffffffff-ffff-4fff-8fff-ffffffffffff')), 'ZD403',
  'the seminar group teacher saves no source in his own name');
SELECT is(pg_temp.save('ana', '{zm1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"title": "Za mentora"}')), 'ok',
  'Ana saves a source on the mentorship''s assignment, apart from Z1');
SELECT is(pg_temp.titles('marko', '{zm1}', '{ana}'), 'Za mentora', 'her mentor reads it');
SELECT is(pg_temp.titles('vesna', '{zm1}', '{ana}'), 'ZD403', 'the teacher of K1 does not');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no read of the sources writes the access log');

-- 5. At most 500 sources per work; a change of an existing one still passes.
INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, added_by)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), u, pg_temp.rec(u::text), pg_temp.id('dora')
  FROM (SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS u FROM generate_series(1, 499) n) g;
SELECT is(pg_temp.save('dora', '{z1}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD422',
  'the 501st source is refused');
SELECT is(pg_temp.save('dora', '{z1}', pg_temp.rec('bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', '{"title": "Dorin izvor 2"}')), 'ok',
  'a change of one of the 500 passes');
SELECT is(substr(pg_temp.ask('dora', $$ SELECT institution.delete_work_source({z1}, {s2})::text $$), 1, 5), 'true',
  'Dora removes it');
SELECT is(pg_temp.save('dora', '{z1}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ok',
  'and then one more fits');

-- 6. A removed student keeps the list but neither changes nor reads it.
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('ana') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.save('ana', '{z1}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')), 'ZD403', 'removed: no change');
SELECT is(pg_temp.titles('ana', '{z1}', '{ana}'), 'ZD403', 'removed: no read');
SELECT is((SELECT count(*) FROM institution.work_source WHERE student_id = pg_temp.id('ana')), 3::bigint,
  'removal deletes no source');

-- 7. A mistaken grant to the web role still reaches no row.
GRANT SELECT, INSERT, UPDATE, DELETE ON institution.work_source TO ductus_app;
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM institution.work_source'), '0', 'mistaken grant: SELECT sees 0 rows');
SELECT is(pg_temp.ask('dora', $$WITH x AS (DELETE FROM institution.work_source RETURNING 1) SELECT count(*)::text FROM x$$), '0',
  'mistaken grant: DELETE touches 0 rows');

SELECT * FROM finish();
ROLLBACK;
