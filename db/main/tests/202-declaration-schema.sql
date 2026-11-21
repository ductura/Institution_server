-- SRV-1211. Access matrix and storage rules of the declaration schema,
-- docs/contracts/declaration-v1.md section 8 (OD-1, D-41). Every person,
-- course, conversation, form and text is invented (fixtures/institution.inc).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.statement_form() RETURNS text LANGUAGE sql AS $$
  SELECT '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}'
$$;
CREATE FUNCTION pg_temp.statement_body(p_base integer, p_confirm boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'baseVersion', p_base, 'revision', 1, 'confirm', p_confirm,
    'form', jsonb_build_object('formId','test-izjava','formVersion',1,
      'formSha256',pg_temp.sha(pg_temp.statement_form())),
    'ownWork', '{"confirmed":true}'::jsonb,
    'humanHelp', '{"received":false,"entries":[]}'::jsonb,
    'ai', '{"use":"not_used","attachments":[],"declaredTools":[],"externalAttachmentIds":[]}'::jsonb)
$$;
CREATE FUNCTION pg_temp.save(p_actor text, p_body jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.save_statement(%L, %L::jsonb, %L)',
    pg_temp.id('z1'), p_body, pg_temp.statement_form()))::jsonb
$$;
CREATE FUNCTION pg_temp.read(p_actor text, p_assignment uuid) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.read_statement(%L)::text', p_assignment))
$$;

-- A confirmed payload for Ana's revision 1 with one invented conversation.
CREATE FUNCTION pg_temp.payload(p_version integer, p_principal text DEFAULT 'ana', p_conversations jsonb DEFAULT '[]')
RETURNS text LANGUAGE sql AS $$
  SELECT declaration.canonical_payload(jsonb_build_object(
    'declarationSchema','ductura-declaration-v1','declarationId','5d0c6a3e-8f21-4b7a-9c45-1e2f3a4b5c6d',
    'declarationVersion',p_version,'principalId',pg_temp.id(p_principal),'assignmentId',pg_temp.id('z1'),
    'assignmentVersion',2,'documentId','doc-a','revision',1,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',repeat('c',64)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','used','declaredTools','[]'::jsonb,'recorded','[]'::jsonb,
      'attachments',p_conversations),
    'confirmedAt','2026-11-02T10:40:00.123456Z'))
$$;
CREATE FUNCTION pg_temp.conversation(p_id text, p_reason text DEFAULT 'transferred') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('conversationId',p_id,'messagesSha256',
    '4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5','reason',p_reason,'throughSeq',2)
