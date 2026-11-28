-- SRV-IZJAVA-AI-UNBOUND (20261220830000): beside the bound declaration the
-- course teacher reads, as { aiTransferId, aiTransferSha256 } ordered by id,
-- the student's AI transfer records of the declared document that no segment
-- with a receipt names. A record a segment names is left out; without a bound
-- declaration the list is null; nobody but the teacher or the mentor of the
-- work reads it (C-23); the read writes no access-log row of its own. Every
-- person, document and text below is invented; the documents are those of
-- the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT plan(19);

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
CREATE FUNCTION pg_temp.unbound(p_actor text, p_student text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT coalesce(app.teacher_declaration_unbound({z1}, %L)::text, ''NULL'')',
    pg_temp.id(p_student)))
$$;
CREATE FUNCTION pg_temp.save() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',0,'revision',1,'confirm',true,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','used','attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form))::jsonb;
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
    FROM pg_proc WHERE oid = 'declaration.bound_ai_transfer_ids(uuid,uuid)'::regprocedure),
  'ductus_evidence|t|t', 'the helper: evidence owner, a definer, empty search_path');
SELECT is(ARRAY(SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                                           'ductus_auth', 'ductus_test_stranger', 'public']) r
                 WHERE has_function_privilege(r, 'declaration.bound_ai_transfer_ids(uuid,uuid)', 'EXECUTE')),
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

-- 4. Nobody else reads it.
SELECT is(pg_temp.unbound('ana', 'ana'), 'ZD403: forbidden', 'the student does not read it here');
SELECT is(pg_temp.unbound('dora', 'ana'), 'ZD403: forbidden', 'a classmate does not read it');
SELECT is(pg_temp.unbound('marko', 'ana'), 'ZD403: forbidden', 'a teacher of another course does not');
SELECT is(pg_temp.unbound('iva', 'ana'), 'ZD403: forbidden', 'the administrator does not');
SELECT is(pg_temp.unbound('anon', 'ana'), 'ZD401: not authenticated', 'without a session nothing');
SELECT is(pg_temp.ask('vesna', format('SELECT coalesce(app.teacher_declaration_unbound(%L, %L)::text, ''NULL'')',
    pg_temp.id('z3'), pg_temp.id('tomo'))), 'ZD403: forbidden', 'another faculty''s work is refused');

SELECT * FROM finish();
ROLLBACK;
