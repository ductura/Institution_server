-- SRV-7B step (b) (Ductus#2028, c.7037154952): a teacher of a student's work
-- adds, changes and removes recommended and required sources in that work's
-- source list; the student reads them and does not change them, and the
-- teacher does not change the student's own. Every person, course, source and
-- text below is invented (fixtures/institution.inc, fixtures/mentorship.inc).
BEGIN;
\ir fixtures/institution.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SET LOCAL lc_messages TO 'C';

SELECT plan(36);

-- A valid book record with id p_id, merged with p_extra.
CREATE FUNCTION pg_temp.rec(p_id text, p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'type', 'book', 'year', 2023, 'title', 'Gradski vrtovi',
           'authors', jsonb_build_array(jsonb_build_object('kind', 'organization', 'name', 'Izmišljeni zavod')),
           'place', 'Split', 'publisher', 'Izmišljena naklada') || p_extra
$$;
-- 'ok' for a teacher's saved source, else the SQLSTATE of the refusal.
CREATE FUNCTION pg_temp.tsave(p_actor text, p_assignment text, p_student text, p_record jsonb,
                              p_requirement text DEFAULT 'required') RETURNS text
LANGUAGE sql AS $$
  SELECT substr(pg_temp.ask(p_actor, format(
    'SELECT ''ok'' FROM institution.save_teacher_work_source(%s, %s, %L::jsonb, %L)',
    p_assignment, p_student, p_record, p_requirement)), 1, 5)
$$;
-- The sources of a work as the student reads them: title:requirement, oldest first.
CREATE FUNCTION pg_temp.list(p_actor text, p_assignment text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT coalesce(string_agg((record->>''title'') || '':'' || coalesce(requirement, ''-''), ''|'' ORDER BY created_at, id), ''-'') FROM institution.work_sources(%s)',
    p_assignment))
$$;
INSERT INTO ref VALUES ('s1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('t1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
                       ('t2', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

-- 1. Who may call what.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.save_teacher_work_source(uuid,uuid,jsonb,text,text,text,boolean)',
                             'institution.delete_teacher_work_source(uuid,uuid,uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only ductus_app and the owner execute the two teacher RPCs'
);

-- 2. The input, checked before the relation.
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), t.req), 'ZD422', t.label)
FROM (VALUES (NULL, 'no requirement is refused'), ('optional', 'an unknown requirement is refused'),
             ('Required', 'a requirement in capitals is refused')) AS t (req, label);
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{"year": 99}')),
  'ZD422', 'the record''s shape is the student''s: a year before 1000 is refused');
SELECT is(pg_temp.tsave('boris', '{z1}', '{ana}', '{}'::jsonb), 'ZD422',
  'the input is checked before the relation, so its refusal says nothing of the work');
SELECT is(substr(pg_temp.ask('vesna', format(
  'SELECT ''ok'' FROM institution.save_teacher_work_source({z1}, {ana}, %L::jsonb, ''required'', ''10.1000/X'')',
  pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))), 1, 5), 'ZD422', 'a DOI in capitals is refused here too');

-- 3. The teacher of K1 adds a required source to Ana's work; Ana reads it.
SELECT is(substr(pg_temp.ask('ana', format('SELECT ''ok'' FROM institution.save_work_source({z1}, %L::jsonb)',
  pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"title": "Moj izvor"}'))), 1, 5), 'ok', 'Ana saves a source of her own');
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{"title": "Obvezno"}')),
  'ok', 'Vesna adds a required source to Ana''s work');
SELECT is(pg_temp.list('ana', '{z1}'), 'Moj izvor:-|Obvezno:required', 'Ana reads both, with the requirement');
SELECT results_eq(
  $$ SELECT p.name, w.institution_id FROM institution.work_source w JOIN person p ON p.id = w.added_by
      WHERE w.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' $$,
  $$ VALUES ('vesna', pg_temp.id('fak_a')) $$,
  'the teacher''s source is added by Vesna, in the institution of the session'
);
SELECT is(pg_temp.list('dora', '{z1}'), '-', 'it is in Ana''s work only, not in Dora''s');

-- 4. Neither side changes the other's source.
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')), 'ZD403',
  'Vesna cannot turn Ana''s own source into a required one');
SELECT is(substr(pg_temp.ask('vesna', $$ SELECT institution.delete_teacher_work_source({z1}, {ana}, {s1})::text $$), 1, 5),
  'ZD403', 'nor remove it');
SELECT is(substr(pg_temp.ask('ana', format('SELECT ''ok'' FROM institution.save_work_source({z1}, %L::jsonb)',
  pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))), 1, 5), 'ZD403', 'Ana cannot change the required source');
