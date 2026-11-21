-- SRV-1410, M2 (D-50, F-06): the accommodation mark and the language of the
-- work. Acceptance: (1) an assistant and other students do not see the mark;
-- (2) a language outside the closed set fails on the CHECK, and one the
-- institution does not offer is refused; (3) there is no free text for a
-- reason; (4) the student reads the language of their own work.
-- Personas of institution.inc and mentorship.inc; everything is invented.
--
--   Vesna teaches K1 (Z1), whose students are Ana and Dora; Marko, a teacher
--   of K2, becomes the assistant of Ana's seminar group; Iva is the admin.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT no_plan();

-- (3) No free text anywhere near the mark or its calls.
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
     FROM pg_attribute a WHERE a.attrelid = 'institution.work_accommodation'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'institution_id uuid, assignment_id uuid, student_id uuid, marked_at timestamp with time zone',
  '3: the mark is a row of ids and a time, with no column for a reason');
SELECT is(
  (SELECT pg_get_function_identity_arguments('institution.set_work_accommodation(uuid, boolean)'::regprocedure)),
  'p_assignment_id uuid, p_marked boolean',
  '3: the writer takes the assignment and yes or no, no text');

-- (1) Ana marks her work; Dora, another student, sees nothing and no row.
SELECT is(pg_temp.ask('ana', $$ SELECT institution.set_work_accommodation({z1}, true)::text $$), 'true', '1: Ana marks her work');
SELECT is(pg_temp.ask('dora', $$ SELECT coalesce(institution.work_accommodation({z1}, {ana})::text, 'null') $$), 'null',
  '1: another student reads no mark');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM institution.work_accommodation WHERE student_id = {ana} $$), '0',
  '1: another student selects no row of Ana''s');
-- The holder reads it; an assistant of Ana's seminar group does not.
SELECT is(pg_temp.ask('vesna', $$ SELECT coalesce(institution.work_accommodation({z1}, {ana})::text, 'null') $$), 'true',
  '1: the holder of the course reads the mark');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa A')::text IS NOT NULL $$), 'true', '1: a group is opened');
INSERT INTO ref VALUES ('ga', (SELECT id::text FROM institution.seminar_group WHERE course_id = pg_temp.id('k1') ORDER BY created_at DESC LIMIT 1));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({ga}, {marko}) $$), 'ok', '1: Marko is the assistant of the group');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({ga}, {ana}) $$), 'ok', '1: Ana is in the group');
SELECT is(pg_temp.ask('marko', $$ SELECT coalesce(institution.work_accommodation({z1}, {ana})::text, 'null') $$), 'null',
  '1: the assistant reads no mark');
SELECT is(pg_temp.ask('marko', $$ SELECT count(*)::text FROM institution.work_accommodation WHERE assignment_id = {z1} $$), '0',
  '1: the assistant selects no row');

-- (4) The student reads the language of their own work; no one else's.
SELECT is(pg_temp.ask('ana', $$ SELECT institution.work_language({z1}, {ana}) $$), 'hr', '4: Ana reads her own language');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_language({z1}, {ana}, 'en') $$), 'en', '4: the holder sets one work to en');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.work_language({z1}, {ana}) $$), 'en', '4: Ana reads en on her own work');
SELECT is(pg_temp.ask('dora', $$ SELECT coalesce(institution.work_language({z1}, {ana}), 'null') $$), 'null',
  '4: another student reads no language of Ana''s');
SELECT is(pg_temp.ask('dora', $$ SELECT institution.work_language({z1}, {dora}) $$), 'hr', '4: Dora keeps the language of the assignment');

-- (2) Outside the closed set: the CHECK, and the call, refuse it.
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_language({z1}, {ana}, 'de') $$), 'ZD422: invalid input',
  '2: de is refused by the call');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
  $$ INSERT INTO institution.work_language_override (institution_id, assignment_id, student_id, work_language, set_by)
     SELECT institution_id, assignment_id, student_id, 'de', student_id FROM institution.work_language_override LIMIT 1 $$),
  '23514: new row for relation "work_language_override" violates check constraint "work_language_override_work_language_check"',
  '2: de fails on the CHECK');

-- (2) The list of the institution: only hr offered from config version 1.
INSERT INTO ref VALUES ('rules_hr', '{"citationStyle": "fpzg", "workLanguages": ["hr"], "defaultWorkLanguage": "hr"}');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(0, {rules_hr}::jsonb)::text $$), '1', '2: the admin publishes hr only');
INSERT INTO ref VALUES ('z_cfg', pg_temp.ask('vesna', $$ SELECT institution.create_assignment({k1}, 'Izmišljeni zadatak', 'Upute.', 'essay', now(),
  now() + interval '30 days', 'prohibited', '{}'::text[], 'basic', false, NULL, NULL)::text $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_language({z_cfg}, {ana}, 'en') $$), 'ZD422: invalid input',
  '2: en is not offered by the config of the assignment');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_assignment_work_language({z_cfg}, 1, 'en')::text $$), 'ZD422: invalid input',
  '2: en is not offered for the whole assignment either');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_language({z_cfg}, {ana}, 'hr') $$), 'hr',
  '2: hr, which is offered, is accepted');
-- An assignment without a config version keeps the closed set.
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_language({z1}, {dora}, 'en') $$), 'en',
  '2: an assignment from before any config version keeps hr and en');

-- A config that offers only en: a new assignment can still be created, and its
-- first version takes en from the config, not a fixed hr.
INSERT INTO ref VALUES ('rules_en', '{"citationStyle": "fpzg", "workLanguages": ["en"], "defaultWorkLanguage": "en"}');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(1, {rules_en}::jsonb)::text $$), '2', '2: the admin publishes en only');
INSERT INTO ref VALUES ('z_en', pg_temp.ask('vesna', $$ SELECT institution.create_assignment({k1}, 'Izmišljeni zadatak na engleskom', 'Upute.', 'essay', now(),
  now() + interval '30 days', 'prohibited', '{}'::text[], 'basic', false, NULL, NULL)::text $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT v.work_language FROM institution.assignment_version v WHERE v.assignment_id = {z_en}::uuid AND v.version_no = 1 $$), 'en',
  '2: the first version takes the default language of the config');

SELECT * FROM finish();
ROLLBACK;
