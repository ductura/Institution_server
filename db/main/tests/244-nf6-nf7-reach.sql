-- INT-28 (Ductus#2055): the reach of the NF-6/NF-7 tables across roles, as one
-- matrix over what 232-243 test one feature at a time. The setup first gives
-- Ana's mentored work real rows (a sealed note under her key, a form state, the
-- mentor's consent, a consultation slot, a record with a task, messages and
-- seen marks), so every refusal below is measured against something to reach:
-- the owner and her mentor read an exact answer, everyone else an exact error.
-- The rules:
--   1. a network engineer reaches no work, note, consultation, form, consent
--      or declaration answer of a student; the role adds nothing to what the
--      person could reach before;
--   3. the sources of the administrator's action log are append-only for every
--      runtime role;
--   4. nobody grants themselves a position, a mentorship, a consent or a seat;
--   5. the administrator, teacher and student of another institution reach
--      nothing of fak-a.
-- Rule 2 (problem reports by kind) is 232-problem-report-routing. The service
-- roles (ductus_worker, ductus_retention, ductus_auth, ductus_evidence) are
-- denied the note, key and seen tables and functions in 237, 242 and 243; this
-- file probes the web role with each person's session. Personas of
-- institution.inc, evidence-acceptance.inc and mentorship.inc, all invented:
-- Dora (a student of K1, Dora's ended ms2) is appointed network engineer here;
-- Nina is an unconfirmed teacher mentoring Boris (ms3); Lea, Petra and Tomo are
-- of fak-b; anon has no session, unknown a token of nobody, expired Ana's old one.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT no_plan();

CREATE FUNCTION pg_temp.mdoc() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
   WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')
$$;
CREATE TEMP TABLE stranger (name text PRIMARY KEY);
INSERT INTO stranger VALUES ('dora'), ('lea'), ('petra'), ('tomo'), ('nina'), ('boris');
CREATE TEMP TABLE nobody (name text PRIMARY KEY);
INSERT INTO nobody VALUES ('anon'), ('unknown'), ('expired');

-- Setup. Ana opens her mentored work zm1, Iva appoints Dora network engineer.
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 6),
  'opened', 'Ana opens her mentored work');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({dora})::text'), 'true', 'Iva appoints Dora network engineer');
-- Ana keeps her wrapped note key and seals a note on the work.
SELECT is(pg_temp.ask('ana', $$ SELECT version::text FROM collaboration.put_self_note_key('00000000-0000-4000-8000-0000000005a1', NULL, 600000,
    decode(repeat('01', 16), 'hex'), decode(repeat('02', 12), 'hex'), decode(repeat('03', 48), 'hex'),
    decode(repeat('04', 16), 'hex'), decode(repeat('05', 12), 'hex'), decode(repeat('06', 48), 'hex')) $$), '1',
  'Ana keeps her wrapped note key');
SELECT is(pg_temp.ask('ana', format($$ SELECT count(*)::text FROM collaboration.set_work_sealed_self_note(%L, '00000000-0000-4000-8000-0000000005a1',
    decode(repeat('a1', 12), 'hex'), decode(repeat('a1', 1296), 'hex')) $$, pg_temp.mdoc())), '1',
  'Ana seals a note on her work');
-- The faculty publishes a form for master theses and Ana submits it; her
-- mentor Marko gives his consent.
SELECT is(pg_temp.ask('iva', $$ SELECT code FROM app.publish_thesis_form('prijava-teme', 'Prijava teme', '{master_thesis}'::text[], true) $$),
  'prijava-teme', 'Iva publishes the topic application form');
SELECT is(pg_temp.ask('ana', format($$ SELECT state FROM app.set_work_thesis_form_state(%L, 'prijava-teme', 'submitted') $$, pg_temp.mdoc())),
  'submitted', 'Ana submits the form');
SELECT is(pg_temp.ask('marko', format('SELECT state FROM app.set_work_mentor_consent(%L, true, NULL)', pg_temp.mdoc())),
  'given', 'Marko, her mentor, gives his consent on the work');
