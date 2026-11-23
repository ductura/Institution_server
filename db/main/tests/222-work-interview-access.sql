-- SRV-1530 (Ductus#2052; N-14): the interview preparation of a work. The
-- teacher of the work prepares questions, invites the student and notes that
-- the interview was held; the student answers with explanations. Access comes
-- from the relation to the work; a stranger, a person of another institution
-- and a person of the wrong role are refused. Every person, course and
-- document below is invented (fixtures/institution.inc; the documents are
-- those of 162).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.domain (id, institution_id, region) VALUES
  ('00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'eu-central-1'),
  ('00000000-0000-4000-8000-0000000000d2', pg_temp.id('fak_b'), 'eu-central-1');
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')),
  ('project-b', pg_temp.id('fak_b'), pg_temp.id('z3'), pg_temp.id('tomo'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 'project-b', pg_temp.id('tomo'), repeat('c', 64));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), repeat('a', 64)),
  ('doc-b', pg_temp.id('fak_b'), 0, pg_temp.id('tomo'), repeat('c', 64));
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- 1. Catalogue: the tables, their RLS and who may call what.
SELECT table_owner_is('institution', t, 'ductus_identity', t || ' is owned by the owner role')
FROM unnest(ARRAY['work_interview', 'work_interview_question', 'work_interview_explanation']) t;
SELECT table_owner_is('audit', 'work_interview_event', 'ductus_identity', 'the trail is owned by the owner role');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = (t.s || '.' || t.n)::regclass),
  t.n || ': ENABLE and FORCE ROW LEVEL SECURITY')
FROM (VALUES ('institution', 'work_interview'), ('institution', 'work_interview_question'),
             ('institution', 'work_interview_explanation'), ('audit', 'work_interview_event')) AS t (s, n);
SELECT bag_eq(
  $$ SELECT tablename || ': ' || policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') FROM pg_policies
      WHERE tablename LIKE 'work\_interview%' $$,
  ARRAY['work_interview: work_interview_owner ALL to ductus_identity',
        'work_interview_question: work_interview_question_owner ALL to ductus_identity',
        'work_interview_explanation: work_interview_explanation_owner ALL to ductus_identity',
        'work_interview_note: work_interview_note_owner ALL to ductus_identity',
        'work_interview_event: work_interview_event_owner ALL to ductus_identity'],
  'only the owner''s policies: no role reads or writes the tables but through the RPCs');
SELECT is_empty(
  $$ SELECT r.rolname || ' may use ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_identity', 'ductus_app')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['institution.work_interview_get(text)',
                             'institution.add_work_interview_question(text,text,text)',
                             'institution.remove_work_interview_question(text,uuid)',
                             'institution.invite_work_interview(text)',
                             'institution.set_work_interview_appointment(text,uuid,text,timestamptz)',
                             'institution.mark_work_interview_held(text,date)',
                             'institution.add_work_interview_explanation(text,uuid,text)',
                             'institution.work_interview_context(text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role and the owner execute the RPCs');
SELECT is_empty(
  $$ SELECT r || ' ' || t FROM unnest(ARRAY['ductus_app', 'public']) r
     CROSS JOIN unnest(ARRAY['institution.work_interview', 'institution.work_interview_question',
                             'institution.work_interview_explanation', 'audit.work_interview_event']) t
      WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE') $$,
  'the web role has no privilege on the tables');
SELECT is_empty(
  $$ SELECT column_name FROM information_schema.columns
      WHERE table_schema IN ('institution', 'audit') AND table_name LIKE 'work\_interview%'
        AND column_name ~* '(outcome|grade|score|sanction|suspicion|verdict)' $$,
  'no column holds an outcome, a grade, a sanction or a suspicion');

-- 2. Questions: only the teacher of the work writes them.
INSERT INTO ref SELECT 'q1', (pg_temp.ask('vesna',
  $$ SELECT (institution.add_work_interview_question('doc-a', 'odlomak-1', 'Kako si došla do ovog zaključka?'))->>'id' $$));
SELECT matches((SELECT val FROM ref WHERE name = 'q1'), '^[0-9a-f-]{36}$', 'Vesna adds a question about a paragraph');
INSERT INTO ref SELECT 'q2', (pg_temp.ask('vesna',
  $$ SELECT (institution.add_work_interview_question('doc-a', NULL, 'Što bi promijenila u radu?'))->>'id' $$));
