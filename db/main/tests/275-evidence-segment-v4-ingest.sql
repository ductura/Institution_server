-- SRV-1809 (Ductus docs/contracts/evidence-segment-v4.md, Ductus#2059): the
-- database accepts a ductus-evidence-segment-v4 segment through the 10-argument
-- app.commit_evidence_segment (20261220490000). Acceptance: (1) v4 needs the
-- array of links, v2 and v3 take none; (2) a link that is malformed, names no
-- record, another student's or document's record, another hash or a record
-- already bound is invalid, one answer for all, and writes nothing; (3) the
-- accepted links are stored with the segment, append only; (4) a retry with
-- other links is an idempotency conflict; (5) the 9-argument function stays as
-- it was and still refuses v4. Every person, document and text below is
-- invented; the documents are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('srv1809-' || p_name), 1, 12))::uuid
$$;
CREATE FUNCTION pg_temp.v4(p_descriptor jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_set(p_descriptor, '{evidenceSchema}', '"ductus-evidence-segment-v4"')
$$;
-- The 10-argument acceptance; p_links NULL sends SQL NULL.
CREATE FUNCTION pg_temp.call4(
  p_actor text, p_package text, p_request text, p_descriptor jsonb,
  p_revision bigint, p_initial text, p_final text, p_payload_hash text, p_links jsonb,
  p_column text DEFAULT 'outcome'
) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT %I FROM app.commit_evidence_segment(%L, %L, %s, %L, %L, %L::jsonb, %L, %L, %L, %L::jsonb)',
    p_column, p_package, p_request, p_revision, pg_temp.sha(p_initial), pg_temp.sha(p_final),
    p_descriptor::text, p_payload_hash, 'synthetic://' || p_package || '/' || p_request, p_final,
    p_links::text
  ))
$$;
-- VOLATILE, so they see the rows written after the function was planned.
CREATE FUNCTION pg_temp.ref_of(p_name text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT val FROM ref WHERE name = p_name
$$;
CREATE FUNCTION pg_temp.link(p_name text, p_sha text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('aiTransferId', pg_temp.ref_of(p_name),
                            'aiTransferSha256', coalesce(p_sha, pg_temp.ref_of(p_name || '_sha')))
$$;
CREATE FUNCTION pg_temp.links_stored() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', $q$ SELECT coalesce(string_agg(
      segment_id || ' ' || ai_transfer_id::text || ' ' || ai_transfer_sha256, ',' ORDER BY segment_id, ai_transfer_id::text), '')
    FROM evidence.segment_ai_transfer $q$)
$$;
CREATE FUNCTION pg_temp.receipt_schema(p_request text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask('ana', format($q$ SELECT receipt_payload::jsonb->>'evidenceSchema'
    FROM evidence.receipt WHERE client_request_id = %L $q$, p_request))
$$;

-- Ana's conversation on z1 and a response she takes three passages from.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-000000001809', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
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

-- 0. Catalogue.
SELECT is((SELECT format('%s|%s|%s', proowner::regrole, prosecdef, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb)'::regprocedure),
  'ductus_evidence|t|t', 'the 10-argument acceptance: evidence owner, SECURITY DEFINER, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                                'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'app.commit_evidence_segment(text,text,bigint,text,text,jsonb,text,text,text,jsonb)', 'EXECUTE') $$,
  ARRAY['ductus_app'], 'only the web role calls the 10-argument acceptance');
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'assistant.ai_transfer_link_sha256(uuid,uuid,uuid,text)'::regprocedure),
  'ductus_identity|t|s|t', 'the link hash: identity owner, SECURITY DEFINER, STABLE, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                                'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'assistant.ai_transfer_link_sha256(uuid,uuid,uuid,text)', 'EXECUTE') $$,
  ARRAY['ductus_evidence'], 'only the evidence owner calls the link hash');
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(c.relowner), c.relrowsecurity::text, c.relforcerowsecurity::text)
             FROM pg_class c WHERE c.oid = 'evidence.segment_ai_transfer'::regclass),
  'ductus_evidence true true', 'the link table: evidence owner and forced RLS');
