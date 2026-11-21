-- SRV-1901: all fixtures are invented. Practice is fixed on creation.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(12);

SELECT is(pg_temp.ask('vesna', $$ SELECT is_practice::text FROM institution.assignment WHERE id = {z1} $$),
  'false', 'assignments inserted without the flag remain regular');

CREATE FUNCTION pg_temp.create_practice(p_flag boolean) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format($q$
    SELECT institution.create_assignment({k1}, '00000000-0000-4000-8000-000000001901'::uuid,
      'Probni esej', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{proofreading}', 'basic', false, NULL, NULL, 1, %L::boolean)
  $q$, p_flag))
$$;

INSERT INTO ref SELECT 'practice', pg_temp.create_practice(true);
SELECT matches((SELECT val FROM ref WHERE name = 'practice'), '^[0-9a-f-]{36}$', 'a teacher creates a practice assignment');
SELECT is(pg_temp.create_practice(true), (SELECT val FROM ref WHERE name = 'practice'), 'the same key and flag are idempotent');
SELECT is(pg_temp.create_practice(false), 'ZD409: conflict', 'a changed flag cannot reuse the key');
SELECT is(pg_temp.ask('vesna', $$ SELECT is_practice::text FROM institution.assignment WHERE id = {practice} $$),
  'true', 'the flag is stored');
SELECT throws_ok($$ UPDATE institution.assignment SET is_practice = false WHERE id = pg_temp.id('practice') $$,
  'ZD409', 'practice status is immutable', 'the assignment cannot become regular');

SELECT is(pg_temp.ask('vesna', $$ SELECT institution.assignment_grade_state({z1}) $$),
  'eligible', 'a regular assignment is eligible for grading');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.assignment_grade_state({practice}) $$),
  'practice', 'the grade query cannot select practice as an eligible assignment');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.assignment_grade_state({practice}) $$),
  'not_found', 'a student cannot read the teacher grade state');
SELECT is(pg_temp.ask('anon', $$ SELECT institution.assignment_grade_state({practice}) $$),
  'unauthorized', 'a caller without a session cannot read the grade state');

SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.request_merlin_package({practice}, 'kljuc-probni') $$),
  'ZD403: forbidden', 'the Merlin package RPC rejects practice assignments');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.request_merlin_package({z1}, 'kljuc-redovni') $$),
  'queued', 'the Merlin package RPC still accepts a regular assignment');

SELECT * FROM finish();
ROLLBACK;