SELECT matches((SELECT val FROM ref WHERE name = 'q2'), '^[0-9a-f-]{36}$', 'Vesna adds a general question');
SELECT is(pg_temp.ask(a.name, $$ SELECT institution.add_work_interview_question('doc-a', NULL, 'Pitanje?') $$),
  'ZD403: forbidden', a.name || ' cannot add a question to Ana''s work')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_question('doc-nema', NULL, 'Pitanje?') $$),
  'ZD403: forbidden', 'a missing work reads as a forbidden one');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_question('doc-b', NULL, 'Pitanje?') $$),
  'ZD403: forbidden', 'a work of another institution reads as a forbidden one');
SELECT matches(pg_temp.ask(t.name, $$ SELECT institution.add_work_interview_question('doc-a', NULL, 'Pitanje?') $$),
  '^ZD401', 'a question with session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_question('doc-a', NULL, '   ') $$),
  'ZD422: invalid input', 'a blank question is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_question('doc-a', NULL, NULL) $$),
  'ZD422: invalid input', 'no question text is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_question('doc-a', '', 'Pitanje?') $$),
  'ZD422: invalid input', 'an empty paragraph reference is refused');

-- 3. A draft is read by its author only; the student reads nothing before the invitation.
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.work_interview_get('doc-a')->'questions') $$), '2',
  'the author reads her draft');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.work_interview_get('doc-a') $$), 'ZD403: forbidden',
  'the student reads nothing before the invitation');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_explanation('doc-a', NULL, 'Objašnjenje.') $$),
  'ZD403: forbidden', 'the student cannot explain before the invitation');
SELECT is(pg_temp.ask(a.name, $$ SELECT institution.work_interview_get('doc-a') $$), 'ZD403: forbidden',
  a.name || ' reads no interview of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT matches(pg_temp.ask('anon', $$ SELECT institution.work_interview_get('doc-a') $$), '^ZD401', 'no session reads no interview');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.work_interview_get('doc-b') $$), 'ZD403: forbidden',
  'a teacher reads no interview of another institution''s work');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.invite_work_interview('doc-b') $$), 'ZD403: forbidden',
  'a teacher invites no student of another institution');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.invite_work_interview('doc-a') $$), 'ZD403: forbidden',
  'the student does not invite herself');

-- 4. A draft older than the limit is no longer read and goes with the next write.
UPDATE institution.work_interview_question SET created_at = statement_timestamp() - interval '31 days'
 WHERE id = pg_temp.id('q2');
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.work_interview_get('doc-a')->'questions') $$), '1',
  'a draft question older than 30 days is no longer read');
INSERT INTO ref SELECT 'q3', (pg_temp.ask('vesna',
  $$ SELECT (institution.add_work_interview_question('doc-a', NULL, 'Koje izvore bi dodala?'))->>'id' $$));
SELECT is((SELECT count(*)::text FROM institution.work_interview_question WHERE id = pg_temp.id('q2')), '0',
  'the next write deletes the expired draft question');

-- 5. Removing a question: its author before the invitation, nobody else.
SELECT is(pg_temp.ask('ana', $$ SELECT institution.remove_work_interview_question('doc-a', {q1}) $$),
  'ZD403: forbidden', 'the student cannot remove a question');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.remove_work_interview_question('doc-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') $$),
  'ZD403: forbidden', 'an unknown question reads as a forbidden one');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.remove_work_interview_question('doc-a', {q3}) $$), '',
  'the author removes her question');
SELECT is(pg_temp.ask('vesna', $$ SELECT jsonb_array_length(institution.work_interview_get('doc-a')->'questions') $$), '1',
  'one question is left');

-- 6. The invitation: the questions become visible to the student from then on.
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', current_date) $$),
  'ZD409: not allowed', 'an interview not yet invited cannot be held');
SELECT matches(pg_temp.ask('vesna', $$ SELECT institution.invite_work_interview('doc-a')->>'invitedAt' $$), '^20',
  'Vesna invites the student');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.invite_work_interview('doc-a') $$), 'ZD409: not allowed',
  'a second invitation is refused');
SELECT is(pg_temp.ask('ana', $$ SELECT jsonb_array_length(institution.work_interview_get('doc-a')->'questions') $$), '1',
  'the student reads the same question the teacher does');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.work_interview_get('doc-a')->'questions' $$),
  pg_temp.ask('ana', $$ SELECT jsonb_set(institution.work_interview_get('doc-a')->'questions', '{0,mine}', 'true') $$),
  'what the teacher side sees, the student sees (only "mine" differs by the reader)');
SELECT is((SELECT string_agg(kind, ',' ORDER BY occurred_at) FROM audit.work_interview_event), 'invited',
  'the invitation is on the trail');

