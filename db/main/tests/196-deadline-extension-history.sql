-- SRV-1509: the append-only history is shared by the deadline resolver and
-- the role-specific readers. All people and assignments are invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.student_deadline_history({z1}) $$),
  '0', 'an enrolled student has an empty history before the first extension');
SELECT is(pg_temp.ask('ana', $$ SELECT extended_due_at IS NULL FROM institution.student_assignments() WHERE assignment_id = {z1} $$),
  'true', 'the student list has no extension before one applies');

SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.extend_assignment_deadline(
    {z1}, {ana}, now() + interval '40 days', 'justified') $$), '1', 'Ana receives an individual extension');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.extend_assignment_deadline(
    {z1}, NULL, now() + interval '50 days', 'all') $$), '1', 'the assignment receives a common extension');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.extend_assignment_deadline(
    {z1}, {dora}, now() + interval '60 days', 'technical') $$), '1', 'Dora receives an individual extension');

SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(scope || ':' || reason_id, ',' ORDER BY ordinality)
    FROM institution.student_deadline_history({z1}) WITH ORDINALITY $$),
  'one:justified,all:all', 'Ana sees her own reason and the common extension in append order');
SELECT is(pg_temp.ask('dora', $$ SELECT string_agg(scope || ':' || reason_id, ',' ORDER BY ordinality)
    FROM institution.student_deadline_history({z1}) WITH ORDINALITY $$),
  'all:all,one:technical', 'Dora sees the common extension and her own reason in append order');
SELECT is(pg_temp.ask('ana', $$ SELECT (due_at - now())::text FROM institution.student_assignments() WHERE assignment_id = {z1} $$),
  '30 days', 'the list keeps the published base deadline in due_at');
SELECT is(pg_temp.ask(a.actor, $$ SELECT concat_ws(' ', (extended_due_at - now())::text,
    extended_due_at = app.student_effective_due_at(assignment_id))
    FROM institution.student_assignments() WHERE assignment_id = {z1} $$),
  a.expected, a.actor || ' sees the same effective deadline in the list and submission bridge')
  FROM (VALUES ('ana', '50 days t'), ('dora', '60 days t')) a(actor, expected);

SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.student_deadline_history({z3}) $$),
  'ZD403: forbidden', 'Ana cannot read a different institution');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.student_deadline_history({z2}) $$),
  'ZD403: forbidden', 'Ana cannot read a course where she is not enrolled');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.student_deadline_history(NULL) $$),
  'ZD403: forbidden', 'a missing assignment fails closed');

SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ UPDATE institution.deadline_extension
    SET due_at = due_at + interval '1 day' RETURNING 1 $$),
  'ZD403: deadline extension is append-only', 'even the owner cannot update the history');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon', $$ DELETE FROM institution.deadline_extension RETURNING 1 $$),
  'ZD403: deadline extension is append-only', 'even the owner cannot delete from the history');
SELECT throws_ok($$ TRUNCATE institution.deadline_extension $$, 'ZD403', NULL,
  'the history cannot be truncated');
SELECT is((SELECT count(*) FROM institution.deadline_extension), 3::bigint, 'all three extension records remain');

SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.extend_assignment_deadline(
    {z1}, NULL, now() + interval '55 days', 'all') $$), '1', 'a later common extension is appended');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('ana')), now() + interval '55 days',
  'the common extension lengthens Ana''s deadline');
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('dora')), now() + interval '60 days',
  'the common extension preserves Dora''s longer individual deadline');

SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Uputa za izmišljeni zadatak.', 'essay', now() - interval '1 day',
  now() + interval '70 days', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
RESET ROLE;
SELECT is(institution.effective_due_at(pg_temp.id('z1'), pg_temp.id('dora')), now() + interval '70 days',
  'an earlier extension cannot shorten a new published deadline');
SELECT is(pg_temp.ask('dora', $$ SELECT extended_due_at IS NULL FROM institution.student_assignments() WHERE assignment_id = {z1} $$),
  'true', 'the list leaves the extension field empty when the published deadline is later');

-- Search the installed function bodies, so a later migration that shadows a
-- caller or implements a second history-based resolver is checked as well.
SELECT set_eq($$ SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('app', 'institution', 'evidence')
      AND p.prokind = 'f' AND p.prosrc ~* 'from[[:space:]]+institution\.deadline_extension\y' $$,
  $$ VALUES ('effective_due_at'), ('deadline_extensions'), ('student_deadline_history') $$,
  'only the canonical resolver and the two history projections read the extension table');
SELECT ok(p.prosrc LIKE '%' || c.fragment || '%', c.target || ' delegates to the shared deadline or stored decision')
  FROM (VALUES
    ('app.request_submission(text,bigint)', 'app.student_effective_due_at('),
    ('app.student_effective_due_at(uuid)', 'institution.effective_due_at('),
    ('app.student_workspace()', 'app.student_effective_due_at('),
    ('app.assignment_overview(uuid)', 'institution.effective_due_at('),
    ('institution.student_assignments()', 'institution.effective_due_at('),
    ('app.record_submission(uuid,text)', 'coalesce(v_request.due_at,'),
    ('app.assignment_submissions(uuid)', 'x.after_deadline')
  ) c(target, fragment) JOIN pg_proc p ON p.oid = c.target::regprocedure;

SELECT * FROM finish();
ROLLBACK;
