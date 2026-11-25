-- SRV-NF4-IZNIMKA-ZAPIS (plan NF-4, NZ-5 B): the teacher of an assignment
-- records an exception of a late submission for one student, with a reason from
-- the closed list and a time until which the student may still submit. The
-- record is never changed or removed, the audit row is written by the same
-- command, the reason is shown only to the teacher who wrote it and to the
-- student it is about, and anything that is not the relation (another teacher,
-- another institution, a person who is no student of the assignment) is the same
-- refusal. Every person, course and date below is invented (fixtures/institution.inc:
-- Z1 of K1 is due in 30 days, Vesna teaches K1, Ana and Dora study in it).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- 'ok' or the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.grant_exception(p_actor text, p_student text, p_days integer, p_reason text) RETURNS text
LANGUAGE sql AS $$
  SELECT CASE WHEN r ~ '^[0-9A-Z]{5}: ' THEN substr(r, 1, 5) ELSE 'ok' END
    FROM (SELECT pg_temp.ask(p_actor, format(
      'SELECT id::text FROM institution.grant_late_submission_exception({z1}, %s, now() + interval %L, %L)',
      p_student, p_days || ' days', p_reason)) AS r) x
$$;

-- Catalogue: forced RLS, no direct privilege on the record or on its trail.
SELECT is((SELECT format('%s|%s|%s', c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole)
             FROM pg_class c WHERE c.oid = 'institution.late_submission_exception'::regclass),
  't|t|ductus_identity', 'the table belongs to the identity role, with RLS forced');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence']) AS r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  CROSS JOIN unnest(ARRAY['institution.late_submission_exception', 'audit.late_submission_exception_event']) AS t
  WHERE has_table_privilege(r, t, p)
), 'no runtime role reads or writes the record or its trail directly');

-- Writing: the teacher of K1 only; one answer for every refusal.
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 40, 'justified'), 'ok', 'Vesna records an exception for Ana on Z1');
SELECT is(pg_temp.grant_exception(a.name, '{ana}', 41, 'justified'), 'ZD403', a.name || ' cannot record an exception on Z1')
FROM (VALUES ('marko'), ('iva'), ('ana'), ('dora'), ('boris'), ('nina'), ('petra'), ('lea'), ('tomo')) AS a (name);
SELECT is(pg_temp.grant_exception('anon', '{ana}', 41, 'justified'), 'ZD401', 'without a session nothing is written');
SELECT is(pg_temp.grant_exception('vesna', '{tomo}', 41, 'justified'), 'ZD403',
  'a student of another institution is not a student of Z1');
SELECT is(pg_temp.grant_exception('vesna', '{boris}', 41, 'justified'), 'ZD403', 'a student of no course is not a student of Z1');
SELECT is(pg_temp.grant_exception('vesna', '{vesna}', 41, 'justified'), 'ZD403', 'the teacher is not a student of Z1');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.grant_late_submission_exception({z3}, {ana}, now() + interval '60 days', 'justified') $$),
  'ZD403: forbidden', 'Vesna cannot record an exception on another institution''s assignment');

-- Input: a closed list of reasons (no "all", no free text), a time later than the
-- deadline, than now and than the earlier exception of the student.
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 60, r.reason), 'ZD422', 'reason ' || coalesce(r.reason, 'null') || ' is refused')
FROM (VALUES ('drugo'), (''), ('Justified'), ('all'), (NULL)) AS r (reason);
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 20, 'technical'), 'ZD422', 'a time before the deadline is refused');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', -3, 'technical'), 'ZD422', 'a time in the past is refused');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 40, 'technical'), 'ZD422', 'the same time again is refused');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 35, 'technical'), 'ZD422', 'a time earlier than the earlier exception is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.grant_late_submission_exception({z1}, {ana}, NULL, 'technical') $$),
  'ZD422: invalid input', 'a missing time is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.grant_late_submission_exception({z1}, NULL, now() + interval '60 days', 'technical') $$),
  'ZD422: invalid input', 'a missing student is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.grant_late_submission_exception({z1}, {ana}, 'infinity', 'technical') $$),
  'ZD422: invalid input', 'an infinite time is refused');

-- Record: kept as written, the institution and the author from the session. A deadline
-- is not changed by an exception.
SELECT row_eq(
  $$ SELECT student_id, until_at, reason_id, created_by, institution_id FROM institution.late_submission_exception $$,
  ROW(pg_temp.id('ana'), now() + interval '40 days', 'justified'::text, pg_temp.id('vesna'), pg_temp.id('fak_a')),
  'the record keeps the student, the time, the reason, the author and the institution of the session');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')), now() + interval '30 days',
  'the deadline of Ana is unchanged');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 45, 'agreement'), 'ok', 'a later exception for the same student is a new record');