SELECT bag_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text
       FROM pg_policy WHERE polrelid = 'evidence.segment_ai_transfer'::regclass $$,
  ARRAY['evidence_segment_ai_transfer_owner * {ductus_evidence}'], 'only the owner''s policy');
SELECT is_empty(
  $$ SELECT r || ' ' || p
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, 'evidence.segment_ai_transfer', p) $$,
  'besides the owner nobody reads or writes the link table directly; the client only through the RPC');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_evidence']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, 'assistant.ai_transfer', p) $$,
  'the evidence owner still holds no right on the transfer record');

-- 1. The first segment of Ana's package: nothing that fails is written.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'bad-' || v.n, pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), v.links),
  'invalid', v.why)
FROM (VALUES
  (1, NULL::jsonb, 'v4 without the array of links is invalid'),
  (2, '{}'::jsonb, 'links that are not an array are invalid'),
  (3, '[1]'::jsonb, 'a link that is not an object is invalid'),
  (4, jsonb_build_array(pg_temp.link('t1') || '{"extra":1}'), 'a link with another key is invalid'),
  (5, jsonb_build_array(pg_temp.link('t1') - 'aiTransferSha256'), 'a link without its hash is invalid'),
  (6, jsonb_build_array(jsonb_build_object('aiTransferId', upper(pg_temp.ref_of('t1')),
        'aiTransferSha256', pg_temp.ref_of('t1_sha'))), 'an uppercase id is invalid'),
  (7, jsonb_build_array(pg_temp.link('t1', upper(pg_temp.ref_of('t1_sha')))), 'an uppercase hash is invalid'),
  (8, jsonb_build_array(jsonb_build_object('aiTransferId', 1, 'aiTransferSha256', pg_temp.ref_of('t1_sha'))),
     'an id that is not a string is invalid'),
  (9, jsonb_build_array(pg_temp.link('t1'), pg_temp.link('t1')), 'the same record twice is invalid'),
  (10, jsonb_build_array(jsonb_build_object('aiTransferId', pg_temp.u('nobody')::text,
        'aiTransferSha256', pg_temp.ref_of('t1_sha'))), 'a link to no record is invalid'),
  (11, jsonb_build_array(pg_temp.link('t1', repeat('0', 64))), 'a link with another hash is invalid'),
  (12, jsonb_build_array(pg_temp.link('t1', pg_temp.ref_of('t2_sha'))), 'a link with the hash of another record is invalid'),
  (13, jsonb_build_array(pg_temp.link('t1'), pg_temp.link('t2', repeat('0', 64))),
     'one bad link makes the whole segment invalid')
) AS v (n, links, why)
ORDER BY v.n;
SELECT is(pg_temp.call('ana', 'pkg-a', 'bad-9arg', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64)),
  'invalid', 'the 9-argument acceptance still refuses v4');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT count(*)::text FROM evidence.receipt
    WHERE client_request_id LIKE 'bad-%' $$), '0', 'the refused segments leave no receipt');
SELECT is(pg_temp.links_stored(), '', 'and no link');

SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t1'))),
  'reserved', 'a v4 segment with a link to Ana''s record is accepted');
SELECT is(pg_temp.receipt_schema('v4-1'), 'ductus-evidence-segment-v4', 'its receipt names v4');
SELECT is(pg_temp.ask('ana', $$ SELECT descriptor->>'evidenceSchema' FROM evidence.segment WHERE id = 'segment-a-1' $$),
  'ductus-evidence-segment-v4', 'the stored descriptor keeps v4');
SELECT is(pg_temp.links_stored(), 'segment-a-1 ' || pg_temp.ref_of('t1') || ' ' || pg_temp.ref_of('t1_sha'),
  'the link is stored with the segment');

-- 2. Retries: the same links return the receipt, other links conflict.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t1'))),
  'duplicate_pending', 'a retry with the same link returns the pending receipt');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), '[]'::jsonb),
  'idempotency_conflict', 'a retry without the link is an idempotency conflict');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t2'))),
  'idempotency_conflict', 'a retry with another link is an idempotency conflict');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-1', pg_temp.v4(pg_temp.descriptor()),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t1'), pg_temp.link('t2'))),
  'idempotency_conflict', 'a retry with one link more is an idempotency conflict');