-- A consultation: Ana asks for a slot; Marko records a meeting on revision 1
-- of the work and adds an agreed task.
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
  SELECT d.id, d.institution_id, 1, 0, d.principal_id, d.current_content_hash FROM evidence.document d WHERE d.id = pg_temp.mdoc();
RESET ROLE;
INSERT INTO ref SELECT 'slot', pg_temp.ask('ana', format($$ SELECT institution.request_consultation_slot_detail(%L,
  now() + interval '3 days', 'Struktura poglavlja', 'Izmišljena priprema.', 1, 0) $$, pg_temp.mdoc()));
INSERT INTO ref SELECT 'rec', pg_temp.ask('marko', format($$ SELECT collaboration.create_consultation_record(%L, '2026-11-20', 1,
  'Prvi sastanak', 'Izmišljeni dogovor.') $$, pg_temp.mdoc()));
INSERT INTO ref SELECT 'task', pg_temp.ask('marko', format($$ SELECT collaboration.add_consultation_task(%L, {rec}, 'Dopuniti popis izvora') $$,
  pg_temp.mdoc()));
SELECT matches(val, '^[0-9a-f-]{36}$', 'the setup made ' || name) FROM ref WHERE name IN ('slot', 'rec', 'task') ORDER BY name;
-- A message each way, each opened by the other side.
INSERT INTO ref SELECT 'msg_m', pg_temp.ask('marko', format($$ SELECT message_id FROM collaboration.create_work_message(%L, 'Pogledat ću do petka.') $$,
  pg_temp.mdoc()));
INSERT INTO ref SELECT 'msg_a', pg_temp.ask('ana', format($$ SELECT message_id FROM collaboration.create_work_message(%L, 'Poslala sam nacrt.') $$,
  pg_temp.mdoc()));
SELECT is(pg_temp.ask('ana', format($$ SELECT string_agg(item_kind, ',') FROM collaboration.mark_work_items_seen(%L, ARRAY['message'], ARRAY[{msg_m}]::uuid[]) $$,
  pg_temp.mdoc())), 'message', 'Ana opens Marko''s message');
SELECT is(pg_temp.ask('marko', format($$ SELECT string_agg(item_kind, ',') FROM collaboration.mark_work_items_seen(%L, ARRAY['message'], ARRAY[{msg_a}]::uuid[]) $$,
  pg_temp.mdoc())), 'message', 'Marko opens Ana''s message');
-- Vesna opens a mentorship for Boris, so Boris holds one mentorship notice.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
INSERT INTO ref SELECT 'mo', pg_temp.ask('vesna', $$ SELECT app.open_mentorship({boris}, 'bachelor_thesis', NULL) $$);
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
INSERT INTO ref SELECT 'notice', id::text FROM institution.notification WHERE kind = 'mentorship_opened';
SELECT matches(val, '^[0-9a-f-]{36}$', 'the setup made ' || name) FROM ref WHERE name IN ('mo', 'notice') ORDER BY name;
-- Vesna, the teacher of K1, asks a declaration question on z1.
SELECT is(pg_temp.ask('vesna', $$ SELECT question_text FROM institution.set_declaration_question({z1}, 'Koji ti je izvor najviše pomogao?') $$),
  'Koji ti je izvor najviše pomogao?', 'Vesna asks a declaration question on z1');

