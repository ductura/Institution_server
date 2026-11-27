-- M2.12-P01b: an assignment version names the faculty rule version in force
-- for its kind of work when the assignment was created, and a mentorship's
-- work is checked against that version. Personas of institution.inc and
-- mentorship.inc; every person, course, rule and text is invented.
--
--   Iva administers fak-a; Vesna teaches K1, whose Z1 is an essay written
--   before fak-a had any essay rule; ZM1 is Ana's master thesis, written
--   under version 1 of the master thesis rule.
BEGIN;
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

INSERT INTO ref VALUES
  ('ms6', '00000000-0000-4000-8000-0000000000d6'),
  ('zm6', '00000000-0000-4000-8000-0000000000b6'),
  ('ms7', '00000000-0000-4000-8000-0000000000d7'),
  ('zm7', '00000000-0000-4000-8000-0000000000b7');

CREATE FUNCTION pg_temp.bound(p_assignment text, p_version integer) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(faculty_rule_version::text, 'none')
    FROM institution.assignment_version WHERE assignment_id = p_assignment::uuid AND version_no = p_version
$$;
CREATE FUNCTION pg_temp.publish_rule(p_work_type text, p_expected integer, p_policy text, p_purposes text,
                                     p_profile text) RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask('iva', format(
    'SELECT institution.publish_faculty_rule_version(%L, %s, %L, %L::text[], %L, false)',
    p_work_type, p_expected, p_policy, p_purposes, p_profile))
$f$;
CREATE FUNCTION pg_temp.create_essay() RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask('vesna', format(
    'SELECT institution.create_assignment({k1}, %L, %L, %L, now(), now() + interval %L, %L, %L::text[], %L, false, NULL, NULL)',
    'Esej', 'Upute za izmišljeni zadatak.', 'essay', '30 days', 'partially_allowed', '{proofreading}', 'basic'))
$f$;
CREATE FUNCTION pg_temp.publish_version(p_assignment text, p_expected integer, p_work_type text) RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask('vesna', format(
    'SELECT institution.publish_assignment_version(%L::uuid, %s, %L, %L, %L, now(), now() + interval %L, %L, %L::text[], %L, false, NULL::integer, NULL::integer)',
    p_assignment, p_expected, 'Esej', 'Nove upute.', p_work_type, '30 days', 'partially_allowed', '{proofreading}', 'basic'))
$f$;
-- A version written by the owner role, naming p_rule_version itself.
CREATE FUNCTION pg_temp.insert_version(p_assignment text, p_version integer, p_work_type text, p_policy text,
                                       p_purposes text, p_profile text, p_rule_version integer, p_author text)
RETURNS text
LANGUAGE sql AS $f$
  SELECT format(
    $q$ INSERT INTO institution.assignment_version (
          assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
          evidence_profile, import_allowed, faculty_rule_version, created_by)
        VALUES (%L, %s, 'Verzija', 'Upute.', %L, now(), now() + interval '30 days', %L, %L::text[], %L, false, %s, %L) $q$,
    p_assignment, p_version, p_work_type, p_policy, p_purposes, p_profile, coalesce(p_rule_version::text, 'NULL'),
    pg_temp.id(p_author))
$f$;

-- 1. The column, its key and the trigger function.
SELECT is((SELECT attnotnull FROM pg_attribute
            WHERE attrelid = 'institution.assignment_version'::regclass AND attname = 'faculty_rule_version'),
  false, 'faculty_rule_version is nullable: no rule for the kind of work, no version');
SELECT matches((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE conrelid = 'institution.assignment_version'::regclass
                   AND conname = 'assignment_version_faculty_rule_version_fkey'),
  '^FOREIGN KEY \(institution_id, work_type, faculty_rule_version\) REFERENCES (institution\.)?faculty_rule_version\(institution_id, work_type, version_no\)$',
  'the value is a version of the same institution and kind of work');
