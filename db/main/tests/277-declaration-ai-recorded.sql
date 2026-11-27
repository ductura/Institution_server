-- SRV-1809 step 2 (declaration-v1, ai.recorded; 20261220500000): a confirmed
-- declaration lists, as { aiTransferId, aiTransferSha256 } ordered by
-- aiTransferId, every AI transfer record that a segment of the declared
-- document names up to the declared revision; a segment without links adds
-- nothing, another student's or document's record never appears, a
-- confirmed version keeps the list it was confirmed with, and use not_used
-- beside a non-empty list is confirmed as it is. Every person, document and
-- text below is invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT plan(14);

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('srv1809r-' || p_name), 1, 12))::uuid
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
CREATE FUNCTION pg_temp.recorded(p_names text[]) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT coalesce(jsonb_agg(pg_temp.link(n) ORDER BY pg_temp.ref_of(n)::uuid), '[]'::jsonb) FROM unnest(p_names) n
$$;
CREATE FUNCTION pg_temp.save(p_base int, p_revision bigint, p_use text DEFAULT 'used') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  body jsonb := jsonb_build_object('baseVersion',p_base,'revision',p_revision,'confirm',true,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use',p_use,'attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  RETURN pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form))::jsonb;
END $$;
CREATE FUNCTION pg_temp.helper(p_student text, p_document text, p_revision bigint) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', format(
    'SELECT declaration.recorded_transfers(%L, %L, %L, %s)',
    pg_temp.id('fak_a'), pg_temp.id(p_student), p_document, p_revision))::jsonb
$$;

-- Ana's conversation on z1 and a response she takes three passages from.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-000000001810', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak o vijeću.', pg_temp.sha('Izmišljeni odlomak o vijeću.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id = pg_temp.u('r1');
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u('r1');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor: Lorem odlomak 1 o gradskom vijeću. Kraj.',
   pg_temp.sha('Izmišljeni odgovor: Lorem odlomak 1 o gradskom vijeću. Kraj.'));
RESET ROLE;

INSERT INTO ref SELECT 't1', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'Lorem odlomak 1') $$);
INSERT INTO ref SELECT 't2', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'o gradskom vijeću') $$);
INSERT INTO ref SELECT 't3', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('m2') || $$', 'Kraj') $$);
INSERT INTO ref
  SELECT r.name || '_sha', t.record_sha256
    FROM ref r JOIN assistant.ai_transfer t ON t.transfer_id::text = r.val
   WHERE r.name IN ('t1', 't2', 't3');
SELECT is((SELECT count(*)::int FROM ref WHERE name ~ '^t[123](_sha)?$'), 6, 'fixture: three transfers and their hashes');

-- 0. Catalogue: a private helper of the evidence owner.
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'declaration.recorded_transfers(uuid,uuid,text,bigint)'::regprocedure),
  'ductus_evidence|f|s|t', 'the list: evidence owner, not a definer, STABLE, empty search_path');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                                'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'declaration.recorded_transfers(uuid,uuid,text,bigint)', 'EXECUTE') $$,
  'only the evidence owner builds the list');

-- 1. Revision 1: a v4 segment naming t2.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t2'))),
  'reserved', 'fixture: revision 1 is a v4 segment naming t2');
INSERT INTO ref SELECT 'v1', pg_temp.save(0, 1)::text;
SELECT is(pg_temp.ref_of('v1')::jsonb #>> '{statement,state}', 'confirmed', 'Ana confirms her declaration at revision 1');
SELECT is(pg_temp.ref_of('v1')::jsonb #> '{statement,payload,ai,recorded}', pg_temp.recorded(ARRAY['t2']),
  'its ai.recorded names t2 with its hash');

-- 2. Revision 2 without links, revision 3 naming t3 and t1 in reverse order.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v2-2',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
      p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), '[]'::jsonb),
  'reserved', 'fixture: revision 2 is a v2 segment without links');
SELECT is(pg_temp.save(1, 2) #> '{statement,payload,ai,recorded}', pg_temp.recorded(ARRAY['t2']),
  'a segment without links adds nothing');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-3',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
      p_hash => repeat('9', 64), p_predecessor => repeat('c', 64))),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64),
    (SELECT jsonb_agg(pg_temp.link(n) ORDER BY pg_temp.ref_of(n) DESC) FROM unnest(ARRAY['t1', 't3']) n)),
  'reserved', 'fixture: revision 3 is a v4 segment naming t1 and t3');
SELECT is(pg_temp.save(2, 3) #> '{statement,payload,ai,recorded}', pg_temp.recorded(ARRAY['t1', 't2', 't3']),
  'at revision 3 the list holds all three records of both segments, ordered by id');

-- 3. The bound is the revision: what a receipt after it names is left out.
SELECT is(pg_temp.helper('ana', 'doc-a', 2), pg_temp.recorded(ARRAY['t2']),
  'up to revision 2 only the record of revision 1 counts');
SELECT is(pg_temp.helper('tomo', 'doc-a', 3) || pg_temp.helper('ana', 'doc-b', 3), '[]'::jsonb,
  'another student or another document has none of Ana''s records');

-- 4. A confirmed version keeps its list; not_used beside the list is confirmed.
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT payload_jcs::jsonb #>> '{ai,recorded}'
    FROM declaration.statement WHERE version = 1 $$)::jsonb, pg_temp.recorded(ARRAY['t2']),
  'version 1 keeps the list it was confirmed with');
SELECT is(pg_temp.save(3, 3, 'not_used') #> '{statement,payload,ai}',
  jsonb_build_object('use', 'not_used', 'declaredTools', '[]'::jsonb,
    'recorded', pg_temp.recorded(ARRAY['t1', 't2', 't3']), 'attachments', '[]'::jsonb),
  'use not_used beside a non-empty list is confirmed as it is');

SELECT * FROM finish();
ROLLBACK;