-- 1 and 5. The reads of one work, each with the exact answer of the owner (Ana)
-- and of her mentor (Marko), and the exact error of everyone else. Iva reads
-- the faculty's part (forms, consent, stage) by her office, which 234 covers;
-- here she is probed only where the work is not the faculty's to read.
CREATE TEMP TABLE probe (rpc text PRIMARY KEY, sql text, ana text, marko text, stranger text);
INSERT INTO probe VALUES
  ('get_work_self_note', 'SELECT count(*)::text FROM collaboration.get_work_self_note(%L)',
   '1', 'ZD403: forbidden', 'ZD403: forbidden'),
  ('list_work_items_seen_by_student', 'SELECT count(*)::text FROM collaboration.list_work_items_seen_by_student(%L)',
   '0', '1', 'ZD403: forbidden'),
  ('list_consultation_tasks', 'SELECT count(*)::text FROM collaboration.list_consultation_tasks(%L)',
   '1', '1', 'ZD403: forbidden'),
  ('consultation_slots', 'SELECT count(*)::text FROM institution.consultation_slots(%L)',
   '1', '1', 'ZD403: forbidden'),
  ('consultation_slot_details', 'SELECT topic FROM institution.consultation_slot_details(%L)',
   'Struktura poglavlja', 'Struktura poglavlja', 'ZD403: forbidden'),
  ('read_work_thesis_forms', 'SELECT string_agg(code || '':'' || state, '','') FROM app.read_work_thesis_forms(%L)',
   'prijava-teme:submitted', 'prijava-teme:submitted', 'ZD404: not found'),
  ('read_work_mentor_consent', 'SELECT state FROM app.read_work_mentor_consent(%L)',
   'given', 'given', 'ZD404: not found'),
  ('read_work_mentor_consent_events', 'SELECT string_agg(given::text, '','') FROM app.read_work_mentor_consent_events(%L)',
   'true', 'true', 'ZD404: not found'),
  ('read_work_thesis_stage', 'SELECT stage FROM app.read_work_thesis_stage(%L)',
   'none', 'none', 'ZD404: not found');
-- The seen list is the mentor's view of what Ana opened of his; Ana's own
-- call answers without error and lists none, as 237 tests.
SELECT is(pg_temp.ask('ana', format(sql, pg_temp.mdoc())), ana, 'Ana reads her own work through ' || rpc) FROM probe ORDER BY rpc;
SELECT is(pg_temp.ask('marko', format(sql, pg_temp.mdoc())), marko, 'Marko through ' || rpc || ' reads ' || marko) FROM probe ORDER BY rpc;
SELECT is(pg_temp.ask(s.name, format(p.sql, pg_temp.mdoc())), p.stranger, s.name || ' reaches nothing through ' || p.rpc)
  FROM probe p CROSS JOIN stranger s ORDER BY p.rpc, s.name;
SELECT is(pg_temp.ask('iva', format(p.sql, pg_temp.mdoc())), 'ZD403: forbidden', 'the administrator reaches nothing through ' || p.rpc)
  FROM probe p WHERE p.rpc IN ('get_work_self_note', 'list_work_items_seen_by_student', 'list_consultation_tasks',
                               'consultation_slots', 'consultation_slot_details') ORDER BY p.rpc;
SELECT is(pg_temp.ask(n.name, format(p.sql, pg_temp.mdoc())), 'ZD401: not authenticated', n.name || ' is not signed in for ' || p.rpc)
  FROM probe p CROSS JOIN nobody n ORDER BY p.rpc, n.name;

-- The writes on the work: strangers first, so the owner's call afterwards
-- shows the rows are unchanged.
CREATE TEMP TABLE wprobe (rpc text PRIMARY KEY, sql text, own text, owner_answer text, other text, other_answer text);
INSERT INTO wprobe VALUES
  ('set_work_reading_place',
   $q$SELECT count(*)::text FROM collaboration.set_work_reading_place(%L, '{"nodeId": "1f0e2d3c-4b5a-4968-8776-655443322110", "offset": 1}')$q$,
   'ana', '1', 'marko', 'ZD403: forbidden'),
  ('set_work_sealed_self_note',
   $q$SELECT count(*)::text FROM collaboration.set_work_sealed_self_note(%L, '00000000-0000-4000-8000-0000000005a1', decode(repeat('b2', 12), 'hex'), decode(repeat('b2', 1296), 'hex'))$q$,
   'ana', '1', 'marko', 'ZD403: forbidden'),
  ('clear_work_self_note', 'SELECT count(*)::text FROM collaboration.clear_work_self_note(%L, ''reading'')',
   'ana', '1', 'marko', 'ZD403: forbidden'),
  ('add_consultation_task', 'SELECT (collaboration.add_consultation_task(%L, {rec}, ''Drugi zadatak'') IS NOT NULL)::text',
   'marko', 'true', 'ana', 'ZD403: forbidden'),
  ('mark_consultation_task', 'SELECT (collaboration.mark_consultation_task(%L, {task}, true) = {task})::text',
   'marko', 'true', 'ana', 'ZD403: forbidden'),
  ('mark_work_items_seen', 'SELECT string_agg(item_kind, '','') FROM collaboration.mark_work_items_seen(%L, ARRAY[''message''], ARRAY[{msg_m}]::uuid[])',
   'ana', 'message', 'iva', 'ZD403: forbidden');
