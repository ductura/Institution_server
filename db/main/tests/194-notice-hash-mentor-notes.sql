-- SRV-1413. All people and texts in the fixtures and assertions are invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT plan(27);

SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM institution.mentor_note WHERE mentorship_id = {ms1} $$),
  '0', 'the active mentor starts with no notes');
SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.create_mentor_note({ms1}, 'Izmisljeni privatni zapis.') $$),
  'Izmisljeni privatni zapis.', 'the mentor can add a note');
SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.mentor_note WHERE mentorship_id = {ms1} $$),
  'Izmisljeni privatni zapis.', 'the mentor can read the note');

SELECT is(pg_temp.ask(actor, $$ SELECT count(*) FROM institution.mentor_note WHERE mentorship_id = {ms1} $$),
  '0', actor || ' cannot read the mentor note through the table')
FROM (VALUES ('ana'), ('vesna'), ('iva'), ('petra'), ('anon')) AS callers(actor);
SELECT is(pg_temp.ask(actor, $$ SELECT id FROM institution.create_mentor_note({ms1}, 'Izmisljeni zapis.') $$),
  'ZD403: forbidden', actor || ' cannot write a note for this mentorship')
FROM (VALUES ('ana'), ('vesna'), ('iva'), ('petra')) AS callers(actor);
SELECT is(pg_temp.ask('anon', $$ SELECT id FROM institution.create_mentor_note({ms1}, 'Izmisljeni zapis.') $$),
  'ZD401: not authenticated', 'creating a note requires a session');
SELECT is(pg_temp.ask('nina', $$ SELECT id FROM institution.create_mentor_note({ms3}, 'Izmisljeni zapis.') $$),
  'ZD403: forbidden', 'an unconfirmed teacher cannot write');
SELECT is(pg_temp.ask('vesna', $$ SELECT id FROM institution.create_mentor_note({ms2}, 'Izmisljeni zapis.') $$),
  'ZD403: forbidden', 'an ended mentorship is closed to notes');
SELECT is(pg_temp.ask('marko', $$ SELECT id FROM institution.create_mentor_note({ms1}, E' \n\t') $$),
  'ZD422: invalid input', 'a blank note is refused');
SELECT is(pg_temp.ask('marko', $$ SELECT id FROM institution.create_mentor_note({ms1}, repeat('a', 4001)) $$),
  'ZD422: invalid input', 'a note over the text limit is refused');
SELECT is(pg_temp.ask('marko', $$ UPDATE institution.mentor_note SET body = 'Promjena' RETURNING body $$),
  '42501: permission denied for table mentor_note', 'even the mentor cannot edit notes directly');
SELECT is((SELECT count(*) FROM institution.mentor_note), 1::bigint, 'the refusals did not change the store');

UPDATE institution.mentorship SET mentor_id = pg_temp.id('vesna') WHERE id = pg_temp.id('ms1');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM institution.mentor_note WHERE mentorship_id = {ms1} $$),
  '0', 'a replacement mentor does not inherit the previous mentor notes');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM institution.mentor_note WHERE mentorship_id = {ms1} $$),
  '0', 'the former mentor no longer has access to the mentorship notes');

-- Dora confirms two versions with the same template and only the text edited.
SELECT matches(pg_temp.ask('dora', $$ SELECT institution.acknowledge_notice({z1}, 2, 1) $$),
  '^[0-9]{4}-', 'Dora confirms the initial notice');
CREATE TEMP TABLE previous_notice AS
SELECT notice_fingerprint FROM institution.notice_acknowledgment
WHERE assignment_id = pg_temp.id('z1') AND version_no = 2 AND student_id = pg_temp.id('dora');
SELECT matches((SELECT notice_fingerprint FROM previous_notice), '^[0-9a-f]{64}$',
  'the previous notice has a SHA-256 fingerprint');
SELECT is(pg_temp.ask('vesna', $$
  SELECT institution.publish_assignment_version({z1}, v.version_no, v.title, 'Nove upute za izmisljeni zadatak.',
    v.work_type, v.opens_at, v.due_at, v.ai_policy, v.ai_purposes, v.evidence_profile, v.import_allowed,
    v.word_min, v.word_max)
  FROM institution.assignment_version v WHERE v.assignment_id = {z1} AND v.version_no = 2
$$), '3', 'the teacher publishes the same notice with edited instructions');
SELECT matches(pg_temp.ask('dora', $$ SELECT institution.acknowledge_notice({z1}, 3, 1) $$),
  '^[0-9]{4}-', 'Dora confirms the edited notice');
SELECT is(
  (SELECT count(DISTINCT notice_fingerprint) FROM institution.notice_acknowledgment
   WHERE assignment_id = pg_temp.id('z1') AND version_no IN (2, 3) AND student_id = pg_temp.id('dora')),
  2::bigint, 'the two acknowledgments carry different fingerprints');
SELECT is(
  (SELECT notice_fingerprint FROM institution.notice_acknowledgment
   WHERE assignment_id = pg_temp.id('z1') AND version_no = 2 AND student_id = pg_temp.id('dora')),
  (SELECT notice_fingerprint FROM previous_notice), 'the previous fingerprint remains in the old record');

SELECT * FROM finish();
ROLLBACK;
