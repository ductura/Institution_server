-- SRV-IZJAVA-AI-UNBOUND (20261220830000): beside the bound declaration the
-- course teacher reads, as { aiTransferId, aiTransferSha256 } ordered by id,
-- the student's AI transfer records of the declared document that no segment
-- with a receipt at or before the declared revision names: the complement of
-- the payload's ai.recorded. A record such a segment names is left out; a
-- segment without a receipt, or one whose receipt is above the declared
-- revision, binds nothing here; records of another document are not listed;
-- without a bound declaration the list is null; nobody but the course teacher
-- or the mentor of the work reads it (C-23); the read writes no access-log row
-- of its own. Personas of institution.inc and mentorship.inc (Marko mentors
-- Ana's zm1). Every person, document and text below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- As in 038: mentorship.inc writes an assignment before its first version.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT plan(32);

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('unbound-' || p_name), 1, 12))::uuid
$$;
CREATE FUNCTION pg_temp.v4(p_descriptor jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_set(p_descriptor, '{evidenceSchema}', '"ductus-evidence-segment-v4"')
$$;
CREATE FUNCTION pg_temp.call4(
  p_actor text, p_package text, p_request text, p_descriptor jsonb,
  p_revision bigint, p_initial text, p_final text, p_payload_hash text, p_links jsonb
) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.commit_evidence_segment(%L, %L, %s, %L, %L, %L::jsonb, %L, %L, %L, %L::jsonb)',
    p_package, p_request, p_revision, pg_temp.sha(p_initial), pg_temp.sha(p_final),
    p_descriptor::text, p_payload_hash, 'synthetic://' || p_package || '/' || p_request, p_final,
    p_links::text
  ))
$$;
-- VOLATILE, so they see the rows written after the function was planned.
CREATE FUNCTION pg_temp.ref_of(p_name text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT val FROM ref WHERE name = p_name
$$;
CREATE FUNCTION pg_temp.link(p_name text) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('aiTransferId', pg_temp.ref_of(p_name), 'aiTransferSha256', pg_temp.ref_of(p_name || '_sha'))
$$;
-- The expected list: the named records, ordered by their id.
CREATE FUNCTION pg_temp.listed(p_names text[]) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT coalesce(jsonb_agg(pg_temp.link(n) ORDER BY pg_temp.ref_of(n)::uuid), '[]'::jsonb)::text FROM unnest(p_names) n
$$;
-- What a reader gets: the list as text, the word NULL, or the refusal.
CREATE FUNCTION pg_temp.unbound_of(p_actor text, p_assignment text, p_student text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(app.teacher_declaration_unbound(%L, %L)::text, ''NULL'')',
    pg_temp.id(p_assignment), pg_temp.id(p_student)))
$$;
CREATE FUNCTION pg_temp.unbound(p_actor text, p_student text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.unbound_of(p_actor, 'z1', p_student)
$$;
CREATE FUNCTION pg_temp.save(p_assignment text DEFAULT 'z1') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',0,'revision',1,'confirm',true,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use',CASE WHEN p_assignment = 'z1' THEN 'used' ELSE 'not_used' END,'attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement(%L, %L::jsonb, %L)',
    pg_temp.id(p_assignment),body,form))::jsonb;
END $$;
CREATE FUNCTION pg_temp.openings() RETURNS bigint LANGUAGE sql VOLATILE AS $$
  SELECT count(*) FROM audit.access_log l WHERE l.assignment_id = pg_temp.id('z1')
$$;

-- Ana's conversation on z1 and a response she takes three passages from.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   pg_temp.u('key-r1'), pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak o mostu.', pg_temp.sha('Izmišljeni odlomak o mostu.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id = pg_temp.u('r1');
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u('r1');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor: Lorem odlomak 1 o kamenom mostu. Kraj.',
   pg_temp.sha('Izmišljeni odgovor: Lorem odlomak 1 o kamenom mostu. Kraj.'));
RESET ROLE;

INSERT INTO ref SELECT 't1', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'Lorem odlomak 1') $$);
INSERT INTO ref SELECT 't2', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'o kamenom mostu') $$);
INSERT INTO ref SELECT 't3', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'Kraj') $$);
INSERT INTO ref
  SELECT r.name || '_sha', t.record_sha256
    FROM ref r JOIN assistant.ai_transfer t ON t.transfer_id::text = r.val
   WHERE r.name IN ('t1', 't2', 't3');
SELECT is((SELECT count(*)::int FROM ref WHERE name ~ '^t[123](_sha)?$'), 6, 'fixture: three transfers and their hashes');