SELECT is((SELECT p.prosecdef::text || ' ' || has_function_privilege('ductus_app', p.oid, 'EXECUTE')::text
                  || ' ' || has_function_privilege('public', p.oid, 'EXECUTE')::text
             FROM pg_proc p WHERE p.oid = 'institution.link_assignment_rule_version()'::regprocedure),
  'true false false', 'the binding trigger runs as the owner and nobody else may call it');

-- 2. What existed before: an essay with no faculty rule names none, the
-- mentored works name version 1 of their kind.
SELECT is(pg_temp.bound(v.assignment, v.version_no), v.expected, v.what)
FROM (VALUES
  (1, '00000000-0000-4000-8000-0000000000a1', 1, 'none', 'Z1.1, written with no essay rule, names none'),
  (2, '00000000-0000-4000-8000-0000000000a1', 2, 'none', 'Z1.2 inherits that'),
  (3, '00000000-0000-4000-8000-0000000000b1', 1, '1', 'ZM1.1 names version 1 of the master thesis rule'),
  (4, '00000000-0000-4000-8000-0000000000b2', 1, '1', 'ZM2.1 names version 1 of the bachelor thesis rule')
) AS v (n, assignment, version_no, expected, what)
ORDER BY v.n;

-- 3. A new assignment names the latest published version, from the database.
SELECT is(pg_temp.publish_rule('essay', 0, 'partially_allowed', '{proofreading}', 'basic'), '1',
  'Iva publishes version 1 of the essay rule');
INSERT INTO ref VALUES ('e1', pg_temp.create_essay());
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 1), '1', 'a new essay names version 1');
SELECT is(pg_temp.bound('00000000-0000-4000-8000-0000000000a1', 2), 'none',
  'publishing does not bind an assignment written before');

-- 4. A newer faculty version leaves existing bindings as they are.
SELECT is(pg_temp.publish_rule('essay', 1, 'prohibited', '{}', 'basic'), '2', 'Iva publishes version 2 of the essay rule');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 1), '1',
  'the earlier essay still names version 1');
INSERT INTO ref VALUES ('e2', pg_temp.create_essay());
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e2'), 1), '2', 'an essay created now names version 2');

-- 5. A later version of an assignment keeps its binding for the same kind of
-- work; another kind takes the latest version of that kind.
SELECT is(pg_temp.publish_version((SELECT val FROM ref WHERE name = 'e1'), 1, 'essay'), '2',
  'Vesna publishes version 2 of the earlier essay');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 2), '1', 'and it keeps version 1 of the rule');
SELECT is(pg_temp.publish_version((SELECT val FROM ref WHERE name = 'e1'), 2, 'seminar_paper'), '3',
  'Vesna makes it a seminar paper');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 3), 'none',
  'a kind without a faculty rule names none');
SELECT is(pg_temp.publish_version((SELECT val FROM ref WHERE name = 'e1'), 3, 'essay'), '4', 'and an essay again');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 4), '1',
  'back on its kind it names the version it was created under, not the latest');

-- 6. The caller does not choose the version.
SELECT lives_ok(pg_temp.insert_version((SELECT val FROM ref WHERE name = 'e1'), 5, 'essay', 'partially_allowed',
                                       '{proofreading}', 'basic', 2, 'vesna'),
  'the owner role writes a version that names version 2');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e1'), 5), '1', 'it is stored with version 1 all the same');
SELECT lives_ok(pg_temp.insert_version((SELECT val FROM ref WHERE name = 'e2'), 2, 'essay', 'partially_allowed',
                                       '{proofreading}', 'basic', 99, 'vesna'),
  'a version that names a version that does not exist is written');
SELECT is(pg_temp.bound((SELECT val FROM ref WHERE name = 'e2'), 2), '2', 'with the version of its assignment');
SELECT throws_ok(
  format('UPDATE institution.assignment_version SET faculty_rule_version = 2 WHERE assignment_id = %L AND version_no = 1',
         (SELECT val FROM ref WHERE name = 'e1')),
  'ZD403', 'assignment version is immutable', 'the owner role cannot move a stored version to another rule');
