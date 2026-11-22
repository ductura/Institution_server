-- SRV-2007: institution.read_teaching_team_view. Every person is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT pg_temp.id(n), pg_temp.id('fak_a'), g, f
FROM (VALUES ('ana', 'Ana', 'Izmišljena'), ('dora', 'Dora', 'Zamišljena'), ('marko', 'Marko', 'Pomoćnik')) v (n, g, f);

INSERT INTO ref VALUES
  ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 213 A') $$)),
  ('g2', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 213 B') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.set_course_holder({k1}, {vesna}) $$), 'ok', 'setup step succeeds');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('marko') AND role = 'teacher';
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{marko}]::uuid[]) $$), 'ok', 'setup step succeeds');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_teaching_group_members({k1}, {g1}, ARRAY[{marko}]::uuid[], ARRAY[{ana}]::uuid[]) $$), 'ok', 'setup step succeeds');

SELECT is(pg_temp.ask('vesna', $$ SELECT (institution.read_teaching_team_view({k1})) ->> 'role' $$),
  'holder', 'the holder gets the holder view');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_view({k1}) -> 'assistants' -> 0 ->> 'name' $$),
  'Marko Pomoćnik', 'the roster carries names');
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.read_teaching_team_view({k1}) -> 'students') $$),
  '2', 'the holder sees every enrolled student');
SELECT is(pg_temp.ask('vesna', $$ SELECT (s ->> 'groupId') FROM jsonb_array_elements(institution.read_teaching_team_view({k1}) -> 'students') s WHERE s ->> 'name' = 'Ana Izmišljena' $$),
  pg_temp.id('g1')::text, 'a student carries the current group');
SELECT is(pg_temp.ask('vesna', $$ SELECT (s -> 'groupId')::text FROM jsonb_array_elements(institution.read_teaching_team_view({k1}) -> 'students') s WHERE s ->> 'name' = 'Dora Zamišljena' $$),
  'null', 'a student without a group has a null group');
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.read_teaching_team_view({k1}) -> 'groups') $$),
  '2', 'the holder sees every group');

SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_view({k1}) ->> 'role' $$),
  'assistant', 'the assistant gets the assistant view');
SELECT is(pg_temp.ask('marko', $$ SELECT jsonb_array_length(institution.read_teaching_team_view({k1}) -> 'groups') $$),
  '1', 'the assistant sees only the own group');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_view({k1}) -> 'groups' -> 0 -> 'students' -> 0 ->> 'name' $$),
  'Ana Izmišljena', 'the assistant sees the students of the own group');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_view({k1})::text LIKE '%Dora%' $$),
  'false', 'the assistant never sees a student of another group');

SELECT is(pg_temp.ask('ana', $$ SELECT institution.read_teaching_team_view({k1}) $$),
  'ZD403: forbidden', 'a student is refused');
SELECT is(pg_temp.ask('iva', $$ SELECT institution.read_teaching_team_view({k1}) $$),
  'ZD403: forbidden', 'the administrator is refused');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_view({k2}) $$),
  'ZD403: forbidden', 'a teacher of another course is refused');
SELECT is(pg_temp.ask('petra', $$ SELECT institution.read_teaching_team_view({k1}) $$),
  'ZD403: forbidden', 'a teacher of another institution is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_view({nobody}) $$),
  'ZD403: forbidden', 'an unknown course is refused like a foreign one');
SELECT is(pg_temp.ask('anon', $$ SELECT institution.read_teaching_team_view({k1}) $$),
  'ZD401: not authenticated', 'a live session is required');

SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$), 'ok', 'setup step succeeds');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_view({k1}) $$),
  'ZD403: forbidden', 'a revoked assistant is refused at once');

SELECT * FROM finish();
ROLLBACK;
