-- SRV-MENTOR-1 (Ductus#2055; owner decisions of 23 Nov 2026, MK-7, MK-3,
-- MK-10, MK-5): the teacher opens a mentorship for a student and the student
-- is told; a consultation slot gains a topic, a preparation and the moves
-- withdraw, decline and cancel; the agreed tasks of a consultation record are
-- written and marked by the teacher of the work only. Access comes from the
-- relation to the work or the mentorship, never from a role alone (C-23).
-- Personas of institution.inc and mentorship.inc; every person, work and text
-- below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000e1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000e2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, NULL, pg_temp.id('tomo'), repeat('c', 64)),
  ('doc-b', pg_temp.id('fak_b'), 1, 0, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
-- An assignment points to its current version, a deferred key: as in a real
-- transaction it is checked at the end (below, with SET CONSTRAINTS).
SET CONSTRAINTS ALL DEFERRED;

-- 1. Catalogue: the new tables have forced RLS and no privilege for any
-- runtime role; only the web role and the owner execute the new RPCs.
SELECT bag_eq(
  $$ SELECT c.oid::regclass::text FROM pg_class c
      WHERE c.oid IN ('institution.mentorship_opening'::regclass, 'collaboration.consultation_task'::regclass,
                      'collaboration.consultation_task_mark'::regclass)
        AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole $$,
  ARRAY['institution.mentorship_opening', 'collaboration.consultation_task', 'collaboration.consultation_task_mark'],
  'the three new tables belong to the owner role with ENABLE and FORCE ROW LEVEL SECURITY');
SELECT is_empty(
  $$ SELECT r || ' ' || t FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'public']) r
      CROSS JOIN unnest(ARRAY['institution.mentorship_opening', 'collaboration.consultation_task',
                              'collaboration.consultation_task_mark']) t
      WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') $$,
  'no runtime role reads or writes the new tables directly');
SELECT is_empty(
  $$ SELECT r.rolname || ' may use ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.open_mentorship(uuid,text,text)', 'app.student_mentorships()',
                             'institution.list_mentorship_notifications(uuid)',
                             'institution.consultation_slot_details(text)',
                             'institution.request_consultation_slot_detail(text,timestamptz,text,text,integer,integer)',
                             'institution.close_consultation_slot(text,uuid,text,text)',
                             'collaboration.list_consultation_tasks(text)',
                             'collaboration.add_consultation_task(text,uuid,text)',
                             'collaboration.mark_consultation_task(text,uuid,boolean)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the new RPCs');
SELECT ok(NOT has_function_privilege('ductus_app',
    'institution.insert_consultation_slot(text,timestamptz,text,text,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('ductus_app', 'collaboration.consultation_relation(text)', 'EXECUTE'),
  'the web role cannot reach the inner helpers');

-- 2. MK-7: the teacher opens a mentorship for a student.
INSERT INTO ref SELECT 'mo1', pg_temp.ask('vesna',
  $$ SELECT app.open_mentorship({dora}, 'master_thesis', 'Izmišljena tema o kompostiranju') $$);
SELECT matches((SELECT val FROM ref WHERE name = 'mo1'), '^[0-9a-f-]{36}$', 'Vesna opens a master thesis mentorship for Dora');
SELECT row_eq(
  $$ SELECT m.mentor_id, m.student_id, m.confirmed_by, m.work_type, o.topic
       FROM institution.mentorship m JOIN institution.mentorship_opening o ON o.mentorship_id = m.id
      WHERE m.id = pg_temp.id('mo1') $$,
  ROW(pg_temp.id('vesna'), pg_temp.id('dora'), pg_temp.id('vesna'), 'master_thesis'::text,
      'Izmišljena tema o kompostiranju'::text),
  'the mentorship and its opening name the teacher, the student, the kind and the topic');
SELECT is((SELECT count(*)::integer FROM institution.assignment a JOIN institution.assignment_version v ON v.assignment_id = a.id
            WHERE a.mentorship_id = pg_temp.id('mo1') AND v.version_no = 1 AND v.title = 'Diplomski rad'), 1,
  'the work of the mentorship and its first version exist from the commit on');
SELECT is((SELECT count(*)::integer FROM institution.notification
            WHERE recipient_id = pg_temp.id('dora') AND kind = 'mentorship_opened' AND target_id = pg_temp.id('mo1')), 1,
  'Dora gets one notification of the new kind');
SELECT is(pg_temp.ask('dora', $$ SELECT format('%s|%s|%s', work_type, topic, opened_by) FROM app.student_mentorships()
                                  WHERE mentorship_id = {mo1} $$),
  'master_thesis|Izmišljena tema o kompostiranju|teacher', 'Dora sees the decision, the topic and that the teacher opened it');
SELECT is(pg_temp.ask('dora', $$ SELECT (mentor_id = {vesna} AND assignment_id IS NOT NULL)::text FROM app.student_mentorships()
                                  WHERE mentorship_id = {mo1} $$),
  'true', 'Dora sees her mentor and the work');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(opened_by, ',') FROM app.student_mentorships() $$), 'request',
  'a mentorship the operator or an approval made reads as begun by a request');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.student_mentorships() $$), 'ZD403: forbidden',
  'a teacher has no student side of mentorships');
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM app.student_mentorships() $$), '^ZD401', 'no session reads none');
SELECT is(pg_temp.ask('dora', $$ SELECT format('%s|%s|%s', mentorship_id = {mo1}, work_type, read_at IS NULL)
                                  FROM institution.list_mentorship_notifications(NULL) $$),
  't|master_thesis|t', 'Dora reads her unread notification with the kind of work');
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM institution.list_mentorship_notifications(NULL) $$), '0',
  a.name || ' has no mentorship notification')