-- 3. The second segment: a bound record, and v2 with links.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'bad-bound',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
      p_hash => repeat('c', 64), p_predecessor => repeat('b', 64))),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), jsonb_build_array(pg_temp.link('t1'))),
  'invalid', 'a record already bound to a segment cannot be bound again');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'bad-v2-links',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
      p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), jsonb_build_array(pg_temp.link('t2'))),
  'invalid', 'a v2 segment with links is invalid');
SELECT is(pg_temp.call4('tomo', 'pkg-b', 'bad-foreign',
    pg_temp.v4(pg_temp.descriptor(p_package => 'pkg-b', p_document => 'doc-b', p_segment => 'segment-b-1')),
    0, repeat('c', 64), repeat('d', 64), repeat('b', 64), jsonb_build_array(pg_temp.link('t2'))),
  'invalid', 'another student''s record for another work is invalid');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT count(*)::text FROM evidence.receipt
    WHERE client_request_id LIKE 'bad-%' $$), '0', 'these leave no receipt either');

SELECT is(pg_temp.call4('ana', 'pkg-a', 'v2-2',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
      p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), '[]'::jsonb),
  'reserved', 'a v2 segment with an empty array is accepted');
SELECT is(pg_temp.receipt_schema('v2-2'), 'ductus-evidence-segment-v2', 'its receipt names v2');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v3-3',
    jsonb_set(pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
      p_hash => repeat('9', 64), p_predecessor => repeat('c', 64)), '{evidenceSchema}', '"ductus-evidence-segment-v3"'),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64), NULL),
  'reserved', 'a v3 segment without links is accepted');
SELECT is(pg_temp.receipt_schema('v3-3'), 'ductus-evidence-segment-v3', 'its receipt names v3');

-- 4. A v4 segment with two links, sent in reverse order.
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-4',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-4', p_sequence_from => 4, p_sequence_to => 4,
      p_hash => repeat('8', 64), p_predecessor => repeat('9', 64))),
    3, repeat('f', 64), repeat('1', 64), repeat('8', 64),
    (SELECT jsonb_agg(pg_temp.link(n) ORDER BY pg_temp.ref_of(n) DESC) FROM unnest(ARRAY['t2', 't3']) n)),
  'reserved', 'a v4 segment with two links is accepted in any order');
SELECT is(pg_temp.links_stored(),
  (SELECT string_agg(s || ' ' || pg_temp.ref_of(n) || ' ' || pg_temp.ref_of(n || '_sha'), ',' ORDER BY s, pg_temp.ref_of(n))
     FROM (VALUES ('segment-a-1', 't1'), ('segment-a-4', 't2'), ('segment-a-4', 't3')) v (s, n)),
  'each record is bound to its segment');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-4',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-4', p_sequence_from => 4, p_sequence_to => 4,
      p_hash => repeat('8', 64), p_predecessor => repeat('9', 64))),
    3, repeat('f', 64), repeat('1', 64), repeat('8', 64),
    (SELECT jsonb_agg(pg_temp.link(n) ORDER BY pg_temp.ref_of(n)) FROM unnest(ARRAY['t2', 't3']) n)),
  'duplicate_pending', 'a retry with the same links in another order returns the receipt');

-- 5. Append only, for the owner too.
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ UPDATE evidence.segment_ai_transfer
    SET ai_transfer_sha256 = repeat('0', 64) RETURNING 'changed' $$),
  'ZD403: append-only row', 'the owner cannot change a link');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ DELETE FROM evidence.segment_ai_transfer RETURNING 'deleted' $$),
  'ZD403: append-only row', 'the owner cannot delete a link');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', 'TRUNCATE evidence.segment_ai_transfer'),
  'ZD403: append-only row', 'the owner cannot empty the link table');

SELECT * FROM finish();
ROLLBACK;