$$;
-- Writes a statement row straight into the table, as the owner would.
CREATE FUNCTION pg_temp.put_row(p_id uuid, p_version integer, p_payload text, p_draft jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO declaration.statement (id,institution_id,assignment_id,assignment_version,project_id,principal_id,
    document_id,revision,version,form_text,draft,payload_jcs,content_sha256)
  VALUES (p_id,pg_temp.id('fak_a'),pg_temp.id('z1'),2,'project-a',pg_temp.id('ana'),'doc-a',1,p_version,
    'Izmišljeni obrazac.',p_draft,p_payload,encode(sha256(convert_to(p_payload,'UTF8')),'hex'))
$$;
CREATE FUNCTION pg_temp.put_attachment(p_statement uuid, p_conversation text, p_reason text DEFAULT 'transferred')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO declaration.conversation_attachment VALUES (p_statement, pg_temp.id('fak_a'), p_conversation::uuid, p_reason, 2,
    '4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5')
$$;
-- Runs the deferred check now and defers it again. SET CONSTRAINTS is not
-- undone when a subtransaction rolls back, so a failed check is followed by
-- an explicit SET CONSTRAINTS ... DEFERRED in the test.
CREATE FUNCTION pg_temp.check_now() RETURNS void LANGUAGE sql AS $$
  SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
  SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
$$;

-- Fixture: Ana commits revision 1, confirms a declaration, then saves a draft.
SELECT is(pg_temp.call('ana','pkg-a','req-declaration',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.save('ana', pg_temp.statement_body(0, true)) #>> '{statement,state}', 'confirmed',
  'fixture: Ana confirms a declaration');
SELECT is(pg_temp.save('ana', pg_temp.statement_body(1, false)) #>> '{statement,state}', 'draft',
  'fixture: Ana then saves a draft over it');

-- 1. No actor of the web process reads or writes a table of the schema.
SELECT matches(pg_temp.ask(p.actor, format('SELECT count(*)::text FROM declaration.%I', t.relation)),
  '^42501: permission denied', p.actor || ' cannot read declaration.' || t.relation || ' directly, not even a count')
  FROM (VALUES ('ana'), ('dora'), ('vesna'), ('marko'), ('iva'), ('petra'), ('tomo'), ('anon')) p(actor)
  CROSS JOIN (VALUES ('statement'), ('external_attachment'), ('conversation_attachment')) t(relation);
SELECT matches(pg_temp.ask('ana', w.sql), '^42501: permission denied', 'the web role cannot ' || w.what)
  FROM (VALUES
    ('insert a statement', $$ INSERT INTO declaration.statement (id) VALUES (gen_random_uuid()) RETURNING 1 $$),
    ('change a statement', $$ UPDATE declaration.statement SET form_text = 'x' RETURNING 1 $$),
    ('delete a statement', $$ DELETE FROM declaration.statement RETURNING 1 $$),
    ('truncate the statements', $$ TRUNCATE declaration.statement $$),
    ('insert an upload', $$ INSERT INTO declaration.external_attachment (format) VALUES ('text/plain') RETURNING 1 $$),
    ('insert a conversation attachment',
     $$ INSERT INTO declaration.conversation_attachment (statement_id) VALUES (gen_random_uuid()) RETURNING 1 $$)
  ) w(what, sql);
SELECT matches(pg_temp.ask_as('ductus_worker', 'anon', format('SELECT count(*)::text FROM declaration.%I', t.relation)),
  '^42501: permission denied', 'the worker cannot reach declaration.' || t.relation)
  FROM (VALUES ('statement'), ('external_attachment'), ('conversation_attachment')) t(relation);

-- 2. Through the RPC, only the student herself reads her declaration. Dora,
-- enrolled in the same assignment, reads only her own (none). The course
-- teacher, a teacher of another course, the administrator and another
-- faculty get the same answer as for an assignment that does not exist.
SELECT is(pg_temp.read('ana', pg_temp.id('z1'))::jsonb #>> '{statement,state}', 'draft', 'Ana reads her own draft');
SELECT is(pg_temp.read('dora', pg_temp.id('z1'))::jsonb -> 'statement',
  '{"state":"none","submitted":false,"currentRevision":null,"version":0,"formText":null,"draft":null,
    "payload":null,"declarationSha256":null,"uploads":[]}'::jsonb,
  'a classmate reads only her own empty declaration, nothing of Ana''s');
SELECT is(pg_temp.read(a.actor, pg_temp.id('z1')), pg_temp.read('ana', gen_random_uuid()),
  a.actor || ' gets the same answer as for an unknown assignment')
  FROM (VALUES ('vesna'), ('marko'), ('iva'), ('petra'), ('tomo')) a(actor);
SELECT is(pg_temp.read('ana', gen_random_uuid()), '{"status": "not_found"}', 'an unknown assignment is not_found');

-- 3. After the submission the course teacher still reads nothing here; the
-- read of the bound version is a later step and goes through its own RPC.
-- The production path: the deferred check fires at commit, after the RPC's
-- definer context has ended, with the web login as the current user.
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
SELECT is(pg_temp.save('ana', pg_temp.statement_body(2, true)) #>> '{statement,state}', 'confirmed',
  'fixture: Ana confirms again, with the attachment check deferred as in production');
-- Fire it as the web role. A failure here aborts the transaction, so every
-- later test fails with it (ask_as cannot run a statement without a result).
SET LOCAL ROLE ductus_app;
SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
RESET ROLE;
SELECT pass('the deferred check passes at commit as the web role');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a',1) $$), 'requested',
  'fixture: Ana submits');
SELECT is(pg_temp.read('vesna', pg_temp.id('z1')), pg_temp.read('ana', gen_random_uuid()),
  'the course teacher gets nothing from the student RPC after the submission either');
SELECT matches(pg_temp.ask('vesna', 'SELECT count(*)::text FROM declaration.statement'), '^42501',
  'nor from the table after the submission');

-- 4. D-41: a conversation the student did not attach is never visible to the
-- teacher, not even as a number.
INSERT INTO ref SELECT 'conv-a', pg_temp.ask_as('ductus_identity', 'anon', format(
  'INSERT INTO assistant.conversation (institution_id, student_id, assignment_id) VALUES (%L, %L, %L) RETURNING id::text',
  pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')));
SELECT is(pg_temp.ask('ana', 'SELECT count(*)::text FROM assistant.conversation'), '1',
  'Ana sees her own conversation');
SELECT is(pg_temp.ask(a.actor, 'SELECT count(*)::text FROM assistant.conversation'), '0',
  a.actor || ' does not see that the conversation exists')
  FROM (VALUES ('vesna'), ('dora'), ('marko'), ('iva')) a(actor);
SELECT is(pg_temp.ask('vesna', 'SELECT count(*)::text FROM assistant.message'), '0',
  'the course teacher counts no message of it');

-- 5. Storage rules, with the owner's own rights (the RPCs write as the owner).
-- The submission confirmed over the draft, so a fresh draft is written here.
SELECT lives_ok($$ SELECT pg_temp.put_row('7a000000-0000-4000-8000-0000000000d0', 40, NULL, '{"draft":1}') $$,
  'the owner can keep one draft beside the confirmed versions');
CREATE TEMP TABLE probe AS SELECT
  '7a000000-0000-4000-8000-0000000000d0'::uuid AS draft_id,
  (SELECT id FROM declaration.statement WHERE payload_jcs IS NOT NULL ORDER BY version LIMIT 1) AS confirmed_id;
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'UPDATE declaration.statement SET draft = draft WHERE id = %L RETURNING 1', p.draft_id)),
  'ZD403: append-only row', 'not even the owner can change a draft in place') FROM probe p;
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'UPDATE declaration.statement SET draft = %L, payload_jcs = NULL, content_sha256 = NULL WHERE id = %L RETURNING 1',
  '{}', p.confirmed_id)), 'ZD403: append-only row', 'a confirmed version cannot turn back into a draft') FROM probe p;
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'DELETE FROM declaration.statement WHERE id = %L RETURNING 1', p.confirmed_id)),
  'ZD403: append-only row', 'a confirmed version cannot be deleted') FROM probe p;
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', $$ TRUNCATE declaration.conversation_attachment $$),
  '^ZD403', 'the conversation attachments cannot be truncated');