FROM (VALUES ('vesna'), ('ana'), ('boris'), ('tomo')) AS a (name);
INSERT INTO ref SELECT 'n1', id::text FROM institution.notification WHERE kind = 'mentorship_opened';
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.list_mentorship_notifications({n1}) $$),
  'ZD403: forbidden', 'another person''s notification is no cursor');

SELECT is(pg_temp.ask(c.actor, format($$ SELECT app.open_mentorship(%s, %L, %L) $$, c.student, c.kind, c.topic)),
  c.result, c.label)
FROM (VALUES
  ('vesna', '{dora}', 'master_thesis', NULL, 'ZD409: conflict', 'Dora already has an open master thesis mentorship'),
  ('vesna', '{ana}', 'master_thesis', NULL, 'ZD409: conflict', 'Ana already has one (ms1)'),
  ('ana', '{dora}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'a student opens none'),
  ('nina', '{dora}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'an unconfirmed teacher opens none'),
  ('iva', '{dora}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'the administrator opens none'),
  ('petra', '{dora}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'a teacher of another institution opens none'),
  ('vesna', '{tomo}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'a student of another institution reads as none'),
  ('vesna', '{marko}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'a confirmed teacher is no student'),
  ('vesna', '{vesna}', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'nobody mentors oneself'),
  ('vesna', '''eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee''', 'bachelor_thesis', NULL, 'ZD403: forbidden', 'an unknown account reads as none'),
  ('vesna', '{boris}', 'essay', NULL, 'ZD422: invalid input', 'an essay is no kind of mentored work'),
  ('vesna', '{boris}', 'bachelor_thesis', '', 'ZD422: invalid input', 'an empty topic is refused'),
  ('vesna', '{boris}', 'bachelor_thesis', repeat('t', 301), 'ZD422: invalid input', 'a topic over 300 characters is refused'),
  ('vesna', '{boris}', 'doctoral_thesis', NULL, 'ZD503: not set up', 'a kind without the faculty rule is not set up')
) AS c (actor, student, kind, topic, result, label);
SELECT matches(pg_temp.ask('anon', $$ SELECT app.open_mentorship({boris}, 'bachelor_thesis', NULL) $$), '^ZD401',
  'opening without a session is not signed in');
SELECT is((SELECT count(*)::integer FROM institution.mentorship_opening), 1, 'none of the refusals wrote an opening');
INSERT INTO ref SELECT 'mo2', pg_temp.ask('vesna', $$ SELECT app.open_mentorship({boris}, 'bachelor_thesis', NULL) $$);
SELECT matches((SELECT val FROM ref WHERE name = 'mo2'), '^[0-9a-f-]{36}$', 'a topic is optional');
SELECT lives_ok($$ SET CONSTRAINTS ALL IMMEDIATE $$, 'every deferred key of the openings holds');
SELECT throws_ok($$ UPDATE institution.mentorship_opening SET topic = 'Druga tema' $$, 'ZD403', NULL,
  'an opening is never changed');
SELECT throws_ok($$ DELETE FROM institution.mentorship_opening $$, 'ZD403', NULL, 'an opening is never deleted');

-- 3. MK-3 and MK-10: a request with a topic and a preparation.
INSERT INTO ref SELECT 's1', pg_temp.ask('ana', $$ SELECT institution.request_consultation_slot_detail('doc-a',
  now() + interval '3 days', 'Struktura poglavlja', 'Izmišljena priprema: preradila sam uvod.', 4, 2) $$);
SELECT matches((SELECT val FROM ref WHERE name = 's1'), '^[0-9a-f-]{36}$', 'Ana asks for a slot with a topic and a preparation');
SELECT is(pg_temp.ask(a.name, $$ SELECT format('%s|%s|%s|%s|%s', state, topic, preparation_text, preparation_changed_paragraphs,
                                  preparation_resolved_comments) FROM institution.consultation_slot_details('doc-a') WHERE id = {s1} $$),
  'requested|Struktura poglavlja|Izmišljena priprema: preradila sam uvod.|4|2', a.name || ' reads the topic and the preparation')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM institution.consultation_slot_details('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no slot of Ana''s work, so no preparation')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT count(*) FROM institution.consultation_slot_details('doc-a') $$), '^ZD401',
  'no session reads no slot');
SELECT is(pg_temp.ask('ana', $$ SELECT state FROM institution.consultation_slots('doc-a') WHERE id = {s1} $$), 'requested',
  'the older read lists the new request');
SELECT is(pg_temp.ask(c.actor, format($$ SELECT institution.request_consultation_slot_detail('doc-a', now() + interval '3 days', %L, %L, %s, %s) $$,
                                      c.topic, c.prep, c.changed, c.resolved)),
  c.result, c.label)
FROM (VALUES
  ('vesna', NULL, NULL, 'NULL', 'NULL', 'ZD403: forbidden', 'the teacher asks for no slot'),
  ('dora', NULL, NULL, 'NULL', 'NULL', 'ZD403: forbidden', 'another student asks for no slot on Ana''s work'),
  ('ana', repeat('t', 201), NULL, 'NULL', 'NULL', 'ZD422: invalid input', 'a topic over 200 characters is refused'),
  ('ana', '', NULL, 'NULL', 'NULL', 'ZD422: invalid input', 'an empty topic is refused'),
  ('ana', NULL, 'Priprema.', 'NULL', 'NULL', 'ZD422: invalid input', 'a preparation needs both counts'),
  ('ana', NULL, NULL, '1', '1', 'ZD422: invalid input', 'counts need the text'),
  ('ana', NULL, repeat('p', 4001), '1', '1', 'ZD422: invalid input', 'a preparation over 4000 characters is refused'),
  ('ana', NULL, 'Priprema.', '-1', '0', 'ZD422: invalid input', 'a negative count is refused'),
  ('ana', NULL, E'a\u0007b', '0', '0', 'ZD422: invalid input', 'a control character is refused')
) AS c (actor, topic, prep, changed, resolved, result, label);
INSERT INTO ref SELECT 's2', pg_temp.ask('ana', $$ SELECT institution.request_consultation_slot_detail('doc-a',
  now() + interval '4 days', NULL, NULL, NULL, NULL) $$);
SELECT matches((SELECT val FROM ref WHERE name = 's2'), '^[0-9a-f-]{36}$', 'topic and preparation are optional');
INSERT INTO ref SELECT 's3', pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '5 days') $$);
INSERT INTO ref SELECT 's4', pg_temp.ask('ana', $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '6 days') $$);
SELECT is(pg_temp.ask('ana', $$ SELECT coalesce(topic, '-') || '|' || coalesce(preparation_text, '-')
                                  FROM institution.consultation_slot_details('doc-a') WHERE id = {s3} $$),
  '-|-', 'a request through the older route has neither');

-- 4. Withdraw, decline, cancel.
SELECT is(pg_temp.ask(c.actor, format($$ SELECT institution.close_consultation_slot('doc-a', %s, %L, %L) $$, c.slot, c.action, c.reason)),
  c.result, c.label)
FROM (VALUES
  ('vesna', '{s1}', 'withdraw', NULL, 'ZD403: forbidden', 'the teacher withdraws nothing'),
  ('ana', '{s1}', 'decline', NULL, 'ZD403: forbidden', 'the student declines nothing'),
  ('ana', '{s1}', 'cancel', NULL, 'ZD409: not allowed', 'a request is withdrawn, not cancelled'),
  ('ana', '{s1}', 'delete', NULL, 'ZD422: invalid input', 'an unknown move is refused'),
  ('ana', '{s1}', 'withdraw', '', 'ZD422: invalid input', 'an empty reason is refused'),
  ('ana', '{s1}', 'withdraw', repeat('r', 601), 'ZD422: invalid input', 'a reason over 600 characters is refused'),
  ('dora', '{s1}', 'withdraw', NULL, 'ZD403: forbidden', 'another student moves nothing on Ana''s work'),
  ('marko', '{s1}', 'decline', NULL, 'ZD403: forbidden', 'a teacher of another course moves nothing'),
  ('petra', '{s1}', 'decline', NULL, 'ZD403: forbidden', 'a teacher of another institution moves nothing'),
  ('ana', '''eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee''', 'withdraw', NULL, 'ZD403: forbidden', 'an unknown slot reads as none')
) AS c (actor, slot, action, reason, result, label);
SELECT matches(pg_temp.ask('anon', $$ SELECT institution.close_consultation_slot('doc-a', {s1}, 'withdraw', NULL) $$), '^ZD401',
  'no session moves no slot');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.close_consultation_slot('doc-a', {s1}, 'withdraw', 'Izmišljeni razlog.') = {s1} $$),
  'true', 'Ana withdraws her request while the teacher has not answered');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s|%s|%s', state, closed_by, closed_reason, closed_at IS NOT NULL)
                                   FROM institution.consultation_slot_details('doc-a') WHERE id = {s1} $$),
  'withdrawn|student|Izmišljeni razlog.|t', 'the teacher reads the withdrawal and its reason');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.consultation_slots('doc-a') WHERE id = {s1} $$), '0',
  'the older read leaves a closed slot out');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.close_consultation_slot('doc-a', {s1}, 'withdraw', NULL) $$), 'ZD409: not allowed',
  'a withdrawn slot is not withdrawn again');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s1}, 'confirm') $$), 'ZD409: not allowed',
  'a withdrawn slot is not confirmed');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.close_consultation_slot('doc-a', {s2}, 'decline', NULL) = {s2} $$), 'true',
  'the teacher declines a request without a reason');
