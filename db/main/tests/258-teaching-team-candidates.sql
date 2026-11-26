-- DEMO-POP-4-SRV: institution.read_teaching_team_candidates. Every person is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
SELECT pg_temp.id(n), pg_temp.id(f), g, l
FROM (VALUES ('marko', 'fak_a', 'Marko', 'Pomoćnik'), ('vesna', 'fak_a', 'Vesna', 'Nositeljica'),
             ('petra', 'fak_b', 'Petra', 'Strana')) v (n, f, g, l);

SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.set_course_holder({k1}, {vesna}) $$), 'ok', 'setup step succeeds');
SELECT is(pg_temp.ask('petra', $$ SELECT 'ok' FROM institution.set_course_holder({k3}, {petra}) $$), 'ok', 'setup step succeeds');

SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  jsonb_build_array(jsonb_build_object('id', pg_temp.id('marko'), 'name', 'Marko Pomoćnik'))::text,
  'the holder gets the confirmed teachers of the institution with only an ID and a name');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1})::text LIKE '%' || {nina} || '%' $$),
  'false', 'a teacher whose role is not confirmed is no candidate');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1})::text LIKE '%' || {petra} || '%' $$),
  'false', 'a teacher of another institution is no candidate');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1})::text LIKE '%' || {vesna} || '%' $$),
  'false', 'the holder is no candidate');
SELECT is(pg_temp.ask('petra', $$ SELECT institution.read_teaching_team_candidates({k3}) $$),
  '[]', 'an institution without other teachers gives an empty list');

-- An open teacher of the course is no candidate; an ended one is again.
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('marko'), 'teacher');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  '[]', 'an open teacher of the course is no candidate');
UPDATE institution.course_member SET member_to = now()
 WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('marko') AND role = 'teacher';
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.read_teaching_team_candidates({k1})) $$),
  '1', 'an ended teacher of the course is a candidate again');

-- An added assistant leaves the list; a removed one returns to it.
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY[{marko}]::uuid[]) $$), 'ok', 'setup step succeeds');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  '[]', 'an active assistant is no candidate');
SELECT is(pg_temp.ask('marko', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  'ZD403: forbidden', 'an assistant of the course is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$), 'ok', 'setup step succeeds');
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.read_teaching_team_candidates({k1})) $$),
  '1', 'a removed assistant is a candidate again');

-- Every candidate can be added: the list matches what replace_course_assistants accepts.
SELECT is(pg_temp.ask('vesna', $$
  SELECT 'ok' FROM institution.replace_course_assistants({k1}, ARRAY(
    SELECT (c ->> 'id')::uuid FROM jsonb_array_elements(institution.read_teaching_team_candidates({k1})) c)) $$),
  'ok', 'every candidate is accepted as an assistant');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.replace_course_assistants({k1}, '{}'::uuid[]) $$), 'ok', 'setup step succeeds');

-- A revoked teacher role leaves the list.
UPDATE institution.institution_role SET revoked_at = now()
 WHERE user_id = pg_temp.id('marko') AND role = 'teacher';
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  '[]', 'a teacher with a revoked role is no candidate');

SELECT is(pg_temp.ask('ana', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  'ZD403: forbidden', 'a student of the course is refused');
SELECT is(pg_temp.ask('iva', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  'ZD403: forbidden', 'the administrator is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k2}) $$),
  'ZD403: forbidden', 'a teacher who is not the holder is refused');
SELECT is(pg_temp.ask('petra', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  'ZD403: forbidden', 'a holder of another institution is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({k3}) $$),
  'ZD403: forbidden', 'a course of another institution is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.read_teaching_team_candidates({nobody}) $$),
  'ZD403: forbidden', 'an unknown course is refused like a foreign one');
SELECT is(pg_temp.ask('anon', $$ SELECT institution.read_teaching_team_candidates({k1}) $$),
  'ZD401: not authenticated', 'a live session is required');

SELECT * FROM finish();
ROLLBACK;
