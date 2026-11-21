-- SRV-1214, declaration-v1 sections 5, 6.2 and 6.3. Synthetic students,
-- documents and conversations only. Each case starts from the same confirmed
-- version and is rolled back, so they do not depend on each other.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL,
  from_revision bigint NOT NULL DEFAULT 1
);
GRANT SELECT ON demo_conversation TO ductus_evidence;

-- Only this test transaction replaces the M9.5 source (as 203-declaration-rpcs).
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id, c.reason, c.required_through_seq, c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a' AND p_revision >= c.from_revision
$$;

INSERT INTO ref VALUES
  ('required','00000000-0000-4000-8000-0000000000e1'),
  ('later','00000000-0000-4000-8000-0000000000e2');
INSERT INTO demo_conversation VALUES
  (pg_temp.id('required'),pg_temp.id('ana'),'transferred',1,ARRAY[repeat('a',64)]);

CREATE FUNCTION pg_temp.demo_ref(p_name text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('conversationId',pg_temp.id(p_name),'throughSeq',1,'messagesSha256',
    pg_temp.sha('["' || c.message_hashes[1] || '"]'))
    FROM pg_temp.demo_conversation c WHERE c.conversation_id = pg_temp.id(p_name)
$$;

CREATE FUNCTION pg_temp.save(p_base int, p_confirm boolean, p_refs jsonb, p_revision bigint DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',p_base,'revision',p_revision,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','used','attachments',p_refs,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form))::jsonb;
END $$;

CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', 'SELECT declaration.read_statement({z1}) #>> ''{statement,state}''')
$$;
CREATE FUNCTION pg_temp.submit(p_revision bigint DEFAULT 1) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, %s)', 'doc-a', p_revision))
$$;
CREATE FUNCTION pg_temp.pinned() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(q.declaration_version_id::text || ':' || q.declaration_sha256, 'none')
    FROM evidence.submission_request q WHERE q.document_id = 'doc-a'
$$;

SELECT is(pg_temp.call('ana','pkg-a','req-submission-declaration',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture commits revision 1');
-- As 203-declaration-rpcs: the fixture made every constraint immediate, so
-- defer the completeness check to the end of the save, then run it.
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
INSERT INTO ref SELECT 'saved', pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('required')))::text;
INSERT INTO ref SELECT 'saved_pin', (SELECT s.id::text || ':' || s.content_sha256 FROM declaration.statement s
  WHERE s.payload_jcs IS NOT NULL AND s.document_id = 'doc-a');
SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
SELECT is((SELECT val::jsonb #>> '{statement,state}' FROM ref WHERE name = 'saved'), 'confirmed',
  'fixture confirms revision 1 with the required conversation');

-- 6.2: a fresh version is pinned with the request, its id and hash together.
SAVEPOINT fresh;
SELECT is(pg_temp.submit(), 'requested', 'a fresh declaration does not change the submission outcome');
SELECT is(pg_temp.pinned(), (SELECT val FROM ref WHERE name = 'saved_pin'),
  'the request pins the fresh confirmed version and its hash');
SELECT is(pg_temp.state(), 'bound', 'the student reads the pinned version as bound');
SELECT is(pg_temp.ask('ana', 'SELECT declaration.read_statement({z1}) #>> ''{statement,declarationSha256}'''),
  split_part((SELECT val FROM ref WHERE name = 'saved_pin'), ':', 2),
  'the bound state shows the hash the request froze');
ROLLBACK TO SAVEPOINT fresh;

-- 6.2: a conversation that became required after the confirmation.
SAVEPOINT new_required;
INSERT INTO demo_conversation VALUES
  (pg_temp.id('later'),pg_temp.id('ana'),'pasted_known',1,ARRAY[repeat('b',64)]);
SELECT is(pg_temp.state(), 'stale', 'a new required conversation makes the confirmed version stale');
SELECT is(pg_temp.submit(), 'requested', 'the stale declaration does not block the submission (6.3, OD-6)');
SELECT is(pg_temp.pinned(), 'none', 'a stale version is never pinned');
ROLLBACK TO SAVEPOINT new_required;

-- 6.2 and 2.4: evidence now uses a message after the confirmed prefix.
SAVEPOINT attachment_stale;
UPDATE demo_conversation SET message_hashes = message_hashes || repeat('c',64), required_through_seq = 2
  WHERE conversation_id = pg_temp.id('required');
SELECT is(pg_temp.state(), 'stale', 'an attachment_stale prefix makes the version stale');
SELECT is(pg_temp.submit(), 'requested', 'the submission goes ahead');
SELECT is(pg_temp.pinned(), 'none', 'an attachment_stale version is never pinned');
ROLLBACK TO SAVEPOINT attachment_stale;

-- 2.4: an unused newer message does not make the confirmed prefix stale.
SAVEPOINT newer_message;
UPDATE demo_conversation SET message_hashes = message_hashes || repeat('c',64)
  WHERE conversation_id = pg_temp.id('required');
SELECT is(pg_temp.state(), 'confirmed', 'a message after the prefix without a transfer keeps it fresh');
SELECT is(pg_temp.submit(), 'requested', 'the submission is requested');
SELECT is(pg_temp.pinned(), (SELECT val FROM ref WHERE name = 'saved_pin'),
  'the version is pinned with the prefix the student saw');
ROLLBACK TO SAVEPOINT newer_message;

-- OD-15: the declaration belongs to one revision.
SAVEPOINT new_revision;
SELECT is(pg_temp.call('ana','pkg-a','req-submission-declaration-2',
  pg_temp.descriptor(p_segment=>'segment-a-2',p_sequence_from=>2,p_sequence_to=>2,p_hash=>repeat('c',64),
    p_predecessor=>repeat('b',64)),
  1,repeat('d',64),repeat('e',64),repeat('c',64)), 'reserved', 'the student commits revision 2');
SELECT is(pg_temp.state(), 'stale', 'a newer revision makes the confirmed version stale');
SELECT is(pg_temp.submit(2), 'requested', 'revision 2 is submitted without a new confirmation');
SELECT is(pg_temp.pinned(), 'none', 'a version confirmed for another revision is never pinned');
ROLLBACK TO SAVEPOINT new_revision;

-- 6.3, rule 11: a failure while reading the declaration never blocks.
SAVEPOINT read_error;
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'synthetic snapshot failure';
END $$;
SELECT is(pg_temp.submit(), 'requested', 'a read error does not block the submission');
SELECT is(pg_temp.pinned(), 'none', 'the request is written without a declaration');
ROLLBACK TO SAVEPOINT read_error;

-- A draft saved after the confirmation does not replace the confirmed
-- version: the request pins the latest confirmed one while it is fresh.
SAVEPOINT later_draft;
SELECT is(pg_temp.save(1,false,jsonb_build_array(pg_temp.demo_ref('required'))) #>> '{statement,state}',
  'draft', 'the student starts a new draft');
SELECT is(pg_temp.submit(), 'requested', 'the submission is requested with a draft open');
SELECT is(pg_temp.pinned(), (SELECT val FROM ref WHERE name = 'saved_pin'),
  'the latest confirmed fresh version is pinned, never the draft');
ROLLBACK TO SAVEPOINT later_draft;

-- Nothing above outlived its savepoint.
SELECT is((SELECT count(*) FROM evidence.submission_request), 0::bigint, 'every case was rolled back');

SELECT * FROM finish();
ROLLBACK;
