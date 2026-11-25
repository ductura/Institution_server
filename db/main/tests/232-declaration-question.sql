-- SRV-IZJAVA-PITANJE (owner decision of 23. 11. 2026, NF-5 question 3): the
-- teacher of an assignment asks one optional question with the declaration;
-- the student answers it with a draft or a confirmed version. The answer is
-- bound to that version, so it is stale or bound as the declaration is; it
-- never blocks a submission. Only the owner writes an answer; the owner, the
-- teacher of the assignment and the mentor read it (C-23). Synthetic people,
-- documents and texts only; each case is rolled back.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT plan(80);

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL
);
GRANT SELECT ON demo_conversation TO ductus_evidence;

-- Only this test transaction replaces the M9.5 source (as 209 and 228).
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id, c.reason, c.required_through_seq, c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a'
$$;

CREATE FUNCTION pg_temp.body(p_base int, p_confirm boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('baseVersion',p_base,'revision',1,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(
      '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}')),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','not_used','attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb))
$$;
CREATE FUNCTION pg_temp.answer(p_actor text, p_base int, p_confirm boolean, p_answer jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.save_statement_answer({z1}, %L::jsonb, %L, %L::jsonb)',
    pg_temp.body(p_base, p_confirm),
    '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}',
    p_answer))::jsonb
$$;
CREATE FUNCTION pg_temp.ask_q(p_actor text, p_value text, p_assignment text DEFAULT 'z1') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(question_text, ''-'') FROM institution.set_declaration_question(%L, %s)',
    pg_temp.id(p_assignment), p_value))
$$;
CREATE FUNCTION pg_temp.setting(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, 'SELECT coalesce(question_text, ''-'') || '' '' || (changed_at IS NOT NULL)::text
    FROM institution.declaration_question_setting({z1})')
$$;
CREATE FUNCTION pg_temp.events() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(coalesce(e.question_text, '-') || ' ' || (e.actor_id = pg_temp.id('vesna'))::text, ', '
                    ORDER BY e.seq), '')
    FROM audit.declaration_question_event e WHERE e.assignment_id = pg_temp.id('z1')
$$;
CREATE FUNCTION pg_temp.question_id() RETURNS text LANGUAGE sql AS $$
  SELECT e.id::text FROM audit.declaration_question_event e
   WHERE e.assignment_id = pg_temp.id('z1') ORDER BY e.seq DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.read(p_actor text, p_path text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.read_statement({z1}) #>> %L', p_path))
$$;
CREATE FUNCTION pg_temp.teacher(p_actor text, p_student text, p_assignment text DEFAULT 'z1') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT coalesce(question->>''text'', ''-'') || '' | '' || coalesce(answer->>''text'', ''-'')
       FROM app.teacher_declaration_answer(%L, %L)', pg_temp.id(p_assignment), pg_temp.id(p_student)))
$$;
-- The raw answer a teacher reads: NULL as the word, so an object of nulls is told apart.
CREATE FUNCTION pg_temp.teacher_answer(p_actor text, p_student text, p_assignment text DEFAULT 'z1') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT coalesce(answer::text, ''NULL'') FROM app.teacher_declaration_answer(%L, %L)',
    pg_temp.id(p_assignment), pg_temp.id(p_student)))
$$;
CREATE FUNCTION pg_temp.submit() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, %s)', 'doc-a', 1))
$$;
CREATE FUNCTION pg_temp.record() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L, %L)', q.id, q.content_hash))
    FROM evidence.submission_request q WHERE q.document_id = 'doc-a'
$$;
CREATE FUNCTION pg_temp.openings() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM audit.access_log l WHERE l.surface = 'declaration' AND l.assignment_id = pg_temp.id('z1')
$$;

