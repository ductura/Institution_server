BEGIN;
\ir fixtures/institution.inc
SELECT plan(17);

SELECT is(pg_temp.ask('anon', 'SELECT count(*) FROM institution.list_notifications(NULL, 300)'),
  'ZD401: not authenticated', 'anonymous cannot list');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'assignment_version' AND target_id = {z1} $$), '1', 'recipient sees her own version notice');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'assignment_version' AND target_id = {z1} $$), '0', 'teacher does not see student notices');
SELECT is(pg_temp.ask('tomo', 'SELECT count(*) FROM institution.list_notifications(NULL, 300)'),
  '0', 'another institution sees no notices');

INSERT INTO ref (name, val)
SELECT 'ana-notice', id FROM institution.notification WHERE recipient_id = pg_temp.id('ana');
SELECT is(pg_temp.ask('dora', 'SELECT institution.read_notification({ana-notice})'), 'false',
  'another recipient cannot mark a notice');
SELECT is(pg_temp.ask('dora', 'SELECT count(*) FROM institution.list_notifications({ana-notice}, 300)'),
  'ZD403: forbidden', 'a cursor for another recipient is denied');
SELECT is(pg_temp.ask('ana', 'SELECT institution.read_notification({ana-notice})'), 'true',
  'a recipient marks her own notice');
CREATE TEMP TABLE original_read AS SELECT read_at FROM institution.notification WHERE id = pg_temp.id('ana-notice');
SELECT is(pg_temp.ask('ana', 'SELECT institution.read_notification({ana-notice})'), 'true',
  'retry succeeds');
SELECT ok((SELECT n.read_at IS NOT NULL AND n.read_at = o.read_at
  FROM institution.notification n CROSS JOIN original_read o WHERE n.id = pg_temp.id('ana-notice')),
  'retry preserves the first read time');

INSERT INTO ref (name, val) VALUES
  ('due-1', '00000000-0000-4000-8000-0000000000d1'),
  ('due-2', '00000000-0000-4000-8000-0000000000d2');
INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
SELECT pg_temp.id(x.name), pg_temp.id('k1'), pg_temp.id('fak_a'), 1, pg_temp.id('vesna')
FROM (VALUES ('due-1'), ('due-2')) x(name);
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
  opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
SELECT pg_temp.id(x.name), 1, v.title, v.instructions, v.work_type, now() - interval '1 day',
  now() + x.remaining, v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed, v.created_by
FROM institution.assignment_version v CROSS JOIN (VALUES
  ('due-1', interval '1 hour'), ('due-2', interval '2 hours')) x(name, remaining)
WHERE v.assignment_id = pg_temp.id('z1') AND v.version_no = 1;

SELECT is(pg_temp.ask('ana', $$ SELECT target_id FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), pg_temp.id('due-1')::text, 'nearest eligible deadline first');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), '1', 'a second assignment is throttled for the same recipient');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), '1', 'another recipient has an independent limit');
SELECT is(pg_temp.ask('tomo', $$ SELECT count(*) FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), '0', 'a deadline cannot cross institutions');
UPDATE institution.notification SET created_at = clock_timestamp() - interval '6 minutes'
WHERE recipient_id = pg_temp.id('ana') AND kind = 'deadline_reminder';
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), '1', 'configured interval can be stricter than P-03');
UPDATE institution.notification SET created_at = clock_timestamp() - interval '16 minutes'
WHERE recipient_id = pg_temp.id('ana') AND kind = 'deadline_reminder';
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 900)
  WHERE kind = 'deadline_reminder' $$), '2', 'after the interval the next deadline is eligible');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 0)
  WHERE kind = 'deadline_reminder' $$), '2', 'invalid configuration cannot bypass P-03');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'deadline_reminder' $$), '1', 'the teacher has a separate assignment reminder');

SELECT * FROM finish();
ROLLBACK;