-- 7. Explanations: the student only, after the invitation.
SELECT matches(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_explanation('doc-a', pg_temp.id('q1'), 'Evo kako sam radila.')->>'id' $$),
  '^[0-9a-f-]{36}$', 'Ana explains one question');
SELECT matches(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_explanation('doc-a', NULL, 'Opće objašnjenje.')->>'id' $$),
  '^[0-9a-f-]{36}$', 'Ana adds a general explanation');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.add_work_interview_explanation('doc-a', NULL, 'Tekst.') $$),
  'ZD403: forbidden', 'the teacher writes no explanation');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_explanation('doc-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Tekst.') $$),
  'ZD403: forbidden', 'an explanation of an unknown question reads as a forbidden one');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.add_work_interview_explanation('doc-a', NULL, '') $$),
  'ZD422: invalid input', 'an empty explanation is refused');
SELECT is(pg_temp.ask(a.name, $$ SELECT institution.add_work_interview_explanation('doc-a', NULL, 'Tekst.') $$),
  'ZD403: forbidden', a.name || ' cannot explain on Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);
SELECT is(pg_temp.ask(a.name, $$ SELECT jsonb_array_length(institution.work_interview_get('doc-a')->'explanations') $$), '2',
  a.name || ' reads the two explanations')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

-- 8. The appointment: a consultation slot, or a free place and time.
INSERT INTO ref SELECT 's1', pg_temp.ask('ana',
  $$ SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days') $$);
SELECT is(pg_temp.ask('ana', $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, 'Ured 12', now() + interval '2 days') $$),
  'ZD403: forbidden', 'the student chooses no free place and time');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, 'Ured 12', now() - interval '2 days') $$),
  'ZD422: invalid input', 'a time in the past is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', {s1}, 'Ured 12', now() + interval '2 days') $$),
  'ZD422: invalid input', 'a slot and a place together are refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, NULL, NULL) $$),
  'ZD422: invalid input', 'no appointment is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', NULL, NULL) $$),
  'ZD403: forbidden', 'an unknown slot reads as a forbidden one');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, 'Ured 12', now() + interval '2 days')->'appointment'->>'place' $$),
  'Ured 12', 'the teacher sets a place and a time');
SELECT is(pg_temp.ask('ana', $$ SELECT institution.set_work_interview_appointment('doc-a', {s1}, NULL, NULL)->'appointment'->>'consultationSlotId' $$),
  (SELECT val FROM ref WHERE name = 's1'), 'the student chooses a consultation slot of her work');
SELECT is(pg_temp.ask('ana', $$ SELECT coalesce(institution.work_interview_get('doc-a')->'appointment'->>'place', 'none') $$), 'none',
  'the slot replaced the free place');
SELECT is(pg_temp.ask(a.name, $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, 'Ured 12', now() + interval '2 days') $$),
  'ZD403: forbidden', a.name || ' sets no appointment on Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('iva'), ('boris'), ('nina'), ('tomo'), ('petra'), ('lea')) AS a (name);

-- 9. Held: the teacher only, a date not in the future, once.
SELECT is(pg_temp.ask('ana', $$ SELECT institution.mark_work_interview_held('doc-a', current_date) $$),
  'ZD403: forbidden', 'the student does not mark the interview held');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', current_date + 1) $$),
  'ZD422: invalid input', 'a date in the future is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', NULL) $$),
  'ZD422: invalid input', 'no date is refused');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', current_date)->>'heldOn' $$),
  to_char(current_date, 'YYYY-MM-DD'), 'Vesna marks the interview held');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.mark_work_interview_held('doc-a', current_date) $$),
  'ZD409: not allowed', 'a held interview is not held again');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.set_work_interview_appointment('doc-a', NULL, 'Ured 13', now() + interval '2 days') $$),
  'ZD409: not allowed', 'a held interview takes no new appointment');
SELECT is((SELECT string_agg(kind, ',' ORDER BY kind) FROM audit.work_interview_event), 'held,invited,scheduled,scheduled',
  'the invitation, both appointments and the interview held are on the trail');
SELECT throws_ok($$ UPDATE audit.work_interview_event SET kind = 'held' $$, NULL, NULL, 'the trail is append-only');

-- 10. The row takes its scope from the work.
SELECT row_eq(
  $$ SELECT institution_id, document_id, assignment_id, student_id, created_by FROM institution.work_interview WHERE document_id = 'doc-a' $$,
  ROW(pg_temp.id('fak_a'), 'doc-a'::text, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.id('vesna')),
  'the interview takes its scope from the work and its author from the session');

SELECT * FROM finish();
ROLLBACK;