SELECT throws_ok($$ SELECT pg_temp.put_row(gen_random_uuid(), 20, NULL, '{"draft":2}') $$, '23505', NULL,
  'a student has at most one draft per assignment');
SELECT throws_ok($$ SELECT pg_temp.put_row(gen_random_uuid(), 21, pg_temp.payload(9, 'dora')) $$, '23514', NULL,
  'a confirmed row cannot carry a payload of another student');
SELECT throws_ok($$ SELECT pg_temp.put_row(gen_random_uuid(), 22, replace(pg_temp.payload(9), ',', ', ')) $$,
  '23514', NULL, 'a confirmed row keeps only canonical bytes');
SELECT throws_ok(format($$ SELECT pg_temp.put_row(gen_random_uuid(), %s,
  declaration.canonical_payload(pg_temp.payload(9)::jsonb - %L)) $$, f.version, f.field), '23514', NULL,
  'a confirmed row cannot leave out ' || f.field)
  FROM (VALUES (50, 'declarationSchema'), (51, 'principalId'), (52, 'assignmentId'), (53, 'assignmentVersion'),
               (54, 'documentId'), (55, 'revision')) f(version, field);
SELECT throws_ok($$ SELECT pg_temp.put_row(gen_random_uuid(), 25,
  declaration.canonical_payload(jsonb_set(pg_temp.payload(9)::jsonb, '{principalId}', 'null'))) $$, '23514', NULL,
  'a confirmed row cannot name no student');