-- 1. The question: off by default, only the teacher of the assignment sets it.
SELECT is(pg_temp.read('ana', '{statement,teacherQuestion}'), NULL, 'no assignment has a question by default');
SELECT is(pg_temp.setting('vesna'), '- false', 'the teacher reads no question, never changed');
SELECT is(pg_temp.ask_q('ana', quote_literal('Pitanje?')), 'ZD403: forbidden', 'a student cannot ask it');
SELECT is(pg_temp.ask_q('dora', quote_literal('Pitanje?')), 'ZD403: forbidden', 'a classmate cannot ask it');
SELECT is(pg_temp.ask_q('marko', quote_literal('Pitanje?')), 'ZD403: forbidden', 'a teacher of another course cannot');
SELECT is(pg_temp.ask_q('iva', quote_literal('Pitanje?')), 'ZD403: forbidden', 'the administrator cannot');
SELECT is(pg_temp.ask_q('nina', quote_literal('Pitanje?')), 'ZD403: forbidden', 'an unconfirmed teacher cannot');
SELECT is(pg_temp.ask_q('petra', quote_literal('Pitanje?')), 'ZD403: forbidden', 'a teacher of another faculty cannot');
SELECT is(pg_temp.ask_q('anon', quote_literal('Pitanje?')), 'ZD401: not authenticated', 'without a session nothing');
SELECT is(pg_temp.setting('ana'), 'ZD403: forbidden', 'a student cannot read the teacher''s setting');
SELECT is(pg_temp.setting('marko'), 'ZD403: forbidden', 'another teacher cannot read it');
SELECT is(pg_temp.ask_q('vesna', quote_literal(repeat('p', 501))), 'ZD422: invalid input', 'over 500 code points is invalid');
SELECT is(pg_temp.ask_q('vesna', quote_literal(repeat('ž', 500))), repeat('ž', 500), '500 code points are accepted');
SELECT is(pg_temp.ask_q('vesna', quote_literal(' Pitanje')), 'ZD422: invalid input', 'a leading space is invalid');
SELECT is(pg_temp.ask_q('vesna', quote_literal('')), 'ZD422: invalid input', 'an empty question is invalid');
SELECT is(pg_temp.ask_q('vesna', quote_literal('Pi' || chr(7) || 'tanje')), 'ZD422: invalid input',
  'a control character is invalid');
SELECT is(pg_temp.ask_q('vesna', quote_literal('Koji ti je izvor najviše pomogao?')),
  'Koji ti je izvor najviše pomogao?', 'the teacher asks the question');
SELECT is(pg_temp.ask_q('vesna', quote_literal('Koji ti je izvor najviše pomogao?')),
  'Koji ti je izvor najviše pomogao?', 'asking the same question again changes nothing');
SELECT is(pg_temp.events(), repeat('ž', 500) || ' true, Koji ti je izvor najviše pomogao? true',
  'each change is one audit row with its author');
SELECT is(pg_temp.setting('vesna'), 'Koji ti je izvor najviše pomogao? true', 'the teacher reads it with its time');
SELECT is(pg_temp.read('ana', '{statement,teacherQuestion,text}'), 'Koji ti je izvor najviše pomogao?',
  'the student reads the question');
SELECT is(pg_temp.read('ana', '{statement,teacherQuestion,questionId}'), pg_temp.question_id(),
  'with the id of its version');
SELECT is(pg_temp.ask_q('marko', quote_literal('Mentorsko pitanje?'), 'zm1'), 'Mentorsko pitanje?',
  'the mentor asks the question of the mentored work');
SELECT throws_ok($$ UPDATE audit.declaration_question_event SET question_text = 'x' $$,
  'ZD403', 'append-only row', 'an audit row cannot be changed');
SELECT throws_ok($$ DELETE FROM audit.declaration_question_event $$,
  'ZD403', 'append-only row', 'an audit row cannot be deleted');
