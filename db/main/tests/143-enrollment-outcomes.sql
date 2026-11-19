-- SRV-05 (Ductus#2028, c.7008147932; owner answer A-2 of 19 Nov 2026): the
-- six answers of institution.enroll_with_code, which ones count as an
-- attempt, and that a student never reads another student's enrolment (C-23).
-- Every person, course and code below is invented (fixtures/institution.inc).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(24);

-- K4 of fak-a: Marko teaches it, it has a working code and no assignment yet.
INSERT INTO ref VALUES ('k4', '00000000-0000-4000-8000-0000000000c4');
INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
VALUES (pg_temp.id('k4'), pg_temp.id('fak_a'), 'K4', '2026/2027', 'prohibited', pg_temp.id('marko'));
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k4'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
INSERT INTO institution.course_enrollment_code (course_id, code_hash, valid_until, created_by)
VALUES (pg_temp.id('k4'), pg_temp.code_hash('KOD-K4-PRAZAN'), now() + interval '30 days', pg_temp.id('marko'));

CREATE FUNCTION pg_temp.enroll(p_actor text, p_code text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT e::text FROM institution.enroll_with_code(%L) e', p_code))
$$;
CREATE FUNCTION pg_temp.attempts(p_name text) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.enrollment_attempt WHERE user_id = pg_temp.id(p_name) $$;
CREATE FUNCTION pg_temp.open_memberships(p_name text, p_course text) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM institution.course_member
   WHERE user_id = pg_temp.id(p_name) AND course_id = pg_temp.id(p_course) AND member_to IS NULL
$$;

-- 1. A code that does not work names why, without naming the course.
SELECT is(pg_temp.enroll('boris', v.code), v.answer, 'Boris: ' || v.what)
FROM (VALUES
  (1, 'NIKAD-IZDAN-KOD', '(invalid_code,)', 'a code that was never issued is invalid_code'),
  (2, 'KOD-K2-ISTEKAO', '(expired_code,)', 'the expired code of K2 is expired_code'),
  (3, 'KOD-K1-STARI', '(expired_code,)', 'the revoked code of K1 is expired_code'),
  (4, 'KOD-K3-TEST', '(invalid_code,)', 'the working code of another institution is invalid_code'),
  (5, 'KRATAK', '(invalid_code,)', 'a code shorter than 8 characters is invalid_code')
) AS v (n, code, answer, what)
ORDER BY v.n;
SELECT is(pg_temp.attempts('boris'), 5::bigint, 'each of the five counts as an attempt');
SELECT is(pg_temp.open_memberships('boris', 'k1') + pg_temp.open_memberships('boris', 'k2'), 0::bigint,
          'and Boris is in neither K1 nor K2');
SELECT is(pg_temp.enroll('tomo', 'KOD-K2-ISTEKAO'), '(invalid_code,)',
          'Tomo of fak-b: an expired code of fak-a is invalid_code, not expired_code (C-23)');
DELETE FROM institution.enrollment_attempt;

-- 2. enrolled: the code is normalised (case, spaces, hyphens) before hashing.
SELECT is(pg_temp.enroll('boris', ' kod k1-test '), format('(enrolled,%s)', pg_temp.id('k1')),
          'Boris joins K1, which has an assignment: enrolled');
SELECT is(pg_temp.open_memberships('boris', 'k1') || ' ' || pg_temp.attempts('boris'), '1 0',
          'one membership, no attempt counted');

-- 3. already_enrolled: nothing is written and nothing is counted.
SELECT is(pg_temp.enroll('boris', 'KOD-K1-TEST'), format('(already_enrolled,%s)', pg_temp.id('k1')),
          'the same code again is already_enrolled');
SELECT is(pg_temp.enroll('ana', 'KOD-K1-STARI'), format('(already_enrolled,%s)', pg_temp.id('k1')),
          'Ana, a student of K1, with its revoked code is already_enrolled');
SELECT is(pg_temp.enroll('vesna', 'KOD-K1-TEST'), format('(already_enrolled,%s)', pg_temp.id('k1')),
          'Vesna, the teacher of K1, is already_enrolled');
SELECT is(
  pg_temp.open_memberships('boris', 'k1') || ' ' || pg_temp.open_memberships('ana', 'k1') || ' '
  || pg_temp.open_memberships('vesna', 'k1') || ' ' || (SELECT count(*) FROM institution.enrollment_attempt),
  '1 1 1 0', 'still one membership each, and no attempt counted'
);
SELECT is(
  pg_temp.ask('vesna', 'SELECT role FROM institution.course_member WHERE course_id = {k1} AND user_id = {vesna}'),
  'teacher', 'Vesna stays the teacher of K1'
);

-- 4. enrolled_no_assignment: a course that has no assignment yet.
SELECT is(pg_temp.enroll('dora', 'kod-k4-prazan'), format('(enrolled_no_assignment,%s)', pg_temp.id('k4')),
          'Dora joins K4, which has no assignment: enrolled_no_assignment');
SELECT is(pg_temp.ask('dora', 'SELECT name FROM institution.course WHERE id = {k4}'), 'K4', 'and reads K4 at once');
SELECT is(pg_temp.enroll('dora', 'KOD-K4-PRAZAN'), format('(already_enrolled,%s)', pg_temp.id('k4')),
          'entering it again is already_enrolled');

-- 5. A student removed without a return gets the answer of a wrong code.
SELECT is(pg_temp.ask('vesna', 'SELECT institution.remove_student({k1}, {dora})::text'), 'true',
          'Vesna removes Dora from K1');
SELECT is(pg_temp.enroll('dora', 'KOD-K1-TEST') || ' ' || pg_temp.attempts('dora'), '(invalid_code,) 1',
          'Dora with the working code of K1 is invalid_code, and the attempt counts');

-- 6. Another student never reads the enrolment (C-23).
SELECT is(pg_temp.ask(v.actor, 'SELECT count(*) FROM institution.course_member WHERE user_id = {boris}'), v.seen,
          v.actor || ' ' || v.what)
FROM (VALUES
  (1, 'boris', '1', 'reads his own membership of K1'),
  (2, 'ana', '0', 'a student of K1, does not read Boris''s membership'),
  (3, 'tomo', '0', 'of another institution, does not read it'),
  (4, 'vesna', '1', 'the teacher of K1, reads it')
) AS v (n, actor, seen, what)
ORDER BY v.n;

SELECT * FROM finish();
ROLLBACK;