SELECT throws_ok($$ SELECT pg_temp.put_row(gen_random_uuid(), 23,
  replace(pg_temp.payload(9), 'ductura-declaration-v1', 'ductus-declaration-v1')) $$,
  '23514', NULL, 'a confirmed row names the declaration schema of OD-14');

SELECT throws_ok(format($$ SELECT pg_temp.put_attachment(%L, %L) $$, p.draft_id, ref.val), 'ZD422', NULL,
  'a draft has no conversation attachment') FROM probe p, ref WHERE ref.name = 'conv-a';
SELECT throws_ok(format($$ SELECT pg_temp.put_attachment(%L, %L) $$, p.confirmed_id, ref.val), 'ZD422', NULL,
  'a row outside the confirmed payload is refused') FROM probe p, ref WHERE ref.name = 'conv-a';

-- The fixture set every constraint IMMEDIATE; this one is deferred by design.
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
INSERT INTO ref VALUES ('row-ok', '7a000000-0000-4000-8000-000000000001'),
  ('row-short', '7a000000-0000-4000-8000-000000000002'),
  ('conv-b', '1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b');
SELECT throws_ok(format($$ SELECT pg_temp.put_row(%L, 30, pg_temp.payload(9, 'ana', jsonb_build_array(
  pg_temp.conversation(%L)))), pg_temp.check_now() $$,
  (SELECT val FROM ref WHERE name = 'row-short'), (SELECT val FROM ref WHERE name = 'conv-b')),
  'ZD422', NULL, 'a confirmed payload cannot commit without the rows of its conversations');
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
SELECT throws_ok(format($$ SELECT pg_temp.put_row(%L, 31, pg_temp.payload(9, 'ana', jsonb_build_array(
  pg_temp.conversation(%L)))), pg_temp.put_attachment(%L, %L, 'student_added') $$,
  (SELECT val FROM ref WHERE name = 'row-short'), (SELECT val FROM ref WHERE name = 'conv-b'),
  (SELECT val FROM ref WHERE name = 'row-short'), (SELECT val FROM ref WHERE name = 'conv-b')),
  'ZD422', NULL, 'the row keeps the reason of the payload');
SELECT lives_ok(format($$ SELECT pg_temp.put_row(%L, 32, pg_temp.payload(9, 'ana', jsonb_build_array(
  pg_temp.conversation(%L)))), pg_temp.put_attachment(%L, %L), pg_temp.check_now() $$,
  (SELECT val FROM ref WHERE name = 'row-ok'), (SELECT val FROM ref WHERE name = 'conv-b'),
  (SELECT val FROM ref WHERE name = 'row-ok'), (SELECT val FROM ref WHERE name = 'conv-b')),
  'a confirmed payload commits together with the rows of its conversations');
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'DELETE FROM declaration.conversation_attachment WHERE statement_id = %L RETURNING 1',
  (SELECT val FROM ref WHERE name = 'row-ok'))), 'ZD403: append-only row', 'an attachment row cannot be deleted');
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon', format(
  'UPDATE declaration.conversation_attachment SET through_seq = 1 WHERE statement_id = %L RETURNING 1',
  (SELECT val FROM ref WHERE name = 'row-ok'))), 'ZD403: append-only row', 'an attachment row cannot be moved back');
SELECT throws_ok($$ INSERT INTO declaration.conversation_attachment VALUES
  ('7a000000-0000-4000-8000-000000000001', pg_temp.id('fak_a'), gen_random_uuid(), 'external_upload', 2, repeat('a',64)) $$,
  'ZD422', NULL, 'an upload is not a conversation attachment');

SELECT * FROM finish();
ROLLBACK;
