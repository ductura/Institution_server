BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT plan(31);

SELECT is(pg_temp.ask('anon', 'SELECT count(*) FROM institution.list_notifications(NULL, 300)'),
  'ZD401: not authenticated', 'anonymous cannot list');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'assignment_version' AND target_id = {z1} $$), '1', 'recipient sees her own version notice');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'assignment_version' AND target_id = {z1} $$), '0', 'teacher does not see student notices');
SELECT is(pg_temp.ask('tomo', 'SELECT count(*) FROM institution.list_notifications(NULL, 300)'),
  '0', 'another institution sees no notices');

INSERT INTO ref (name, val)
SELECT 'ana-notice', id::text FROM institution.notification WHERE recipient_id = pg_temp.id('ana');
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
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
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
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;

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
SELECT matches(pg_temp.ask('vesna', $$ SELECT id FROM institution.extend_assignment_deadline({due-1}, {ana}, now() + interval '3 hours', 'justified') $$),
  '^[0-9a-f-]{36}$', 'extend the first effective deadline only for Ana');
UPDATE institution.notification SET created_at = clock_timestamp() - interval '6 minutes'
WHERE kind = 'deadline_reminder';
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300)
  WHERE kind = 'deadline_reminder' AND target_id = {due-1} $$), '2', 'a new effective deadline qualifies again after the interval');

SELECT matches(pg_temp.ask('vesna', $$ SELECT collaboration.create_comment_draft('doc-a', 'Izmišljeni komentar.',
  '{"nodeId":"aaaaaaaa-0000-4000-8000-000000000001","quote":"primjer","prefix":"","suffix":"","startHint":0,"endHint":7}'::jsonb) $$),
  '^[0-9a-f-]{36}$', 'the teacher creates a draft');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300) WHERE kind = 'comment_posted' $$),
  '0', 'the draft creates no notification');
SAVEPOINT before_publish;
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*) FROM collaboration.publish_comments('doc-a') $$),
  '^[0-9]+$', 'the teacher publishes the comment');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300) WHERE kind = 'comment_posted' $$),
  '1', 'publishing adds the notification to the student inbox');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300) WHERE kind = 'comment_posted' $$),
  '0', 'another student of the course receives no comment notification');
ROLLBACK TO SAVEPOINT before_publish;
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300) WHERE kind = 'comment_posted' $$),
  '0', 'rolling back publication removes its notification');

SELECT is(pg_temp.call('ana','pkg-a','request-1',pg_temp.descriptor(),0,repeat('a',64),repeat('d',64),repeat('b',64)),
  'reserved', 'create a revision for the submission fixture');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a',1) $$), 'requested', 'request submission');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request),%L)', pg_temp.h('d'))),
  'recorded', 'record the submission');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_notifications(NULL, 300) WHERE kind = 'submission_recorded' $$),
  '0', 'a submission awaiting a signature creates no notification');
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.signing_key (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
VALUES ('key-a', '1', '00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'receipt', 'Ed25519',
  'MCowBQYDK2VwAyEA'||translate(rtrim(encode(decode(repeat('11',32),'hex'),'base64'),'='),'+/','-_'),
  date_trunc('minute',now()) - interval '1 day');
RESET ROLE;
INSERT INTO ref SELECT 'submission', id::text FROM evidence.submission;
INSERT INTO ref SELECT 'issuance', pg_temp.ask('ana', $$ SELECT issuance_id::text FROM app.prepare_submission_receipt({submission}, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', format($$ SELECT outcome FROM app.attach_submission_receipt({issuance}, %L, %L::jsonb) $$,
  (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance WHERE id = pg_temp.id('issuance')),
  jsonb_build_object('algorithm','Ed25519','keyId','key-a','keyVersion','1','signatureEncoding','raw',
                     'signatureBase64Url',repeat('A',86)))), 'attached', 'bind the invented signed receipt');
SELECT is(pg_temp.ask('ana', $$ SELECT target_id FROM institution.list_notifications(NULL, 300) WHERE kind = 'submission_recorded' $$),
  pg_temp.id('z1')::text, 'after signing the student sees the notice for her own assignment');

SELECT * FROM finish();
ROLLBACK;