SELECT is(pg_temp.ask(s.name, format(w.sql, pg_temp.mdoc())), 'ZD403: forbidden', s.name || ' cannot write through ' || w.rpc)
  FROM wprobe w CROSS JOIN stranger s ORDER BY w.rpc, s.name;
SELECT is(pg_temp.ask(n.name, format(w.sql, pg_temp.mdoc())), 'ZD401: not authenticated', n.name || ' is not signed in for ' || w.rpc)
  FROM wprobe w CROSS JOIN nobody n ORDER BY w.rpc, n.name;
SELECT is(pg_temp.ask(other, format(sql, pg_temp.mdoc())), other_answer, other || ' has no part in ' || rpc) FROM wprobe ORDER BY rpc;
SELECT is((SELECT count(*)::integer FROM collaboration.consultation_task WHERE record_id = pg_temp.id('rec')), 1,
  'the refused calls added no task');
SELECT is((SELECT count(*)::integer FROM collaboration.work_item_seen WHERE document_id = pg_temp.mdoc()), 2,
  'the refused calls marked nothing seen');
SELECT is(pg_temp.ask(own, format(sql, pg_temp.mdoc())), owner_answer, own || ' writes through ' || rpc) FROM wprobe ORDER BY rpc;

-- The note key belongs to its person: no call reaches Ana's key by its id.
SELECT is(pg_temp.ask(s.name, $$ SELECT count(*)::text FROM collaboration.get_self_note_key() $$), '0',
  s.name || ' holds no key and reads none of Ana''s') FROM stranger s ORDER BY s.name;
SELECT is(pg_temp.ask(s.name, $$ SELECT version::text FROM collaboration.put_self_note_key('00000000-0000-4000-8000-0000000005a1', 1, 600000,
    decode(repeat('11', 16), 'hex'), decode(repeat('12', 12), 'hex'), decode(repeat('13', 48), 'hex'),
    decode(repeat('14', 16), 'hex'), decode(repeat('15', 12), 'hex'), decode(repeat('16', 48), 'hex')) $$),
  'ZD409: conflict', s.name || ' cannot overwrite Ana''s key by its id') FROM stranger s ORDER BY s.name;
SELECT is(pg_temp.ask(s.name, $$ SELECT collaboration.delete_self_note_key_checked('00000000-0000-4000-8000-0000000005a1', 1)::text $$),
  'ZD409: conflict', s.name || ' cannot delete Ana''s key by its id') FROM stranger s ORDER BY s.name;
SELECT is(pg_temp.ask(s.name, 'SELECT collaboration.delete_self_note_key()::text'), 'false',
  s.name || ' deletes only an own key, and has none') FROM stranger s ORDER BY s.name;
SELECT is(pg_temp.ask(n.name, f.sql), 'ZD401: not authenticated', n.name || ' is not signed in for ' || f.rpc)
  FROM nobody n CROSS JOIN (VALUES
    ('get_self_note_key', 'SELECT count(*)::text FROM collaboration.get_self_note_key()'),
    ('delete_self_note_key', 'SELECT collaboration.delete_self_note_key()::text'),
    ('delete_self_note_key_checked', $q$SELECT collaboration.delete_self_note_key_checked('00000000-0000-4000-8000-0000000005a1', 1)::text$q$)
  ) AS f (rpc, sql) ORDER BY f.rpc, n.name;
