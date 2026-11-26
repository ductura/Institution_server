-- F4-NAS-R04-SRV (D-41, declaration-v1 section 8): the course teacher reads a
-- conversation attached to the declaration bound to the live submission, up to
-- its throughSeq, through app.teacher_declaration_conversation. Nobody else
-- reads it, a conversation the declaration does not attach is the same refusal
-- as an unknown one, and a refusal writes nothing. All people and texts are the
-- invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.signing_key
  (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
VALUES ('key-a', '1', '00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'receipt', 'Ed25519',
  'MCowBQYDK2VwAyEA' || translate(rtrim(encode(decode(repeat('11', 32), 'hex'), 'base64'), '='), '+/', '-_'),
  date_trunc('minute', now()) - interval '1 day');
RESET ROLE;

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('f4nasr04-' || p_name), 1, 12))::uuid
$$;

-- Ana's attached conversation (two messages shown, a third written afterwards),
-- one she did not attach, and Dora's.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_n'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_d'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-0000000018e1', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved'),
  (pg_temp.u('r2'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_n'),
   '00000000-0000-4000-8000-0000000018e2', pg_temp.sha('r2'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved'),
  (pg_temp.u('r3'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'), 2, pg_temp.u('conv_d'),
   '00000000-0000-4000-8000-0000000018e3', pg_temp.sha('r3'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak.', pg_temp.sha('Izmišljeni odlomak.')),
  (pg_temp.u('m4'), pg_temp.u('conv_n'), pg_temp.id('fak_a'), 1, pg_temp.u('r2'), 'student_paragraph',
   'Neprilozeni izmišljeni odlomak.', pg_temp.sha('Neprilozeni izmišljeni odlomak.')),
  (pg_temp.u('m5'), pg_temp.u('conv_d'), pg_temp.id('fak_a'), 1, pg_temp.u('r3'), 'student_paragraph',
   'Dorin izmišljeni odlomak.', pg_temp.sha('Dorin izmišljeni odlomak.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id = pg_temp.u('r1');
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u('r1');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor pomoćnika.', pg_temp.sha('Izmišljeni odgovor pomoćnika.'));
RESET ROLE;

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL,
  from_revision bigint NOT NULL DEFAULT 1
);
GRANT SELECT ON demo_conversation TO ductus_evidence;
-- Only this test transaction replaces the M9.5 source (as 209-submission-declaration).
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id, c.reason, c.required_through_seq, c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a' AND p_revision >= c.from_revision
$$;
INSERT INTO demo_conversation VALUES
  (pg_temp.u('conv_a'), pg_temp.id('ana'), 'transferred', 1,
   ARRAY[pg_temp.sha('Izmišljeni odlomak.'), pg_temp.sha('Izmišljeni odgovor pomoćnika.')]),
  (pg_temp.u('conv_n'), pg_temp.id('ana'), 'student_added', 1, ARRAY[pg_temp.sha('Neprilozeni izmišljeni odlomak.')]);

CREATE FUNCTION pg_temp.statement_form() RETURNS text LANGUAGE sql AS $$
  SELECT '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}'
$$;
CREATE FUNCTION pg_temp.statement_body() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'baseVersion', 0, 'revision', 1, 'confirm', true,
    'form', jsonb_build_object('formId','test-izjava','formVersion',1,
      'formSha256',pg_temp.sha(pg_temp.statement_form())),
    'ownWork', '{"confirmed":true}'::jsonb,
    'humanHelp', '{"received":false,"entries":[]}'::jsonb,
    'ai', jsonb_build_object('use','used','declaredTools','[]'::jsonb,'externalAttachmentIds','[]'::jsonb,
      'attachments', jsonb_build_array(jsonb_build_object('conversationId', pg_temp.u('conv_a'), 'throughSeq', 2,
        'messagesSha256', pg_temp.sha('["' || pg_temp.sha('Izmišljeni odlomak.') || '","'
                                      || pg_temp.sha('Izmišljeni odgovor pomoćnika.') || '"]')))))
$$;
-- messages and through_seq of the teacher's read; the error otherwise.
CREATE FUNCTION pg_temp.read(p_actor text, p_conversation text DEFAULT 'conv_a', p_student text DEFAULT '{ana}')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT count(*)::text || '/' || max(through_seq)::text || '/' || string_agg(role, ',' ORDER BY seq)
          FROM app.teacher_declaration_conversation({z1}, %s, %L) $q$, p_student, pg_temp.u(p_conversation)))
$$;
CREATE FUNCTION pg_temp.logged() RETURNS text LANGUAGE sql AS $$
  SELECT count(*)::text FROM audit.access_log WHERE surface = 'declaration'
$$;

-- 1. Catalogue.
SELECT is(
  (SELECT pg_get_userbyid(p.proowner) || ' ' || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig))
     FROM pg_proc p WHERE p.oid = 'app.teacher_declaration_conversation(uuid,uuid,uuid)'::regprocedure),
  'ductus_identity true true', 'owner, SECURITY DEFINER and an empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                               'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'app.teacher_declaration_conversation(uuid,uuid,uuid)', 'EXECUTE')
        AND r <> 'ductus_identity' $$,
  ARRAY['ductus_app'], 'only the app role executes it');
SELECT is(pg_get_function_arguments('app.teacher_declaration_conversation(uuid,uuid,uuid)'::regprocedure),
  'p_assignment_id uuid, p_student_id uuid, p_conversation_id uuid', 'it names no institution or reader');

-- 2. Fixture: Ana attaches conversation A and submits.
SELECT is(pg_temp.call('ana', 'pkg-a', 'req-statement', pg_temp.descriptor(), 0,
  repeat('a', 64), repeat('d', 64), repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
INSERT INTO ref SELECT 'saved', pg_temp.ask('ana', format('SELECT declaration.save_statement(%L, %L::jsonb, %L)',
  pg_temp.id('z1'), pg_temp.statement_body(), pg_temp.statement_form()));
SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
SELECT is((SELECT val::jsonb #>> '{statement,state}' FROM ref WHERE name = 'saved'), 'confirmed',
  'fixture: Ana confirms a declaration that attaches conversation A');
SELECT matches(pg_temp.read('vesna'), '^ZD403', 'before a submission there is nothing to read');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');

-- 3. A message written after the confirmation stays out of the read.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r4'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-0000000018e4', pg_temp.sha('r4'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m3'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 3, pg_temp.u('r4'), 'student_paragraph',
   'Kasniji izmišljeni odlomak.', pg_temp.sha('Kasniji izmišljeni odlomak.'));
RESET ROLE;

SELECT is(pg_temp.read('vesna'), '2/2/student_paragraph,provider_response',
  'the course teacher reads the two confirmed messages, not the third');
SELECT is(pg_temp.logged(), '1', 'the read is logged on the declaration surface');
SELECT ok(NOT (pg_temp.ask('vesna', format(
    'SELECT string_agg(content, '','') FROM app.teacher_declaration_conversation({z1}, {ana}, %L)', pg_temp.u('conv_a')))
  LIKE '%Kasniji%'), 'the later message text is not returned');

-- 4. Nobody else reads it; an unattached, another student's or unknown conversation is refused alike.
SELECT matches(pg_temp.read(a.name), '^ZD40[13]', a.name || ' does not read Ana''s attached conversation')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('tomo'), ('iva'), ('anon')) AS a (name);
SELECT matches(pg_temp.read('vesna', 'conv_n'), '^ZD403', 'a conversation of Ana that the declaration does not attach is refused');
SELECT matches(pg_temp.read('vesna', 'conv_d'), '^ZD403', 'a conversation of another student is refused');
SELECT matches(pg_temp.read('vesna', 'conv_a', '{dora}'), '^ZD403', 'Ana''s conversation under Dora is refused');
SELECT matches(pg_temp.read('vesna', 'nepoznat'), '^ZD403', 'an unknown conversation is refused');
SELECT matches(pg_temp.ask('vesna', 'SELECT count(*) FROM app.teacher_declaration_conversation({z1}, {ana}, NULL)'),
  '^ZD403', 'no conversation is refused');
SELECT is(pg_temp.logged(), '1', 'the refusals wrote nothing');

-- 5. A stored conversation that no longer hashes to what Ana confirmed is not shown.
SET LOCAL ROLE ductus_identity;
ALTER TABLE assistant.message DISABLE TRIGGER USER;
UPDATE assistant.message SET content = 'Izmijenjeni izmišljeni odlomak.', content_sha256 = pg_temp.sha('Izmijenjeni izmišljeni odlomak.')
 WHERE id = pg_temp.u('m1');
ALTER TABLE assistant.message ENABLE TRIGGER USER;
RESET ROLE;
SELECT matches(pg_temp.read('vesna'), '^ZD409', 'a changed message is a conflict, not a read');
SELECT is(pg_temp.logged(), '1', 'and nothing is logged');

-- 6. Withdrawn: the declaration is no longer the teacher's.
INSERT INTO ref SELECT 's1', id::text FROM evidence.submission;
INSERT INTO ref SELECT 'i1', pg_temp.ask('ana', $$ SELECT issuance_id::text
  FROM app.prepare_submission_receipt({s1}::uuid, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.attach_submission_receipt({i1}::uuid, %L, %L::jsonb)',
    (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance),
    jsonb_build_object('algorithm', 'Ed25519', 'keyId', 'key-a', 'keyVersion', '1',
      'signatureEncoding', 'raw', 'signatureBase64Url', repeat('A', 86))::text)),
  'attached', 'fixture: her receipt is bound');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.withdraw_submission({z1}::uuid, 'key-a', '1') $$),
  'withdrawn', 'fixture: Ana withdraws');
SELECT matches(pg_temp.read('vesna'), '^ZD403', 'a withdrawn submission attaches nothing for the teacher');

SELECT * FROM finish();
ROLLBACK;
