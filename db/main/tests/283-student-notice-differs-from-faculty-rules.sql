-- F4-STU-R08-SRV: institution.student_assignment_differs_from_faculty_rule
-- tells the student of an assignment whether its current version differs from
-- the faculty rule version it is bound to (M2.12-P01b), and tells nobody else
-- anything. Personas of institution.inc and mentorship.inc; every person,
-- course, rule and text is invented.
--
--   Ana and Dora are students of K1 (Vesna); Z1 is an essay written before
--   fak-a had an essay rule. ZM1 is Ana's master thesis (Marko), bound to
--   version 1 of the master thesis rule and narrower in its purposes. ZM2 is
--   Dora's ended bachelor thesis. Boris is in no course, Tomo is of fak-b.
BEGIN;
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

CREATE FUNCTION pg_temp.differs(p_actor text, p_assignment uuid) RETURNS text
LANGUAGE sql AS $f$
  SELECT coalesce(pg_temp.ask(p_actor, format(
    'SELECT institution.student_assignment_differs_from_faculty_rule(%L::uuid)', p_assignment)), 'none')
$f$;
CREATE FUNCTION pg_temp.publish_rule(p_expected integer, p_policy text, p_purposes text, p_profile text)
RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask('iva', format(
    'SELECT institution.publish_faculty_rule_version(%L, %s, %L, %L::text[], %L, false)',
    'essay', p_expected, p_policy, p_purposes, p_profile))
$f$;
CREATE FUNCTION pg_temp.create_essay(p_policy text, p_purposes text, p_profile text) RETURNS text
LANGUAGE sql AS $f$
  SELECT pg_temp.ask('vesna', format(
    'SELECT institution.create_assignment({k1}, %L, %L, %L, now(), now() + interval %L, %L, %L::text[], %L, false, NULL, NULL)',
    'Esej', 'Upute za izmišljeni zadatak.', 'essay', '30 days', p_policy, p_purposes, p_profile))
$f$;

-- 1. Owner, rights and search_path.
SELECT is(
  (SELECT pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::text || ' '
          || coalesce('search_path=""' = ANY (p.proconfig), false)::text || ' ' || p.provolatile::text
     FROM pg_proc p WHERE p.oid = 'institution.student_assignment_differs_from_faculty_rule(uuid)'::regprocedure),
  'ductus_identity true true s',
  'a stable definer of the identity role with an empty search_path');
SELECT ok(
  has_function_privilege('ductus_app', 'institution.student_assignment_differs_from_faculty_rule(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'institution.student_assignment_differs_from_faculty_rule(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('ductus_test_stranger',
                                 'institution.student_assignment_differs_from_faculty_rule(uuid)', 'EXECUTE'),
  'only the web role executes it, not PUBLIC');

-- 2. Bound to no faculty rule version: nothing to compare.
SELECT is((SELECT faculty_rule_version FROM institution.assignment_version
            WHERE assignment_id = pg_temp.id('z1') AND version_no = 2), NULL::integer,
  'Z1.2 is bound to no faculty rule version');
SELECT is(pg_temp.differs('ana', pg_temp.id('z1')), 'none', 'Ana gets no answer for Z1');

-- 3. Settings that differ from the bound version: true.
SELECT is(pg_temp.differs('ana', pg_temp.id('zm1')), 'true',
  'ZM1 allows fewer purposes than version 1 of the master thesis rule');

-- 4. Settings equal to the bound version: false; any field apart: true.
SELECT is(pg_temp.publish_rule(0, 'partially_allowed', '{proofreading,formatting}', 'extended'), '1',
  'Iva publishes version 1 of the essay rule');
INSERT INTO ref VALUES ('e1', pg_temp.create_essay('partially_allowed', '{formatting,proofreading}', 'extended'));
INSERT INTO ref VALUES ('e2', pg_temp.create_essay('prohibited', '{}', 'extended'));
INSERT INTO ref VALUES ('e3', pg_temp.create_essay('partially_allowed', '{formatting,proofreading}', 'basic'));
SELECT is((SELECT string_agg(coalesce(v.faculty_rule_version::text, 'none'), ',' ORDER BY r.name)
             FROM ref r JOIN institution.assignment_version v ON v.assignment_id = r.val::uuid
            WHERE r.name IN ('e1', 'e2', 'e3')),
  '1,1,1', 'the three new essays are bound to version 1');
SELECT is(pg_temp.differs('ana', (SELECT val::uuid FROM ref WHERE name = 'e1')), 'false',
  'the same policy, the same purposes in another order, profile and import: no difference');
SELECT is(pg_temp.differs('dora', (SELECT val::uuid FROM ref WHERE name = 'e1')), 'false',
  'the same answer for Dora, also a student of K1');
SELECT is(pg_temp.differs('ana', (SELECT val::uuid FROM ref WHERE name = 'e2')), 'true',
  'a narrower AI policy is a difference');
SELECT is(pg_temp.differs('ana', (SELECT val::uuid FROM ref WHERE name = 'e3')), 'true',
  'another evidence profile is a difference');

-- 5. A version the faculty publishes later changes nothing: the bound one counts.
SELECT is(pg_temp.publish_rule(1, 'prohibited', '{}', 'extended'), '2',
  'Iva publishes version 2 of the essay rule, equal to E2');
SELECT is(pg_temp.differs('ana', (SELECT val::uuid FROM ref WHERE name = 'e1')), 'false',
  'E1 still agrees with version 1, though not with version 2');
SELECT is(pg_temp.differs('ana', (SELECT val::uuid FROM ref WHERE name = 'e2')), 'true',
  'E2 still differs from version 1, though it equals version 2');
SELECT is(pg_temp.differs('ana', pg_temp.id('z1')), 'none', 'Z1 stays bound to none');

-- 6. Nobody but the student of the assignment learns anything.
SELECT is(pg_temp.differs(v.actor, v.assignment), 'none', v.what)
FROM (VALUES
  (1, 'vesna', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'Vesna, teacher of K1, is not its student'),
  (2, 'boris', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'Boris, in no course, gets nothing'),
  (3, 'tomo', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'Tomo of fak-b gets nothing'),
  (4, 'iva', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'Iva, the administrator, gets nothing here'),
  (5, 'anon', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'without a session nothing'),
  (6, 'expired', (SELECT val::uuid FROM ref WHERE name = 'e2'), 'with an expired session nothing'),
  (7, 'dora', pg_temp.id('zm1'), 'Dora gets nothing for Ana''s thesis'),
  (8, 'marko', pg_temp.id('zm1'), 'Marko, its mentor, is not its student'),
  (9, 'dora', pg_temp.id('zm2'), 'Dora gets nothing for her ended mentorship'),
  (10, 'ana', '00000000-0000-4000-8000-0000000000ff'::uuid, 'an unknown assignment is nothing')
) AS v (n, actor, assignment, what)
ORDER BY v.n;
SELECT matches(pg_temp.ask_as('ductus_test_stranger', 'ana', format(
    'SELECT institution.student_assignment_differs_from_faculty_rule(%L::uuid)::text', pg_temp.id('zm1'))),
  '^42501: permission denied', 'another role cannot call it');

SELECT * FROM finish();
ROLLBACK;
