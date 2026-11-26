-- F4-NAS-R01 (Ductus#2055): the teacher of an assignment reads back whether a
-- submission after its deadline is allowed (20261220310000), so the form
-- shows the value in force. Only the teacher of the assignment reads it; a
-- teacher of another course, a student, the administrator and an unknown
-- assignment read the same not_found (C-23). Synthetic rows only; everything
-- is rolled back.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT plan(16);

CREATE FUNCTION pg_temp.read_teacher(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome || '' '' || coalesce(late_submission_allowed::text, ''-'') FROM app.teacher_assignment_late_submission({%s})',
    p_assignment))
$$;
CREATE FUNCTION pg_temp.set_late(p_actor text, p_assignment text, p_value text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({%s}, %s)', p_assignment, p_value))
$$;

SELECT is(pg_temp.read_teacher('vesna', 'z1'), 'found true', 'the teacher of the assignment reads the default');
SELECT is(pg_temp.read_teacher('petra', 'z3'), 'found true', 'a teacher of another faculty reads her own assignment');

-- Anyone else reads the same answer as for an assignment that does not exist.
SELECT is(pg_temp.read_teacher('marko', 'z1'), 'not_found -', 'a teacher of another course does not read it');
SELECT is(pg_temp.read_teacher('petra', 'z1'), 'not_found -', 'a teacher of another faculty does not read it');
SELECT is(pg_temp.read_teacher('vesna', 'z3'), 'not_found -', 'Vesna does not read an assignment of another faculty');
SELECT is(pg_temp.read_teacher('nina', 'z1'), 'not_found -', 'an unconfirmed teacher does not read it');
SELECT is(pg_temp.read_teacher('ana', 'z1'), 'not_found -', 'a student of the course does not read the teacher''s read');
SELECT is(pg_temp.read_teacher('iva', 'z1'), 'not_found -', 'the administrator does not read it');
SELECT is(pg_temp.read_teacher('vesna', 'nobody'), 'not_found -', 'an unknown assignment is not_found');
SELECT is(pg_temp.read_teacher('vesna', 'nobody') , pg_temp.read_teacher('marko', 'z1'),
  'another teacher''s assignment reads exactly like an unknown one');
SELECT is(pg_temp.read_teacher('anon', 'z1'), 'ZD401: not authenticated', 'without a session nothing is read');

-- The value the teacher set is the value the teacher reads back.
SELECT is(pg_temp.set_late('vesna', 'z1', 'false'), 'false', 'the teacher forbids a late submission');
SELECT is(pg_temp.read_teacher('vesna', 'z1'), 'found false', 'and reads it forbidden');
SELECT is(pg_temp.read_teacher('marko', 'z1'), 'not_found -', 'another teacher still reads nothing');
SELECT is(pg_temp.set_late('vesna', 'z1', 'true'), 'true', 'the teacher allows it again');
SELECT is(pg_temp.read_teacher('vesna', 'z1'), 'found true', 'and reads it allowed');

SELECT * FROM finish();
ROLLBACK;