SELECT ok(NOT has_function_privilege('ductus_app', 'app.assignment_declaration_question(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('ductus_app', 'app.declaration_question_text(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('ductus_evidence', 'app.assignment_declaration_question(uuid)', 'EXECUTE')
  AND has_function_privilege('ductus_evidence', 'app.declaration_question_text(uuid,uuid)', 'EXECUTE'),
  'only the evidence role executes the question bridges');

SELECT is(pg_temp.call('ana','pkg-a','req-declaration-question',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture commits revision 1');

-- 2. The answer with a draft.
SAVEPOINT draft;
SELECT is(pg_temp.answer('ana', 0, false, jsonb_build_object('questionId', pg_temp.question_id(), 'text', 'Udžbenik.'))
  #>> '{statement,questionAnswer,text}', 'Udžbenik.', 'the student answers with a draft');
SELECT is(pg_temp.read('ana', '{statement,state}'), 'draft', 'the declaration is a draft');
SELECT is(pg_temp.read('ana', '{statement,questionAnswer,questionText}'), 'Koji ti je izvor najviše pomogao?',
  'the answer names the question it answers');
SELECT is(pg_temp.answer('ana', 1, false, NULL) #>> '{statement,questionAnswer}', NULL,
  'a new draft without an answer has none');
SELECT is((SELECT count(*) FROM declaration.question_answer), 0::bigint, 'the replaced draft''s answer went with it');
SELECT is((pg_temp.answer('ana', 2, false, '"x"'::jsonb))::text, '{"status": "invalid_input"}',
  'an answer that is not an object is invalid');
SELECT is((pg_temp.answer('ana', 2, false, jsonb_build_object('questionId', pg_temp.question_id(),
  'text', repeat('o', 2001))))::text, '{"status": "invalid_input"}', 'over 2000 code points is invalid');
SELECT is((pg_temp.answer('ana', 2, false, jsonb_build_object('questionId', pg_temp.question_id(),
  'text', 'a', 'extra', 1)))::text, '{"status": "invalid_input"}', 'an unknown key is invalid');
SELECT is((pg_temp.answer('ana', 2, false, jsonb_build_object('questionId', pg_temp.id('zm1'),
  'text', 'a')))::text, '{"status": "invalid_input"}', 'an id that is no question of the assignment is invalid');
SELECT is((pg_temp.answer('ana', 2, false, jsonb_build_object('questionId',
  (SELECT e.id FROM audit.declaration_question_event e WHERE e.assignment_id = pg_temp.id('zm1')),
  'text', 'a')))::text, '{"status": "invalid_input"}', 'the question of another assignment is invalid');
SELECT is(pg_temp.read('ana', '{statement,version}'), '2', 'no refused answer wrote a statement row');
SELECT is((pg_temp.answer('dora', 0, false, jsonb_build_object('questionId', pg_temp.question_id(),
  'text', 'a')))::text, '{"status": "not_found"}', 'a classmate without a document cannot save anything');
SELECT is(pg_temp.answer('ana', 2, false, jsonb_build_object('questionId', pg_temp.question_id(),
  'text', repeat('ž', 2000))) #>> '{statement,questionAnswer,text}', repeat('ž', 2000),
  '2000 code points are accepted');
SELECT is(pg_temp.read('dora', '{statement,questionAnswer}'), NULL, 'a classmate reads nothing of the answer');
SELECT is(pg_temp.ask_q('vesna', quote_literal('Novo pitanje?')), 'Novo pitanje?', 'the teacher changes the question');
SELECT is(pg_temp.read('ana', '{statement,questionAnswer,questionText}'), 'Koji ti je izvor najviše pomogao?',
  'the saved answer keeps the question it answered');
SELECT is(pg_temp.read('ana', '{statement,teacherQuestion,text}'), 'Novo pitanje?', 'the student reads the new one');
SELECT is(pg_temp.ask_q('vesna', 'NULL'), '-', 'the teacher removes the question');
SELECT is(pg_temp.read('ana', '{statement,teacherQuestion}'), NULL, 'no question is in force');
ROLLBACK TO SAVEPOINT draft;

-- 3. The answer of a confirmed version, stale as the declaration, never changed.
SAVEPOINT confirmed;
SELECT is(pg_temp.answer('ana', 0, true, jsonb_build_object('questionId', pg_temp.question_id(), 'text', 'Članak.'))
  #>> '{statement,state}', 'confirmed', 'the student confirms with an answer');
SELECT throws_ok($$ UPDATE declaration.question_answer SET answer_text = 'x' $$,
  'ZD403', 'append-only row', 'the answer of a confirmed version cannot be changed');
SELECT throws_ok($$ DELETE FROM declaration.question_answer $$,
  'ZD403', 'append-only row', 'the answer of a confirmed version cannot be deleted');
INSERT INTO demo_conversation VALUES
  (pg_temp.id('ana'), pg_temp.id('ana'), 'pasted_known', 1, ARRAY[repeat('b',64)]);
SELECT is(pg_temp.read('ana', '{statement,state}'), 'stale', 'a new required conversation makes the version stale');
SELECT is(pg_temp.read('ana', '{statement,questionAnswer,text}'), 'Članak.', 'and its answer with it');
ROLLBACK TO SAVEPOINT confirmed;

-- 4. Bound to the submission; the teacher and the mentor read it, nobody else.
SAVEPOINT bound;
SELECT is(pg_temp.teacher('vesna', 'ana'), 'Koji ti je izvor najviše pomogao? | -',
  'before a submission the teacher reads the question and no answer');
SELECT is(pg_temp.openings(), 0::bigint, 'and nothing is written to the access log');
SELECT is(pg_temp.answer('ana', 0, true, jsonb_build_object('questionId', pg_temp.question_id(), 'text', 'Članak.'))
  #>> '{statement,state}', 'confirmed', 'the student confirms with an answer');
SELECT is(pg_temp.submit(), 'requested', 'an answer never blocks the request');
SELECT is(pg_temp.record(), 'recorded', 'the submission is recorded');
SELECT is(pg_temp.read('ana', '{statement,state}'), 'bound', 'the declaration is bound');
SELECT is(pg_temp.read('ana', '{statement,questionAnswer,text}'), 'Članak.', 'the student reads the bound answer');
SELECT is(pg_temp.teacher('vesna', 'ana'), 'Koji ti je izvor najviše pomogao? | Članak.',
  'the teacher of the assignment reads the bound answer');
SELECT is(pg_temp.openings(), 1::bigint, 'the read is written to the access log');
SELECT is(pg_temp.teacher('marko', 'ana'), 'ZD403: forbidden', 'a teacher of another course cannot read it');
SELECT is(pg_temp.teacher('dora', 'ana'), 'ZD403: forbidden', 'a classmate cannot read it');
SELECT is(pg_temp.teacher('ana', 'ana'), 'ZD403: forbidden', 'the teacher reader is not the student''s');
SELECT is(pg_temp.teacher('iva', 'ana'), 'ZD403: forbidden', 'the administrator cannot read it');
SELECT is(pg_temp.teacher('petra', 'ana'), 'ZD403: forbidden', 'a teacher of another faculty cannot read it');
SELECT is(pg_temp.teacher('anon', 'ana'), 'ZD401: not authenticated', 'without a session nothing');
SELECT is(pg_temp.teacher('vesna', 'tomo'), 'ZD403: forbidden', 'a student outside the course is refused');
SELECT is(pg_temp.openings(), 1::bigint, 'no refused read is written');
ROLLBACK TO SAVEPOINT bound;

-- 4b. Bound without an answer while a question is in force: the teacher reads
-- the answer as null, not as an object of nulls (INT-32, SRV-IZJAVA-ODGOVOR-NULL).
SAVEPOINT bound_unanswered;
SELECT is(pg_temp.answer('ana', 0, true, 'null'::jsonb) #>> '{statement,state}', 'confirmed',
  'the student confirms without answering the question');
SELECT is(pg_temp.submit(), 'requested', 'and requests the submission');
SELECT is(pg_temp.record(), 'recorded', 'the submission is recorded');
SELECT is(pg_temp.read('ana', '{statement,state}'), 'bound', 'the declaration is bound');
SELECT is(pg_temp.teacher_answer('vesna', 'ana'), 'NULL',
  'the teacher of the assignment reads no answer as null');
SELECT is(pg_temp.teacher('vesna', 'ana'), 'Koji ti je izvor najviše pomogao? | -',
  'and the question in force with it');
ROLLBACK TO SAVEPOINT bound_unanswered;

SELECT is(pg_temp.teacher('marko', 'ana', 'zm1'), 'Mentorsko pitanje? | -',
  'the mentor reads the question of the mentored work, no answer yet');
SELECT is(pg_temp.teacher('vesna', 'ana', 'zm1'), 'ZD403: forbidden', 'the course teacher is not the mentor');

-- 5. Without a question nobody answers and the declaration works as before.
SAVEPOINT plain;
SELECT is(pg_temp.ask_q('vesna', 'NULL'), '-', 'the teacher removes the question');
SELECT is(pg_temp.answer('ana', 0, true, 'null'::jsonb) #>> '{statement,state}', 'confirmed',
  'a declaration without an answer is confirmed');
SELECT is((pg_temp.answer('ana', 1, false, jsonb_build_object('questionId', pg_temp.question_id(),
  'text', 'a')))::text, '{"status": "invalid_input"}', 'a removal is no question to answer');
SELECT is(pg_temp.submit(), 'requested', 'and submitted');
-- No ROLLBACK TO SAVEPOINT plain here: pgTAP keeps its test counter in a table,
-- so rolling back the last section would reset it before finish() and report
-- "planned 74 ran 70" although all 74 assertions ran. The final ROLLBACK undoes it.

SELECT * FROM finish();
ROLLBACK;