SELECT is(pg_temp.ask('ana', $$ SELECT format('%s|%s|%s', state, closed_by, coalesce(closed_reason, '-'))
                                 FROM institution.consultation_slot_details('doc-a') WHERE id = {s2} $$),
  'declined|teacher|-', 'Ana reads the decline');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.close_consultation_slot('doc-a', {s2}, 'withdraw', NULL) $$), 'ZD409: not allowed',
  'a declined slot is not withdrawn');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s3}, 'confirm') $$), 'confirmed',
  'the teacher confirms a third request');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.close_consultation_slot('doc-a', {s3}, 'decline', NULL) $$), 'ZD409: not allowed',
  'a confirmed slot is cancelled, not declined');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.close_consultation_slot('doc-a', {s3}, 'cancel', 'Bolovanje.') = {s3} $$), 'true',
  'the teacher cancels a confirmed slot with a reason');
SELECT is(pg_temp.ask('vesna', $$ SELECT state FROM institution.act_on_consultation_slot('doc-a', {s4}, 'counter', now() + interval '8 days') $$),
  'countered', 'the teacher answers the fourth with another time');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.close_consultation_slot('doc-a', {s4}, 'cancel', NULL) = {s4} $$), 'true',
  'the student cancels a countered slot');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(state || ':' || closed_by, ',' ORDER BY starts_at)
                                 FROM institution.consultation_slot_details('doc-a') $$),
  'withdrawn:student,declined:teacher,cancelled:teacher,cancelled:student', 'each slot keeps its state and who closed it');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*) FROM institution.consultation_slots('doc-a') $$), '0',
  'the older read lists none of the closed slots');
