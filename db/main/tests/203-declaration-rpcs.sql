-- SRV-1212. Run the production RPCs as ductus_app with synthetic sessions.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL
);
GRANT SELECT ON demo_conversation TO ductus_evidence;

-- Only this test transaction replaces the M9.5 source. The fixture has no
-- production assistant data and supplies the same scoped snapshot as M9.5.
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id,
    CASE WHEN p_revision = 2 AND c.conversation_id = pg_temp.id('optional') THEN 'pasted_known' ELSE c.reason END,
    CASE WHEN p_revision = 2 AND c.conversation_id = pg_temp.id('optional') THEN 1 ELSE c.required_through_seq END,
    c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a' AND p_revision IN (1,2)
$$;

INSERT INTO ref VALUES
  ('required','00000000-0000-4000-8000-0000000000e1'),
  ('optional','00000000-0000-4000-8000-0000000000e2'),
  ('foreign','00000000-0000-4000-8000-0000000000e3');
INSERT INTO demo_conversation VALUES
  (pg_temp.id('required'),pg_temp.id('ana'),'transferred_deleted',1,ARRAY[repeat('a',64)]),
  (pg_temp.id('optional'),pg_temp.id('ana'),'student_added',0,ARRAY[repeat('b',64)]),
  (pg_temp.id('foreign'),pg_temp.id('dora'),'student_added',0,ARRAY[repeat('c',64)]);

CREATE FUNCTION pg_temp.demo_ref(p_name text, p_seq integer DEFAULT 1, p_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('conversationId',pg_temp.id(p_name),'throughSeq',p_seq,'messagesSha256',
    coalesce(p_hash, pg_temp.sha('["' || c.message_hashes[1] || '"]')))
    FROM pg_temp.demo_conversation c WHERE c.conversation_id = pg_temp.id(p_name)
$$;

CREATE FUNCTION pg_temp.save(p_base int, p_confirm boolean, p_refs jsonb, p_uploads jsonb DEFAULT '[]',
  p_revision bigint DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',p_base,'revision',p_revision,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','used','attachments',p_refs,'declaredTools','[]'::jsonb,'externalAttachmentIds',p_uploads));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form))::jsonb;
END $$;

-- Keep the SQL sent to ask small even for a 2 MiB upload. Its expression is
-- chosen only by this test and contains no user input.
CREATE FUNCTION pg_temp.upload(p_actor text, p_assignment text, p_format text, p_bytes_sql text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor,format('SELECT declaration.upload_attachment(%L,%L,%s)',
    pg_temp.id(p_assignment),p_format,p_bytes_sql))::jsonb
$$;

SELECT is(pg_temp.call('ana','pkg-a','req-declaration-rpcs',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture commits revision 1');
SELECT is(pg_temp.save(0,false,'[]')->>'reason','mandatory_attachment_missing',
  'the draft cannot omit a required conversation whose text was deleted');
SELECT is(pg_temp.save(0,true,'[]')->'conversationIds',jsonb_build_array(pg_temp.id('required')),
  'confirmation names the required conversation the student omitted');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('foreign'))),
  pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('foreign') ||
    jsonb_build_object('conversationId',gen_random_uuid()))),
  'another student’s conversation and an unknown one are indistinguishable');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('foreign')))->>'reason',
  'invalid_attachment','the caller cannot attach another student’s conversation');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('required') || '{"reason":"student_added"}'))->>'status',
  'invalid_input','the caller cannot choose the reason');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('required',1,repeat('f',64))))->>'reason',
  'attachment_stale','a different message hash blocks confirmation');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('required',2)))->>'reason',
  'attachment_stale','a nonexistent seq blocks confirmation');
SELECT is(pg_temp.save(0,false,jsonb_build_array(pg_temp.demo_ref('required'))) #>> '{statement,state}',
  'draft','the observed required reference is saved as a draft');
SELECT is(pg_temp.save(0,true,jsonb_build_array(pg_temp.demo_ref('required'))),
  '{"status":"conflict","reason":"declaration_conflict","currentVersion":1}'::jsonb,
  'a repeated base version cannot replace the saved draft');
SELECT is(pg_temp.save(1,true,jsonb_build_array(pg_temp.demo_ref('required')),'[]',2),
  '{"status":"conflict","reason":"stale_revision","currentRevision":1}'::jsonb,
  'the work revision is checked inside the save');

UPDATE demo_conversation SET message_hashes = message_hashes || repeat('d',64), required_through_seq = 2
  WHERE conversation_id = pg_temp.id('required');
SELECT is(pg_temp.save(1,true,jsonb_build_array(pg_temp.demo_ref('required')))->'conversationIds',
  jsonb_build_array(pg_temp.id('required')),'evidence using a message after the preview makes the preview stale');
UPDATE demo_conversation SET required_through_seq = 1 WHERE conversation_id = pg_temp.id('required');
SELECT is((SELECT count(*) FROM declaration.statement WHERE payload_jcs IS NOT NULL),0::bigint,
  'rejected confirmations left no confirmed version');

SELECT is(pg_temp.upload('ana','z1','text/html',$$convert_to('Izmišljeni ispis','UTF8')$$)->>'reason',
  'unsupported_media_type','HTML is outside the format list');
SELECT is(pg_temp.upload('ana','z1','text/plain',format('decode(%L,''hex'')',bad.hex))->>'status',
  'invalid_input','TXT rejects ' || bad.label)
  FROM (VALUES ('','empty bytes'),('c328','invalid UTF-8'),('efbbbf61','BOM'),('610062','NUL'),
    ('610d62','CR'),('61c28562','C1 control')) bad(hex,label);