SELECT is(substr(pg_temp.ask('ana', $$ SELECT institution.delete_work_source({z1}, {t1})::text $$), 1, 5), 'ZD403',
  'nor remove it');
SELECT is(pg_temp.list('ana', '{z1}'), 'Moj izvor:-|Obvezno:required', 'both are as they were');

-- 5. Other teachers of the work: seminar group teacher, collaborator, mentor.
INSERT INTO ref VALUES ('g1', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa 1') $$));
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_teacher({g1}, {marko}) $$), 'ok',
  'fixture: Marko teaches G1');
SELECT is(pg_temp.ask('vesna', $$ SELECT 'ok' FROM institution.assign_group_student({g1}, {ana}) $$), 'ok',
  'fixture: Ana joins G1');
SELECT is(pg_temp.tsave('marko', '{z1}', '{ana}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '{"title": "Preporuka"}'),
  'recommended'), 'ok', 'the teacher of Ana''s seminar group recommends a source');
SELECT is(pg_temp.tsave('marko', '{z1}', '{dora}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD403',
  'but not to a student outside his group');
SELECT is(pg_temp.tsave('marko', '{z1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{"title": "Obvezno 2"}'),
  'recommended'), 'ok', 'any teacher of the work changes a teacher''s source, also its requirement');
SELECT results_eq(
  $$ SELECT p.name, w.requirement, w.record->>'title', w.updated_at >= w.created_at
       FROM institution.work_source w JOIN person p ON p.id = w.added_by
      WHERE w.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' $$,
  $$ VALUES ('vesna', 'recommended', 'Obvezno 2', true) $$,
  'the change keeps who added it'
);
INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES (pg_temp.id('nina'), pg_temp.id('fak_a'));
SELECT is(pg_temp.ask('iva', $$ SELECT 'ok' FROM institution.confirm_teacher_role({nina}) $$), 'ok',
  'fixture: Iva confirms Nina''s teacher role');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
  VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('nina'), 'teacher');
SELECT is(pg_temp.tsave('nina', '{z1}', '{dora}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '{"title": "Za Doru"}')),
  'ok', 'a collaborator of the course adds a source to Dora''s work');
SELECT is(pg_temp.list('dora', '{z1}'), 'Za Doru:required', 'Dora reads it');
SELECT is(pg_temp.tsave('marko', '{zm1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{"title": "Mentorovo"}')),
  'ok', 'the mentor adds a source to Ana''s mentored work, apart from Z1');
SELECT is(pg_temp.list('ana', '{zm1}'), 'Mentorovo:required', 'Ana reads it there');
SELECT is(pg_temp.tsave('vesna', '{zm1}', '{ana}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD403',
  'the teacher of K1 adds nothing to the mentored work');
SELECT is(pg_temp.tsave('vesna', '{z1}', '{vesna}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD403',
  'nor to a work of her own name');
SELECT is(pg_temp.tsave('vesna', '{z1}', '{nobody}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD403',
  'nor to a student that does not exist');

-- 6. Removal of a teacher's source, and the bound of 500.
SELECT is(substr(pg_temp.ask('vesna', $$ SELECT institution.delete_teacher_work_source({z1}, {ana}, {t2})::text $$), 1, 5),
  'true', 'Vesna removes Marko''s recommendation');
SELECT is(substr(pg_temp.ask('vesna', $$ SELECT institution.delete_teacher_work_source({z1}, {ana}, {t2})::text $$), 1, 5),
  'false', 'a second time it is not there');
INSERT INTO institution.work_source (institution_id, assignment_id, student_id, id, record, added_by)
SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), u, pg_temp.rec(u::text), pg_temp.id('ana')
  FROM (SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS u FROM generate_series(1, 498) n) g;
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('dddddddd-dddd-4ddd-8ddd-dddddddddddd')), 'ZD422',
  'a teacher''s 501st source is refused');
SELECT is(pg_temp.tsave('vesna', '{z1}', '{ana}', pg_temp.rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 'required'), 'ok',
  'a change of one of the 500 passes');
SELECT is((SELECT count(*) FROM audit.access_log), 0::bigint, 'no teacher call writes the access log');

SELECT * FROM finish();
ROLLBACK;