SELECT is(pg_temp.ask('ana', $$ SELECT key_id || '|' || version FROM collaboration.get_self_note_key() $$),
  '00000000-0000-4000-8000-0000000005a1|1', 'Ana''s key is as she left it');
SELECT is(pg_temp.ask('ana', format('SELECT count(*)::text FROM collaboration.get_work_self_note(%L)', pg_temp.mdoc())), '1',
  'and so is her sealed note');

-- The lists: the overview of the own students and the mentorship notices.
SELECT is(pg_temp.ask(t.a, $$ SELECT coalesce(string_agg(mentorship_id::text, ','), 'empty') FROM collaboration.mentor_student_overview() $$),
  t.expected, t.a || ' sees only the own students in the mentor overview')
  FROM (VALUES ('marko', '00000000-0000-4000-8000-0000000000d1'), ('vesna', pg_temp.id('mo')::text),
               ('dora', 'empty'), ('iva', 'empty'), ('lea', 'empty'), ('petra', 'empty'), ('tomo', 'empty'),
               ('nina', 'empty'), ('boris', 'empty'), ('ana', 'empty')) AS t (a, expected);
SELECT is(pg_temp.ask(t.a, $$ SELECT count(*)::text FROM app.student_mentorships() m
    WHERE m.mentorship_id = '00000000-0000-4000-8000-0000000000d1' $$), t.expected,
  t.a || ' sees Ana''s mentorship only if it is their own')
  FROM (VALUES ('ana', '1'), ('dora', '0'), ('lea', '0'), ('tomo', '0'), ('boris', '0')) AS t (a, expected);
SELECT is(pg_temp.ask('boris', $$ SELECT count(*)::text FROM institution.list_mentorship_notifications(NULL) $$), '1',
  'Boris reads his mentorship notice');
SELECT is(pg_temp.ask(t.a, $$ SELECT count(*)::text FROM institution.list_mentorship_notifications(NULL) $$), '0',
  t.a || ' reads no notice of Boris')
  FROM (VALUES ('ana'), ('marko'), ('dora'), ('iva'), ('lea'), ('petra'), ('tomo'), ('nina'), ('vesna')) AS t (a);
SELECT is(pg_temp.ask(t.a, $$ SELECT count(*)::text FROM institution.list_mentorship_notifications({notice}::uuid) $$),
  'ZD403: forbidden', t.a || ' cannot page from Boris''s notice')
  FROM (VALUES ('ana'), ('marko'), ('dora'), ('iva'), ('lea'), ('petra'), ('tomo'), ('nina'), ('vesna')) AS t (a);
SELECT is(pg_temp.ask(n.name, f.sql), 'ZD401: not authenticated', n.name || ' is not signed in for ' || f.rpc)
  FROM nobody n CROSS JOIN (VALUES
    ('mentor_student_overview', 'SELECT count(*)::text FROM collaboration.mentor_student_overview()'),
    ('student_mentorships', 'SELECT count(*)::text FROM app.student_mentorships()'),
    ('list_mentorship_notifications', 'SELECT count(*)::text FROM institution.list_mentorship_notifications(NULL)')
  ) AS f (rpc, sql) ORDER BY f.rpc, n.name;

-- The declaration answer of a student: the course teacher Vesna reads Ana's
-- (the question, no answer yet; 232 tests the answer itself); the mentor, the
-- engineer, the administrator and those of fak-b do not.
SELECT is(pg_temp.ask('vesna', format($$ SELECT coalesce(question->>'text', '-') || ' | ' || coalesce(answer->>'text', '-')
    FROM app.teacher_declaration_answer(%L, %L) $$, pg_temp.id('z1'), pg_temp.id('ana'))),
  'Koji ti je izvor najviše pomogao? | -', 'Vesna reads the declaration of Ana on z1');