SELECT is(pg_temp.upload('ana','z1','application/pdf',$$convert_to('Izmišljeni ispis','UTF8')$$)->>'status',
  'invalid_input','PDF must start with %PDF-');
SELECT is(pg_temp.upload('ana','z1','application/pdf',$$convert_to('%PDF-1.7 demo','UTF8')$$)->>'contentSha256',
  pg_temp.sha('%PDF-1.7 demo'),'a PDF is stored by the hash of its original bytes');
INSERT INTO ref SELECT 'uploaded_text',pg_temp.upload('ana','z1','text/plain',
  $$convert_to(E'Izmišljeni\tispis\n','UTF8')$$)->>'externalAttachmentId';
SELECT is(pg_temp.upload('ana','z1','text/plain',$$convert_to(E'Izmišljeni\tispis\n','UTF8')$$)->>'externalAttachmentId',
  pg_temp.id('uploaded_text')::text,'reupload returns the same id for the exact TXT bytes');

-- The constraint also runs after the SECURITY DEFINER context has ended.
SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
INSERT INTO ref SELECT 'saved',pg_temp.save(1,true,jsonb_build_array(pg_temp.demo_ref('optional'),
  pg_temp.demo_ref('required')),jsonb_build_array(pg_temp.id('uploaded_text')))::text;
SET LOCAL ROLE ductus_app;
SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
RESET ROLE;
SELECT is((SELECT val::jsonb #>> '{statement,state}' FROM ref WHERE name = 'saved'),'confirmed',
  'an unused newer message does not block confirmation of the previewed prefix');
SELECT is((SELECT val::jsonb #> '{statement,payload,ai,attachments}' FROM ref WHERE name = 'saved'),
  jsonb_build_array(pg_temp.demo_ref('required') || '{"reason":"transferred_deleted"}',
    pg_temp.demo_ref('optional') || '{"reason":"student_added"}',
    (SELECT declaration.attachment_ref(a) || '{"reason":"external_upload"}'
      FROM declaration.external_attachment a WHERE id = pg_temp.id('uploaded_text'))),
  'confirmation hashes the pinned prefix and selected upload, with server reasons in canonical order');
SELECT is((SELECT count(*) FROM declaration.conversation_attachment),2::bigint,
  'the two confirmed conversations have immutable rows');

-- Four full-sized files plus the initial TXT, PDF and a final file reach
-- the exact combined limit.
SELECT is(pg_temp.upload('ana','z1','text/plain','convert_to(repeat(''x'',2097153),''UTF8'')')->>'status',
  'invalid_input','one byte over the per-file limit is rejected');
SELECT is(pg_temp.upload('ana','z1','text/plain',format('convert_to(repeat(%L,2097152),''UTF8'')',chr(n)))
  ->>'byteLength','2097152','per-file limit accepted for synthetic file ' || n)
  FROM generate_series(65,68) n;
SELECT is(pg_temp.upload('ana','z1','text/plain',$$convert_to(repeat('z',2097152 -
  octet_length(convert_to(E'Izmišljeni\tispis\n%PDF-1.7 demo','UTF8'))),'UTF8')$$)->>'status',
  'ok','the exact total byte limit is accepted');
SELECT is(pg_temp.upload('ana','z1','text/plain',$$convert_to('x','UTF8')$$)->>'reason',
  'attachments_too_large','the next byte would exceed the total limit');
SELECT is(pg_temp.upload('tomo','z3','text/plain',format('convert_to(%L,''UTF8'')','demo-' || n))->>'status',
  'ok','synthetic upload within the count limit ' || n) FROM generate_series(1,10) n;
SELECT is(pg_temp.upload('tomo','z3','text/plain',$$convert_to('demo-11','UTF8')$$)->>'reason',
  'too_many_attachments','the eleventh distinct upload is rejected');
SELECT is(pg_temp.upload('tomo','z3','text/plain',$$convert_to('demo-10','UTF8')$$)->>'status',
  'ok','an exact retry still works at the count limit');
SELECT is(pg_temp.save(2,true,jsonb_build_array(pg_temp.demo_ref('required')),
  jsonb_build_array((SELECT id FROM declaration.external_attachment WHERE principal_id = pg_temp.id('tomo') ORDER BY id LIMIT 1)))
  ->>'reason','invalid_attachment','the caller cannot attach another student’s upload');

SELECT is(pg_temp.call('ana','pkg-a','req-declaration-rpcs-2',
  pg_temp.descriptor(p_segment=>'segment-a-2',p_sequence_from=>2,p_sequence_to=>2,p_hash=>repeat('c',64),p_predecessor=>repeat('b',64)),
  1,repeat('d',64),repeat('e',64),repeat('c',64)), 'reserved', 'fixture commits revision 2');
SELECT is(pg_temp.save(2,true,jsonb_build_array(pg_temp.demo_ref('required'),pg_temp.demo_ref('optional'))),
  jsonb_build_object('status','conflict','reason','attachment_stale','conversationIds',jsonb_build_array(pg_temp.id('optional'))),
  'a conversation that became required makes the old preview stale even if its message hash is unchanged');
SELECT is(pg_temp.save(2,true,jsonb_build_array(pg_temp.demo_ref('required')),'[]',2),
  jsonb_build_object('status','conflict','reason','mandatory_attachment_missing',
    'conversationIds',jsonb_build_array(pg_temp.id('optional'))),
  'confirmation of the current revision still requires explicit selection of the newly required conversation');

SELECT * FROM finish();
ROLLBACK;