UPDATE institution.consultation_slot SET starts_at = now() - interval '1 hour', state = 'confirmed',
  closed_by = NULL, closed_reason = NULL, closed_at = NULL WHERE id = pg_temp.id('s4');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.close_consultation_slot('doc-a', {s4}, 'cancel', NULL) $$), 'ZD409: not allowed',
  'a slot whose time has passed is not cancelled');
SELECT throws_ok($$ UPDATE institution.consultation_slot SET state = 'cancelled' WHERE id = pg_temp.id('s4') $$, '23514', NULL,
  'the table refuses a closed state without who closed it');

-- 5. MK-5: the agreed tasks, written and marked by the teacher of the work only.
INSERT INTO ref SELECT 'r1', pg_temp.ask('vesna', $$ SELECT collaboration.create_consultation_record('doc-a', '2026-11-20', 1,
  'Prvi sastanak', 'Izmišljeni dogovor.') $$);
INSERT INTO ref SELECT 't1', pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_task('doc-a', {r1}, 'Dopuniti popis izvora') $$);
SELECT matches((SELECT val FROM ref WHERE name = 't1'), '^[0-9a-f-]{36}$', 'the teacher adds an agreed task');
SELECT is(pg_temp.ask(c.actor, format($$ SELECT collaboration.add_consultation_task(%L, %s, %L) $$, c.doc, c.record, c.body)),
  c.result, c.label)