SELECT matches(pg_temp.ask('vesna', format(
    $$ UPDATE institution.assignment_version SET faculty_rule_version = 2 WHERE assignment_id = %L RETURNING 'x' $$,
    (SELECT val FROM ref WHERE name = 'e1'))),
  '^42501: permission denied', 'ductus_app cannot write the column');
SELECT matches(pg_temp.ask('vesna', pg_temp.insert_version((SELECT val FROM ref WHERE name = 'e1'), 6, 'essay',
    'partially_allowed', '{proofreading}', 'basic', 2, 'vesna')),
  '^42501: permission denied', 'ductus_app cannot write a version naming a rule');

-- 7. A mentorship's work is checked against the version it names.
SELECT is(pg_temp.publish_rule('master_thesis', 1, 'prohibited', '{}', 'basic'), '2',
  'Iva narrows the master thesis rule to version 2');
SELECT is((SELECT ai_policy FROM institution.faculty_work_rule
            WHERE institution_id = pg_temp.id('fak_a') AND work_type = 'master_thesis'),
  'prohibited', 'the projection now prohibits AI');
SELECT lives_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b1', 2, 'master_thesis',
                                       'partially_allowed', '{proofreading}', 'extended', 2, 'marko'),
  'a version of ZM1 within version 1 is written, though it names version 2');
SELECT is(pg_temp.bound('00000000-0000-4000-8000-0000000000b1', 2), '1', 'it names version 1, as ZM1 does');
SELECT throws_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b1', 3, 'master_thesis',
                                        'partially_allowed', '{translation}', 'basic', NULL, 'marko'),
  'ZD422', 'invalid input', 'a purpose outside version 1 is still refused');
SELECT throws_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b1', 3, 'essay',
                                        'prohibited', '{}', 'basic', NULL, 'marko'),
  'ZD422', 'invalid input', 'another kind of work than the mentorship''s is still refused');

INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type)
VALUES (pg_temp.id('ms6'), pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('dora'), 'master_thesis');
INSERT INTO institution.assignment (id, mentorship_id, institution_id, current_version, created_by)
VALUES (pg_temp.id('zm6'), pg_temp.id('ms6'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna'));
SELECT throws_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b6', 1, 'master_thesis',
                                        'partially_allowed', '{proofreading}', 'extended', 1, 'vesna'),
  'ZD422', 'invalid input', 'a new mentored work is held to version 2, even when it names version 1');
SELECT lives_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b6', 1, 'master_thesis',
                                       'prohibited', '{}', 'basic', 1, 'vesna'),
  'within version 2 it is written');
SELECT is(pg_temp.bound('00000000-0000-4000-8000-0000000000b6', 1), '2', 'and names version 2');

-- 8. Without a version for the mentorship's kind nothing is written.
INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type)
VALUES (pg_temp.id('ms7'), pg_temp.id('fak_a'), pg_temp.id('vesna'), pg_temp.id('ana'), 'doctoral_thesis');
INSERT INTO institution.assignment (id, mentorship_id, institution_id, current_version, created_by)
VALUES (pg_temp.id('zm7'), pg_temp.id('ms7'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna'));
SELECT throws_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b7', 1, 'doctoral_thesis',
                                        'prohibited', '{}', 'basic', NULL, 'vesna'),
  'ZD503', 'not set up', 'a doctoral thesis, for which fak-a has no rule, is not set up');
SELECT throws_ok(pg_temp.insert_version('00000000-0000-4000-8000-0000000000b7', 1, 'essay',
                                        'prohibited', '{}', 'basic', 2, 'vesna'),
  'ZD503', 'not set up', 'nor is it when the version is of a kind that has one');

SELECT * FROM finish();
ROLLBACK;