-- 0. Catalogue: the evidence owner's helper for identity, the reader for the application.
SELECT is((SELECT format('%s|%s|%s', proowner::regrole, prosecdef, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'declaration.bound_ai_transfer_ids(uuid,uuid,text,bigint)'::regprocedure),
  'ductus_evidence|t|t', 'the helper: evidence owner, a definer, empty search_path');
SELECT is(ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                                           'ductus_auth', 'ductus_test_stranger', 'public']) r
                 WHERE has_function_privilege(r, 'declaration.bound_ai_transfer_ids(uuid,uuid,text,bigint)', 'EXECUTE')),
  ARRAY['ductus_identity'], 'of the runtime roles only identity executes the helper');
SELECT is((SELECT format('%s|%s|%s', proowner::regrole, prosecdef, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'app.teacher_declaration_unbound(uuid,uuid)'::regprocedure),
  'ductus_identity|t|t', 'the reader: identity owner, a definer, empty search_path');
SELECT is(ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                                           'ductus_auth', 'ductus_test_stranger', 'public']) r
                 WHERE has_function_privilege(r, 'app.teacher_declaration_unbound(uuid,uuid)', 'EXECUTE')),
  ARRAY['ductus_app'], 'of the other roles only the application executes the reader');

-- 1. Before a submission there is no bound declaration.
SELECT is(pg_temp.unbound('vesna', 'ana'), 'NULL', 'without a bound declaration the list is null');

-- 2. Revision 1 names t2; Ana confirms and submits it.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t2'))),
  'reserved', 'fixture: revision 1 is a v4 segment naming t2');
SELECT is(pg_temp.save() #>> '{statement,state}', 'confirmed', 'fixture: Ana confirms her declaration');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests the submission');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L, %L)', q.id, q.content_hash)),
  'recorded', 'fixture: the submission is recorded')
  FROM evidence.submission_request q WHERE q.document_id = 'doc-a';

-- 3. The teacher reads the records no segment names.
INSERT INTO ref SELECT 'before', pg_temp.openings()::text;
SELECT is(pg_temp.unbound('vesna', 'ana'), pg_temp.listed(ARRAY['t1', 't3']),
  'the teacher reads t1 and t3 with their hashes, ordered by id; t2 is bound');