FROM (VALUES
  ('ana', 'doc-a', '{r1}', 'Zadatak', 'ZD403: forbidden', 'the student writes no task'),
  ('dora', 'doc-a', '{r1}', 'Zadatak', 'ZD403: forbidden', 'another student writes none'),
  ('marko', 'doc-a', '{r1}', 'Zadatak', 'ZD403: forbidden', 'a teacher of another course writes none'),
  ('petra', 'doc-a', '{r1}', 'Zadatak', 'ZD403: forbidden', 'a teacher of another institution writes none'),
  ('vesna', 'doc-b', '{r1}', 'Zadatak', 'ZD403: forbidden', 'a record is not reachable through another work'),
  ('vesna', 'doc-a', '''eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee''', 'Zadatak', 'ZD403: forbidden', 'an unknown record reads as none'),
  ('vesna', 'doc-a', '{r1}', '  ', 'ZD422: invalid input', 'a blank task is refused'),
  ('vesna', 'doc-a', '{r1}', repeat('z', 501), 'ZD422: invalid input', 'a task over 500 characters is refused')
) AS c (actor, doc, record, body, result, label);
SELECT matches(pg_temp.ask('anon', $$ SELECT collaboration.add_consultation_task('doc-a', {r1}, 'Zadatak') $$), '^ZD401',
  'no session writes no task');
SELECT is(pg_temp.ask(a.name, $$ SELECT format('%s|%s|%s', task_position, body, done) FROM collaboration.list_consultation_tasks('doc-a') $$),
  '1|Dopuniti popis izvora|f', a.name || ' reads the task, not done')
FROM (VALUES ('ana'), ('vesna')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT count(*) FROM collaboration.list_consultation_tasks('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no task of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.mark_consultation_task('doc-a', {t1}, true) $$), 'ZD403: forbidden',
  'the student marks no task');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.mark_consultation_task('doc-a', {t1}, NULL) $$), 'ZD422: invalid input',
  'a mark needs done or not done');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.mark_consultation_task('doc-b', {t1}, true) $$), 'ZD403: forbidden',
  'a task is not reachable through another work');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.mark_consultation_task('doc-a', {t1}, true) = {t1} $$), 'true',
  'the teacher marks the task done');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.mark_consultation_task('doc-a', {t1}, true) = {t1} $$), 'true',
  'marking it done again answers the same');
SELECT is((SELECT count(*)::integer FROM collaboration.consultation_task_mark WHERE task_id = pg_temp.id('t1')), 1,
  'and adds no second mark');
SELECT is(pg_temp.ask('ana', $$ SELECT format('%s|%s', done, marked_at IS NOT NULL) FROM collaboration.list_consultation_tasks('doc-a') $$),
  't|t', 'Ana reads the task as done');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.mark_consultation_task('doc-a', {t1}, false) = {t1} $$), 'true',
  'the teacher marks it not done again');
SELECT is(pg_temp.ask('ana', $$ SELECT done::text FROM collaboration.list_consultation_tasks('doc-a') $$), 'false',
  'the newest mark is the state');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(collaboration.add_consultation_task('doc-a', {r1}, 'Zadatak ' || g)) FROM generate_series(2, 20) g $$),
  '19', 'a record holds 20 tasks');
SELECT is(pg_temp.ask('vesna', $$ SELECT collaboration.add_consultation_task('doc-a', {r1}, 'Dvadeset prvi') $$), 'ZD422: invalid input',
  'but not 21');
SELECT is(pg_temp.ask('ana', $$ SELECT string_agg(task_position::text, ',' ORDER BY task_position) = string_agg(g::text, ',' ORDER BY g)
                                 FROM collaboration.list_consultation_tasks('doc-a') JOIN generate_series(1, 20) g ON g = task_position $$),
  'true', 'the tasks are numbered 1 to 20 in the order they were added');
SELECT throws_ok($$ UPDATE collaboration.consultation_task SET body = 'Drugo' WHERE id = pg_temp.id('t1') $$, 'ZD403', NULL,
  'a task is never changed');
SELECT throws_ok($$ DELETE FROM collaboration.consultation_task_mark $$, 'ZD403', NULL, 'a mark is never deleted');

SELECT * FROM finish();
ROLLBACK;