SELECT is(pg_temp.ask(t.a, format('SELECT count(*)::text FROM app.teacher_declaration_answer(%L, %L)', pg_temp.id('z1'), pg_temp.id('ana'))),
  t.expected, t.a || ' reads no declaration answer of Ana')
  FROM (VALUES ('marko', 'ZD403: forbidden'), ('dora', 'ZD403: forbidden'), ('iva', 'ZD403: forbidden'), ('lea', 'ZD403: forbidden'),
               ('petra', 'ZD403: forbidden'), ('tomo', 'ZD403: forbidden'), ('nina', 'ZD403: forbidden'), ('boris', 'ZD403: forbidden'),
               ('anon', 'ZD401: not authenticated'), ('unknown', 'ZD401: not authenticated'),
               ('expired', 'ZD401: not authenticated')) AS t (a, expected);

-- 3. The sources of the action log are append-only for every runtime role.
SELECT is_empty(
  $$ SELECT r || ' ' || p || ' ' || t
     FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence',
                       'ductus_test_stranger', 'public']) AS r
     CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p
     CROSS JOIN unnest(ARRAY['audit.teacher_role_event', 'audit.institution_admin_event', 'audit.network_engineer_event',
                             'audit.faculty_rule_event', 'audit.origin_threshold_event', 'audit.declaration_question_event',
                             'institution.roster_import', 'institution.work_mentor_consent_event',
                             'institution.work_thesis_stage_event', 'institution.work_thesis_form_event']) AS t
     WHERE has_table_privilege(r, t, p) $$,
  'no runtime role updates, deletes or truncates a source of the action log or a thesis trail');

-- 4. Nobody grants themselves.
SELECT is(pg_temp.ask('dora', 'SELECT identity.appoint_network_engineer({dora})::text'), 'ZD403: forbidden',
  'the engineer cannot appoint herself again');
SELECT is(pg_temp.ask('dora', 'SELECT identity.appoint_network_engineer({ana})::text'), 'ZD403: forbidden',
  'the engineer cannot appoint anyone');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({iva})::text'), 'ZD403: forbidden',
  'the administrator cannot appoint herself engineer');
SELECT is(pg_temp.ask(a, format($$ SELECT app.open_mentorship({%s}, 'bachelor_thesis', NULL)::text $$, a)), 'ZD403: forbidden',
  a || ' cannot open a mentorship of themselves')
  FROM (VALUES ('vesna'), ('marko'), ('ana')) AS t (a);
-- The consent is the mentor's alone (Marko gave it in the setup).
SELECT is(pg_temp.ask(t.a, format('SELECT state FROM app.set_work_mentor_consent(%L, false, %L)', pg_temp.mdoc(), 'Tuđi razlog.')),
  t.expected, t.a || ' cannot change the consent on Ana''s work')
  FROM (VALUES ('ana', 'ZD403: forbidden'), ('iva', 'ZD403: forbidden'), ('dora', 'ZD404: not found'), ('vesna', 'ZD404: not found'),
               ('nina', 'ZD404: not found'), ('boris', 'ZD404: not found'), ('lea', 'ZD404: not found'), ('petra', 'ZD404: not found'),
               ('tomo', 'ZD404: not found'), ('anon', 'ZD401: not authenticated'), ('unknown', 'ZD401: not authenticated'),
               ('expired', 'ZD401: not authenticated')) AS t (a, expected);
SELECT is(pg_temp.ask('ana', format('SELECT state || ''|'' || coalesce(comment, ''-'') FROM app.read_work_mentor_consent(%L)', pg_temp.mdoc())),
  'given|-', 'the consent stays as Marko gave it');
-- The administrator seats neither herself nor the engineer through a roster.
SELECT is(pg_temp.ask('iva', format(
  $$ SELECT (institution.preview_roster_import(%L, 'merlin',
     '[{"identifier": "iva@fak-a.example", "givenName": "Iva", "familyName": "Izmišljena"},
       {"identifier": "dora@fak-a.example", "givenName": "Dora", "familyName": "Izmišljena"}]'::jsonb) -> 'statuses')::text $$,
  pg_temp.id('k1'))), '["ineligible_account", "ineligible_account"]',
  'a roster preview marks the administrator herself and the engineer ineligible');

SELECT * FROM finish();
ROLLBACK;
