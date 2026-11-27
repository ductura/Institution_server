-- SRV-F4-MEN-R09-SRV. All people and texts in the fixtures and assertions are invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT plan(25);

-- Before the mentor writes anything her student reads nothing.
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.read_mentor_working_style({marko}) $$),
  '0', 'a student of the mentor reads no text before the mentor wrote one');

SELECT is(pg_temp.ask('anon', $$ SELECT body FROM institution.set_mentor_working_style('Izmisljeni tekst.') $$),
  'ZD401: not authenticated', 'writing requires a session');
SELECT is(pg_temp.ask(actor, $$ SELECT body FROM institution.set_mentor_working_style('Izmisljeni tekst.') $$),
  'ZD403: forbidden', actor || ' is no confirmed teacher and cannot write')
FROM (VALUES ('ana'), ('dora'), ('nina')) AS callers(actor);
SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.set_mentor_working_style(E' \n\t') $$),
  'ZD422: invalid input', 'a blank text is refused');
SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.set_mentor_working_style(repeat('a', 1001)) $$),
  'ZD422: invalid input', 'a text over 1000 characters is refused');
SELECT is((SELECT count(*) FROM institution.mentor_working_style), 0::bigint, 'the refusals stored nothing');

SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.set_mentor_working_style(repeat('a', 1000)) $$),
  repeat('a', 1000), 'the mentor can write a text of exactly 1000 characters');
SELECT is(pg_temp.ask('marko', $$ SELECT body FROM institution.set_mentor_working_style('Izmisljeni nacin rada: tjedni sastanak.') $$),
  'Izmisljeni nacin rada: tjedni sastanak.', 'the mentor replaces the own text');
SELECT is((SELECT count(*) FROM institution.mentor_working_style), 1::bigint, 'one row per mentor');

SELECT is(pg_temp.ask('ana', $$ SELECT body FROM institution.read_mentor_working_style({marko}) $$),
  'Izmisljeni nacin rada: tjedni sastanak.', 'the student of the mentor reads the text');

-- Everybody else gets the same answer as for a mentor that does not exist.
SELECT is(pg_temp.ask(actor, $$ SELECT body FROM institution.read_mentor_working_style({marko}) $$),
  'ZD403: forbidden', actor || ' has no mentorship with this mentor and reads nothing')
FROM (VALUES ('dora'), ('boris'), ('iva'), ('marko'), ('vesna'), ('petra'), ('tomo')) AS callers(actor);
SELECT is(pg_temp.ask('anon', $$ SELECT body FROM institution.read_mentor_working_style({marko}) $$),
  'ZD401: not authenticated', 'reading requires a session');
SELECT is(pg_temp.ask('ana', $$ SELECT body FROM institution.read_mentor_working_style('00000000-0000-4000-8000-00000000ffff') $$),
  'ZD403: forbidden', 'an unknown mentor reads the same as a foreign one');
SELECT is(pg_temp.ask('ana', $$ SELECT body FROM institution.read_mentor_working_style(NULL) $$),
  'ZD403: forbidden', 'a null mentor reads the same as a foreign one');

-- Nothing reaches the table directly, not even for the mentor.
SELECT is(pg_temp.ask('marko', $$ SELECT count(*) FROM institution.mentor_working_style $$),
  '42501: permission denied for table mentor_working_style', 'the mentor cannot read the table directly');
SELECT is(pg_temp.ask('marko', $$ UPDATE institution.mentor_working_style SET body = 'Promjena' RETURNING body $$),
  '42501: permission denied for table mentor_working_style', 'the mentor cannot edit the table directly');

-- An ended mentorship closes the text to that student.
UPDATE institution.mentorship SET ended_at = now() WHERE id = pg_temp.id('ms1');
SELECT is(pg_temp.ask('ana', $$ SELECT body FROM institution.read_mentor_working_style({marko}) $$),
  'ZD403: forbidden', 'a student whose mentorship ended reads nothing');

SELECT * FROM finish();
ROLLBACK;
