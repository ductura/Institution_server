-- SRV-1108 (wave 11, N-13, C-15, PO-22): a teacher extends the deadline of an
-- assignment for one student or for all of them, with a reason from a closed
-- list. The extension holds only for its scope, the reason is shown only to
-- the teacher who wrote it, nobody changes or removes a record, and a teacher
-- of another course or institution writes nothing. Every person, course and
-- date below is invented (fixtures/institution.inc: Z1 of K1 is due in 30
-- days, Vesna teaches K1, Ana and Dora study in it).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.extend(p_actor text, p_student text, p_days integer, p_reason text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT id::text FROM institution.extend_assignment_deadline({z1}, %s, now() + interval %L, %L)',
      p_student, p_days || ' days', p_reason)) AS r) x
$$;

-- Catalogue: forced RLS, only the owner's policy, no direct privilege.
SELECT is((SELECT format('%s|%s|%s', c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole)
             FROM pg_class c WHERE c.oid = 'institution.deadline_extension'::regclass),
  't|t|ductus_identity', 'the table belongs to the identity role, with RLS forced');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  WHERE has_table_privilege(r, 'institution.deadline_extension', p)
), 'no runtime role reads or writes the table directly');
SELECT ok(NOT has_function_privilege('ductus_app', 'institution.effective_due_at(uuid,uuid)', 'EXECUTE'),
  'the web role cannot call the reader without an access check');

-- Before any extension every student has the due date of the current version.
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')), now() + interval '30 days',
  'without an extension Ana''s deadline is the version''s');

-- Writing: the teacher of K1 only; one answer for every refusal.
SELECT is(pg_temp.extend('vesna', '{ana}', 40, 'justified'), 'ok', 'Vesna extends Ana''s deadline on Z1');
SELECT is(pg_temp.extend(a.name, '{ana}', 41, 'justified'), 'ZD403', a.name || ' cannot extend a deadline on Z1')
FROM (VALUES ('marko'), ('iva'), ('ana'), ('dora'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.extend('anon', '{ana}', 41, 'justified'), 'ZD401', 'without a session nothing is written');
SELECT is(pg_temp.extend('vesna', '{tomo}', 41, 'justified'), 'ZD403',
  'a student of another institution is not a student of Z1');
SELECT is(pg_temp.extend('vesna', '{boris}', 41, 'justified'), 'ZD403', 'a student of no course is not a student of Z1');
SELECT is(pg_temp.extend('vesna', '{vesna}', 41, 'justified'), 'ZD403', 'the teacher is not a student of Z1');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.extend_assignment_deadline({z3}, NULL, now() + interval '60 days', 'all') $$),
  'ZD403: forbidden', 'Vesna cannot extend the deadline of another institution''s assignment');

-- Input: a closed list of reasons, "all" only for all students, a later deadline.
SELECT is(pg_temp.extend('vesna', '{ana}', 41, r.reason), 'ZD422', 'reason ' || coalesce(r.reason, 'null') || ' is refused')
FROM (VALUES ('drugo'), (''), ('Justified'), (NULL)) AS r (reason);
SELECT is(pg_temp.extend('vesna', '{ana}', 41, 'all'), 'ZD422', '"all" is not a reason for one student');
SELECT is(pg_temp.extend('vesna', '{ana}', 35, 'technical'), 'ZD422', 'a deadline earlier than the one in force is refused');
SELECT is(pg_temp.extend('vesna', '{ana}', 40, 'technical'), 'ZD422', 'the same deadline again is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.extend_assignment_deadline({z1}, {ana}, NULL, 'technical') $$),
  'ZD422: invalid input', 'a missing deadline is refused');

-- Scope: one student's extension holds for that student alone.
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')), now() + interval '40 days',
  'Ana''s deadline is the extended one');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('dora')), now() + interval '30 days',
  'Dora''s deadline is still the version''s');
SELECT row_eq(
  $$ SELECT student_id, previous_due_at, due_at, reason_id, created_by, institution_id FROM institution.deadline_extension $$,
  ROW(pg_temp.id('ana'), now() + interval '30 days', now() + interval '40 days', 'justified'::text, pg_temp.id('vesna'),
      pg_temp.id('fak_a')),
  'the record keeps the student, the old and the new deadline, the reason, the author and the institution of the session');
SELECT is(pg_temp.ask('vesna', $$ SELECT earlier_submissions::text FROM institution.extend_assignment_deadline({z1}, {dora}, now() + interval '33 days', 'agreement') $$),
  'false', 'with no submission in scope, earlier_submissions is false');

-- All students: the latest extension that applies holds.
SELECT is(pg_temp.extend('vesna', 'NULL', 50, 'all'), 'ok', 'Vesna extends the deadline for all students');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('dora')), now() + interval '50 days',
  'the extension for all students holds for Dora');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')), now() + interval '50 days',
  'and for Ana, as the latest that applies to her');
SELECT is(pg_temp.extend('vesna', '{ana}', 45, 'technical'), 'ZD422',
  'one student''s extension must be later than the deadline for all');

-- Reading: the teacher of the course; the reason only on the own rows.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
SELECT is(pg_temp.ask('vesna', $$ SELECT string_agg(coalesce(reason_id, '-'), ',' ORDER BY created_at, id) FROM institution.deadline_extensions({z1}) $$),
  'justified,agreement,all', 'Vesna reads her extensions with their reasons, oldest first');
SELECT is(pg_temp.ask('marko', $$ SELECT string_agg(coalesce(reason_id, '-'), ',' ORDER BY created_at, id) FROM institution.deadline_extensions({z1}) $$),
  '-,-,-', 'another teacher of the course sees the extensions without their reasons');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM institution.deadline_extensions({z1}) $$), 'ZD403: forbidden',
  a.name || ' cannot list the extensions of Z1')
FROM (VALUES ('ana'), ('dora'), ('iva'), ('boris'), ('petra'), ('tomo')) AS a (name);

-- Append-only.
SELECT throws_ok($$ UPDATE institution.deadline_extension SET due_at = due_at + interval '1 day' $$, 'ZD403', NULL,
  'a record of an extension cannot be changed');
SELECT throws_ok($$ DELETE FROM institution.deadline_extension $$, 'ZD403', NULL,
  'a record of an extension cannot be removed');
SELECT throws_ok($$ TRUNCATE institution.deadline_extension $$, 'ZD403', NULL,
  'the extensions cannot be truncated');

SELECT * FROM finish();
ROLLBACK;
