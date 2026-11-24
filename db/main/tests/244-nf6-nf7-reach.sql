-- INT-28 (Ductus#2055): the reach of the NF-6/NF-7 tables across roles, as one
-- matrix over what 232-242 test one feature at a time. Each row probes one
-- RPC as the web role with one person's session and pairs a refusal with the
-- same call by the person it belongs to, so a refusal never comes from a wrong
-- argument. The rules:
--   1. a network engineer reaches no work, note, consultation, form, consent
--      or declaration answer of a student; the role adds nothing to what the
--      person could reach before;
--   3. the sources of the administrator's action log are append-only for every
--      runtime role;
--   4. nobody grants themselves a position, a mentorship, a consent or a seat;
--   5. the administrator, teacher and student of another institution reach
--      nothing of fak-a.
-- Rule 2 (problem reports by kind) is 232-problem-report-routing. Personas of
-- institution.inc, evidence-acceptance.inc and mentorship.inc, all invented;
-- Dora (a student of K1, Dora's ended ms2) is appointed network engineer here.
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
-- "refused" for a refusal or an empty answer, "reached" for anything else.
CREATE FUNCTION pg_temp.reach(p_actor text, p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r IS NULL OR r IN ('0', 'empty') OR r ~ '^ZD40[34]' THEN 'refused' ELSE 'reached' END
    FROM (SELECT pg_temp.ask(p_actor, p_sql) AS r) s
$$;

-- Setup: Ana opens her mentored work zm1, Iva appoints Dora network engineer.
SELECT is(substr(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))), 1, 6),
  'opened', 'Ana opens her mentored work');
SELECT is(pg_temp.ask('iva', 'SELECT identity.appoint_network_engineer({dora})::text'), 'true', 'Iva appoints Dora network engineer');

-- 1 and 5. The reads of one work: the owner (Ana) reaches each, her mentor
-- (Marko) each but the self-note; Dora as engineer, the fak-b administrator
-- Lea, teacher Petra and student Tomo reach none.
CREATE TEMP TABLE probe (rpc text, sql text);
INSERT INTO probe VALUES
  ('get_work_self_note', 'SELECT count(*)::text FROM collaboration.get_work_self_note(%L)'),
  ('list_work_items_seen_by_student', 'SELECT count(*)::text FROM collaboration.list_work_items_seen_by_student(%L)'),
  ('list_consultation_tasks', 'SELECT count(*)::text FROM collaboration.list_consultation_tasks(%L)'),
  ('consultation_slots', 'SELECT count(*)::text FROM institution.consultation_slots(%L)'),
  ('read_work_thesis_forms', 'SELECT count(*)::text FROM app.read_work_thesis_forms(%L)'),
  ('read_work_mentor_consent', 'SELECT count(*)::text FROM app.read_work_mentor_consent(%L)'),
  ('read_work_mentor_consent_events', 'SELECT count(*)::text FROM app.read_work_mentor_consent_events(%L)'),
  ('read_work_thesis_stage', 'SELECT stage FROM app.read_work_thesis_stage(%L)');
-- An answer without an error code is reached; most lists are still empty, so
-- the mentor consent (one row) is checked by value as well.
SELECT ok(pg_temp.ask('ana', format(sql, pg_temp.mdoc())) !~ '^Z', 'Ana reaches her own work through ' || rpc)
  FROM probe;
SELECT ok(pg_temp.ask('marko', format(sql, pg_temp.mdoc())) !~ '^Z', 'Marko reaches his student''s work through ' || rpc)
  FROM probe WHERE rpc <> 'get_work_self_note';
SELECT is(pg_temp.ask(a, format('SELECT count(*)::text FROM app.read_work_mentor_consent(%L)', pg_temp.mdoc())), '1',
  a || ' reads the mentor consent of the work')
  FROM (VALUES ('ana'), ('marko')) AS t (a);
-- The self-note is the student's alone: not even her mentor reads it.
SELECT is(pg_temp.ask('marko', format('SELECT count(*)::text FROM collaboration.get_work_self_note(%L)', pg_temp.mdoc())),
  'ZD403: forbidden', 'Marko does not read Ana''s self-note');
SELECT is(pg_temp.reach(a, format(p.sql, pg_temp.mdoc())), 'refused', a || ' reaches nothing through ' || p.rpc)
  FROM probe p CROSS JOIN (VALUES ('dora'), ('lea'), ('petra'), ('tomo')) AS t (a);

-- The lists: the overview of the own students and the mentorship notices.
SELECT is(pg_temp.reach('marko', 'SELECT count(*)::text FROM collaboration.mentor_student_overview()'), 'reached',
  'Marko sees Ana in his overview');
SELECT is(pg_temp.reach(a, 'SELECT count(*)::text FROM collaboration.mentor_student_overview()'), 'refused',
  a || ' sees no student in the mentor overview')
  FROM (VALUES ('dora'), ('iva'), ('lea'), ('petra'), ('tomo')) AS t (a);
SELECT is(pg_temp.ask(a, $$ SELECT count(*)::text FROM app.student_mentorships() m
    WHERE m.mentorship_id = '00000000-0000-4000-8000-0000000000d1' $$), '0',
  a || ' does not see Ana''s mentorship among their own')
  FROM (VALUES ('dora'), ('lea'), ('tomo')) AS t (a);

-- The declaration answer of a student: the course teacher Vesna reads it,
-- Dora as engineer, the fak-b administrator and teacher do not.
SELECT is(pg_temp.reach(a, format('SELECT count(*)::text FROM app.teacher_declaration_answer(%L, %L)',
    pg_temp.id('z1'), pg_temp.id('ana'))), 'refused', a || ' reads no declaration answer of Ana')
  FROM (VALUES ('dora'), ('iva'), ('lea'), ('petra')) AS t (a);

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
SELECT is(pg_temp.reach('ana', format('SELECT count(*)::text FROM app.set_work_mentor_consent(%L, true, NULL)', pg_temp.mdoc())),
  'refused', 'the student cannot give the mentor''s consent on her own work');
SELECT is(pg_temp.reach(a, format('SELECT count(*)::text FROM app.set_work_mentor_consent(%L, true, NULL)', pg_temp.mdoc())),
  'refused', a || ' cannot give the consent on Ana''s work')
  FROM (VALUES ('dora'), ('iva'), ('vesna'), ('lea')) AS t (a);
-- The administrator seats neither herself nor the engineer through a roster.
SELECT is(pg_temp.ask('iva', format(
  $$ SELECT (institution.preview_roster_import(%L, 'merlin',
     '[{"identifier": "iva@fak-a.example", "givenName": "Iva", "familyName": "Izmišljena"},
       {"identifier": "dora@fak-a.example", "givenName": "Dora", "familyName": "Izmišljena"}]'::jsonb) -> 'statuses')::text $$,
  pg_temp.id('k1'))), '["ineligible_account", "ineligible_account"]',
  'a roster preview marks the administrator herself and the engineer ineligible');

SELECT * FROM finish();
ROLLBACK;
