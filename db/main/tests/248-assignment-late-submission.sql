-- SRV-NF4-KASNA-POLJE (Ductus#2055, orchestrator decision A): an assignment
-- says whether a submission after its deadline is allowed. Allowed by
-- default, also for every assignment that existed before; only the teacher of
-- the assignment changes it, also after publication (answer 3); a student of
-- the course reads it, anyone else reads not_found (C-23). Enforcement is
-- SRV-NF4-KASNA-PROVEDBA. Synthetic rows only; everything is rolled back.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.set_late(p_actor text, p_assignment text, p_value text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({%s}, %s)', p_assignment, p_value))
$$;
CREATE FUNCTION pg_temp.read_late(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome || '' '' || coalesce(late_submission_allowed::text, ''-'') FROM app.my_assignment_late_submission({%s})',
    p_assignment))
$$;
CREATE FUNCTION pg_temp.stored(p_assignment text) RETURNS boolean LANGUAGE sql AS $$
  SELECT a.late_submission_allowed FROM institution.assignment a WHERE a.id = pg_temp.id(p_assignment)
$$;

-- The column: a boolean, never null, allowed by default.
SELECT col_type_is('institution', 'assignment', 'late_submission_allowed', 'boolean', 'the field is a boolean');
SELECT col_not_null('institution', 'assignment', 'late_submission_allowed', 'the field is never null');
SELECT col_default_is('institution', 'assignment', 'late_submission_allowed', 'true',
  'a new assignment allows a late submission unless its teacher says otherwise');
SELECT is((SELECT count(*) FROM institution.assignment WHERE NOT late_submission_allowed), 0::bigint,
  'every existing assignment allows a late submission');

-- The student of the course reads it; nobody else does, and the answer is the
-- same as for an assignment that does not exist.
SELECT is(pg_temp.read_late('ana', 'z1'), 'found true', 'a student of the course reads it allowed');
SELECT is(pg_temp.read_late('dora', 'z1'), 'found true', 'a classmate reads it too');
SELECT is(pg_temp.read_late('tomo', 'z3'), 'found true', 'a student of another faculty reads his own course');
SELECT is(pg_temp.read_late('tomo', 'z1'), 'not_found -', 'a student of another faculty does not read Z1');
SELECT is(pg_temp.read_late('ana', 'z3'), 'not_found -', 'Ana does not read an assignment of another faculty');
SELECT is(pg_temp.read_late('ana', 'z2'), 'not_found -', 'Ana does not read an assignment of a course she is not in');
SELECT is(pg_temp.read_late('boris', 'z1'), 'not_found -', 'a student in no course does not read it');
SELECT is(pg_temp.read_late('vesna', 'z1'), 'not_found -', 'the student read is not the teacher''s');
SELECT is(pg_temp.read_late('iva', 'z1'), 'not_found -', 'the administrator does not read it');
SELECT is(pg_temp.read_late('ana', 'nobody'), 'not_found -', 'an unknown assignment is not_found');
SELECT is(pg_temp.read_late('anon', 'z1'), 'ZD401: not authenticated', 'without a session nothing is read');

-- Only the teacher of the assignment sets it.
SELECT is(pg_temp.set_late('ana', 'z1', 'false'), 'ZD403: forbidden', 'a student of the assignment cannot set it');
SELECT is(pg_temp.set_late('marko', 'z1', 'false'), 'ZD403: forbidden', 'a teacher of another course cannot set it');
SELECT is(pg_temp.set_late('iva', 'z1', 'false'), 'ZD403: forbidden', 'the administrator cannot set it');
SELECT is(pg_temp.set_late('nina', 'z1', 'false'), 'ZD403: forbidden', 'an unconfirmed teacher cannot set it');
SELECT is(pg_temp.set_late('petra', 'z1', 'false'), 'ZD403: forbidden', 'a teacher of another faculty cannot set it');
SELECT is(pg_temp.set_late('vesna', 'z3', 'false'), 'ZD403: forbidden', 'Vesna cannot set an assignment of another faculty');
SELECT is(pg_temp.set_late('vesna', 'nobody', 'false'), 'ZD403: forbidden', 'an unknown assignment reads as another''s');
SELECT is(pg_temp.set_late('vesna', 'z1', 'NULL'), 'ZD422: invalid input', 'a null value is invalid');
SELECT is(pg_temp.set_late('anon', 'z1', 'false'), 'ZD401: not authenticated', 'without a session nothing is set');
SELECT is((SELECT count(*) FROM institution.assignment WHERE NOT late_submission_allowed), 0::bigint,
  'no refused call changed anything');
SELECT alike(pg_temp.ask('vesna', 'UPDATE institution.assignment SET late_submission_allowed = false RETURNING 1'),
  '42501:%', 'the application cannot write the column directly');

-- Z1, already at its second version and acknowledged by its students,
-- changes, and its students read the change.
SELECT is(pg_temp.set_late('vesna', 'z1', 'true'), 'true', 'setting the value in force answers it');
SELECT is(pg_temp.set_late('vesna', 'z1', 'false'), 'false', 'the teacher forbids a late submission');
SELECT ok(NOT pg_temp.stored('z1'), 'the change is stored on the assignment');
SELECT ok(pg_temp.stored('z3'), 'and only on it');
SELECT is(pg_temp.read_late('ana', 'z1'), 'found false', 'the student reads it forbidden');
SELECT is(pg_temp.set_late('vesna', 'z1', 'false'), 'false', 'forbidding it again changes nothing');
SELECT is(pg_temp.set_late('vesna', 'z1', 'true'), 'true', 'the teacher allows it again');
SELECT is(pg_temp.read_late('dora', 'z1'), 'found true', 'and the students read it allowed');

SELECT * FROM finish();
ROLLBACK;