SELECT is(pg_temp.openings()::text, pg_temp.ref_of('before'), 'the read writes no access-log row of its own');
SELECT is(pg_temp.unbound('vesna', 'dora'), 'NULL', 'a classmate without a submission has no list');
SELECT is((SELECT (b.payload_jcs::jsonb #> '{ai,recorded}')::text
             FROM declaration.bound_declaration_of(pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana')) b),
  pg_temp.listed(ARRAY['t2']), 'the payload records t2 only: recorded and unbound are complementary');

-- 3b. Only a segment with a receipt at or before the declared revision (1)
-- binds. The rows are written directly: the package is closed by the
-- submission, and an accepted segment always comes with its receipt.
INSERT INTO evidence.segment (
  id, evidence_package_id, institution_id, document_id, principal_id, session_id, sequence_from, sequence_to,
  event_count, descriptor, segment_hash, payload_bytes, storage_ref, accepted_at
) VALUES ('segment-a-orphan', 'pkg-a', pg_temp.id('fak_a'), 'doc-a', pg_temp.id('ana'), 'synthetic-session',
  50, 50, 1, jsonb_build_object('segmentHash', repeat('e', 64), 'payloadBytes', 123),
  repeat('e', 64), 123, 'synthetic://segment-a-orphan', now());
INSERT INTO evidence.segment_ai_transfer (
  segment_id, evidence_package_id, institution_id, principal_id, ai_transfer_id, ai_transfer_sha256
) VALUES ('segment-a-orphan', 'pkg-a', pg_temp.id('fak_a'), pg_temp.id('ana'),
  pg_temp.ref_of('t1')::uuid, pg_temp.ref_of('t1_sha'));
SELECT is(pg_temp.unbound('vesna', 'ana'), pg_temp.listed(ARRAY['t1', 't3']),
  'a segment without a receipt does not bind t1');

INSERT INTO evidence.segment (
  id, evidence_package_id, institution_id, document_id, principal_id, session_id, sequence_from, sequence_to,
  event_count, descriptor, segment_hash, payload_bytes, storage_ref, accepted_at
) VALUES ('segment-a-late', 'pkg-a', pg_temp.id('fak_a'), 'doc-a', pg_temp.id('ana'), 'synthetic-session',
  60, 60, 1, jsonb_build_object('segmentHash', repeat('f', 64), 'payloadBytes', 123),
  repeat('f', 64), 123, 'synthetic://segment-a-late', now());
INSERT INTO evidence.segment_ai_transfer (
  segment_id, evidence_package_id, institution_id, principal_id, ai_transfer_id, ai_transfer_sha256
) VALUES ('segment-a-late', 'pkg-a', pg_temp.id('fak_a'), pg_temp.id('ana'),
  pg_temp.ref_of('t3')::uuid, pg_temp.ref_of('t3_sha'));
INSERT INTO evidence.receipt (
  id, evidence_package_id, institution_id, evidence_domain_id, segment_id, principal_id, client_request_id,
  payload_sha256, descriptor, receipt_payload, status
) VALUES (pg_temp.u('late-receipt'), 'pkg-a', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1',
  'segment-a-late', pg_temp.id('ana'), 'late-1', repeat('f', 64), '{}', '{"revision":2}', 'pending_signature');
SELECT is(pg_temp.unbound('vesna', 'ana'), pg_temp.listed(ARRAY['t1', 't3']),
  'a segment whose receipt is above the declared revision leaves t3 unbound');

-- A second invented document of Ana's z1 and a record on it.
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-a2', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), pg_temp.h('a'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-a2', pg_temp.id('fak_a'), 0, pg_temp.id('ana'), pg_temp.h('a'));
INSERT INTO ref SELECT 't4', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a2', '$$
  || pg_temp.u('m2') || $$', 'Izmišljeni odgovor') $$);
SELECT ok(pg_temp.ref_of('t4') ~ '^[0-9a-f-]{36}$', 'fixture: a record on the other document');
SELECT is(pg_temp.unbound('vesna', 'ana'), pg_temp.listed(ARRAY['t1', 't3']),
  'a record of another document is not listed');

-- 4. Nobody else reads it.
SELECT is(pg_temp.unbound('ana', 'ana'), 'ZD403: forbidden', 'the student does not read it here');
SELECT is(pg_temp.unbound('dora', 'ana'), 'ZD403: forbidden', 'a classmate does not read it');
SELECT is(pg_temp.unbound('marko', 'ana'), 'ZD403: forbidden', 'a teacher of another course does not');
SELECT is(pg_temp.unbound('iva', 'ana'), 'ZD403: forbidden', 'the administrator does not');
SELECT is(pg_temp.unbound('anon', 'ana'), 'ZD401: not authenticated', 'without a session nothing');
SELECT is(pg_temp.ask('vesna', format('SELECT coalesce(app.teacher_declaration_unbound(%L, %L)::text, ''NULL'')',
    pg_temp.id('z3'), pg_temp.id('tomo'))), 'ZD403: forbidden', 'another faculty''s work is refused');

-- 5. The mentor of Ana's zm1 reads its list through the mentorship (as in 249).
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.open_student_work(%L::uuid)', pg_temp.id('zm1'))),
  'opened', 'fixture: Ana opens her mentored work');
INSERT INTO ref SELECT 'doc_m1', d.id FROM evidence.document d JOIN evidence.project p ON p.id = d.project_id
 WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1');
INSERT INTO ref SELECT 'pkg_m1', id FROM evidence.package WHERE document_id = pg_temp.ref_of('doc_m1');
SELECT is(pg_temp.unbound_of('marko', 'zm1', 'ana'), 'NULL', 'the mentor reads null before a submission');
SELECT is(pg_temp.call('ana', pg_temp.ref_of('pkg_m1'), 'm-request-1',
    pg_temp.descriptor(p_package => pg_temp.ref_of('pkg_m1'), p_document => pg_temp.ref_of('doc_m1'),
      p_segment => 'segment-m-1'),
    0, evidence.revision_zero_document(), repeat('d', 64), repeat('b', 64)),
  'reserved', 'fixture: Ana commits revision 1 of zm1');
SELECT is(pg_temp.save('zm1') #>> '{statement,state}', 'confirmed', 'fixture: Ana confirms her zm1 declaration');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, 1)', pg_temp.ref_of('doc_m1'))),
  'requested', 'fixture: Ana requests revision 1 of zm1');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission(%L::uuid, %L)',
    (SELECT id FROM evidence.submission_request WHERE document_id = pg_temp.ref_of('doc_m1')), pg_temp.h('d'))),
  'recorded', 'fixture: her zm1 submission is recorded');
SELECT is(pg_temp.unbound_of('marko', 'zm1', 'ana'), '[]',
  'the mentor reads the list of the mentored work: none of z1''s records');
SELECT matches(pg_temp.unbound_of('vesna', 'zm1', 'ana'), '^ZD403',
  'the course teacher does not read the mentored work');

SELECT * FROM finish();
ROLLBACK;