SELECT is((SELECT count(*)::integer FROM institution.late_submission_exception), 2, 'both records are kept');

-- Audit trail: written by the same command, one row per record, with the author.
SELECT is((SELECT count(*)::integer FROM audit.late_submission_exception_event e
             JOIN institution.late_submission_exception x ON x.id = e.exception_id
            WHERE e.actor_id = pg_temp.id('vesna') AND e.student_id = pg_temp.id('ana')
              AND e.assignment_id = pg_temp.id('z1') AND e.action = 'granted'),
  2, 'every record has its audit row with the author, the student and the assignment');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 99, 'justified') = 'ok', true, 'one more record');
SELECT is((SELECT count(*)::integer FROM audit.late_submission_exception_event), 3,
  'a refused command wrote no audit row, an accepted one wrote one');
SELECT is(pg_temp.grant_exception('vesna', '{ana}', 10, 'justified'), 'ZD422', 'a refused command');
SELECT is((SELECT count(*)::integer FROM audit.late_submission_exception_event), 3, 'a refusal leaves the trail as it was');

-- Append-only: neither the record nor its audit row is changed or removed.
SELECT throws_ok($$ UPDATE institution.late_submission_exception SET reason_id = 'technical' $$, 'ZD403', NULL,
  'a record cannot be changed');
SELECT throws_ok($$ DELETE FROM institution.late_submission_exception $$, 'ZD403', NULL, 'a record cannot be removed');
SELECT throws_ok($$ TRUNCATE institution.late_submission_exception CASCADE $$, 'ZD403', NULL, 'the table cannot be truncated');
SELECT throws_ok($$ DELETE FROM audit.late_submission_exception_event $$, NULL, NULL, 'an audit row cannot be removed');
SELECT throws_ok($$ UPDATE audit.late_submission_exception_event SET action = 'granted' $$, NULL, NULL,
  'an audit row cannot be changed');

-- Teacher's list: oldest first; the reason only on the rows the caller wrote.
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM institution.late_submission_exceptions({z1})'), '3',
  'Vesna lists the three records of Z1');
SELECT is(pg_temp.ask('vesna', 'SELECT string_agg(reason_id, '','' ORDER BY until_at) FROM institution.late_submission_exceptions({z1})'),
  'justified,agreement,justified', 'Vesna sees the reason of her own records, oldest first');
SELECT is(pg_temp.ask(a.name, 'SELECT count(*)::text FROM institution.late_submission_exceptions({z1})'), 'ZD403: forbidden',
  a.name || ' cannot list the exceptions of Z1')
FROM (VALUES ('marko'), ('ana'), ('dora'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('anon', 'SELECT count(*)::text FROM institution.late_submission_exceptions({z1})'),
  'ZD401: not authenticated', 'no session, no list');

-- Student's view: only the own records, with the reason of them; nothing of another student.
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM institution.student_late_submission_exceptions({z1})'), '3',
  'Ana reads her three records');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(reason_id, '','' ORDER BY until_at) FROM institution.student_late_submission_exceptions({z1})'),
  'justified,agreement,justified', 'Ana reads the reason of her records');
SELECT is(pg_temp.ask('dora', 'SELECT count(*)::text FROM institution.student_late_submission_exceptions({z1})'), '0',
  'Dora, a student of Z1 with no exception, reads nothing of Ana''s');
SELECT is(pg_temp.ask(a.name, 'SELECT count(*)::text FROM institution.student_late_submission_exceptions({z1})'), 'ZD403: forbidden',
  a.name || ' is no student of Z1 and reads nothing')
FROM (VALUES ('vesna'), ('marko'), ('boris'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM institution.student_late_submission_exceptions({z3})'),
  'ZD403: forbidden', 'Ana reads nothing on another institution''s assignment');

-- A privately written record of another teacher: its reason is hidden from this teacher.
INSERT INTO institution.late_submission_exception (institution_id, assignment_id, student_id, until_at, reason_id, created_by)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), now() + interval '300 days', 'technical', pg_temp.id('marko');
SELECT is(pg_temp.ask('vesna', 'SELECT reason_id IS NULL FROM institution.late_submission_exceptions({z1}) WHERE student_id = {dora}'),
  'true', 'the reason of a record another teacher wrote is null for Vesna');

SELECT * FROM finish();
ROLLBACK;
