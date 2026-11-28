-- F4-PRE-R02-SRV2 part B (20261220690000): the mandatory reason transferred.
-- A conversation a transfer record of the declared document comes from, named
-- by a segment with a receipt up to the revision, is transferred, and its
-- required_through_seq is the last seq of a transferred response; a record of
-- a later revision does not count; a conversation without one, another
-- student's or another assignment's stays out. A transferred conversation
-- requires its seq only when the institution's switch is on (no row: off;
-- off gives seq 0, so neither a missing nor a too short attachment is
-- reported); the switch is written by the owner's SQL alone. Every person,
-- document and text below is invented; the documents are those of the shared
-- fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('f4r02b-' || p_name), 1, 12))::uuid
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
-- 'reason|required_through_seq' of one conversation in the snapshot, or 'none'.
CREATE FUNCTION pg_temp.snap(p_student text, p_assignment text, p_document text, p_revision bigint, p_conv text)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', format(
    'SELECT coalesce((SELECT reason || ''|'' || required_through_seq
       FROM declaration.conversation_snapshot(%L, %L, %L, %L, %s) WHERE conversation_id = %L), ''none'')',
    pg_temp.id('fak_a'), pg_temp.id(p_assignment), pg_temp.id(p_student), p_document, p_revision, pg_temp.u(p_conv)))
$$;
-- The helper over both records: 'conversation|through_seq', or ''.
CREATE FUNCTION pg_temp.seqs(p_student text, p_document text, p_assignment text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', format(
    'SELECT coalesce(string_agg(conversation_id || ''|'' || through_seq, '','' ORDER BY conversation_id), '''')
       FROM assistant.ai_transfer_through_seqs(%L, %L, %L, %L, %L::uuid[])',
    pg_temp.id('fak_a'), pg_temp.id(p_student), p_document, pg_temp.id(p_assignment),
    (SELECT array_agg(val::uuid) FROM ref WHERE name IN ('t1', 't2'))))
$$;
-- The reference the client sends back for Ana's conversation, through p_seq.
CREATE FUNCTION pg_temp.att(p_conv text, p_seq int) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'ana', format(
    'SELECT jsonb_build_object(''conversationId'', conversation_id, ''throughSeq'', %s,
       ''messagesSha256'', encode(sha256(convert_to(array_to_json(message_hashes[1:%s])::text, ''UTF8'')), ''hex''))::text
       FROM app.declaration_conversation_hashes(%L, %L) WHERE conversation_id = %L',
    p_seq, p_seq, pg_temp.id('z1'), pg_temp.id('ana'), pg_temp.u(p_conv)))::jsonb
$$;
-- Ana saves her declaration on the latest version. As 203-declaration-rpcs:
-- the fixture made every constraint immediate, so the completeness check is
-- deferred to the end of the save and then run. A refusal raised by the save
-- or by that check comes back as {"error": SQLSTATE}, never as a broken cast.
CREATE FUNCTION pg_temp.save(p_revision bigint, p_confirm boolean, p_attachments jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  result text;
  form text := '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';
  base int := pg_temp.ask_as('ductus_evidence', 'ana',
    'SELECT coalesce(max(version), 0)::text FROM declaration.statement')::int;
  body jsonb := jsonb_build_object('baseVersion',base,'revision',p_revision,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(form)),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','used','attachments',p_attachments,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb));
BEGIN
  -- One block: a failed check rolls the save back with it.
  BEGIN
    SET CONSTRAINTS declaration.statement_attachments_complete DEFERRED;
    result := pg_temp.ask('ana',format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)',body,form));
    SET CONSTRAINTS declaration.statement_attachments_complete IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', SQLSTATE);
  END;
  IF result ~ '^[0-9A-Z]{5}: ' THEN
    RETURN jsonb_build_object('error', left(result, 5));
  END IF;
  RETURN result::jsonb;
END $$;

-- One request of a conversation: the paragraph and, if given, the response.
CREATE FUNCTION pg_temp.turn(p_conv text, p_student text, p_request text, p_seq int, p_paragraph text, p_response text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
    idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state)
  VALUES (pg_temp.u(p_request), pg_temp.id('fak_a'), pg_temp.id(p_student), pg_temp.id('z1'), 2, pg_temp.u(p_conv),
    pg_temp.u('key-' || p_request), pg_temp.sha(p_request), 1, 'proofreading', 'provider-test-a', 'model-test-1',
    'test-1', 'reserved');
  INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256)
  VALUES (pg_temp.u(p_request || '-p'), pg_temp.u(p_conv), pg_temp.id('fak_a'), p_seq, pg_temp.u(p_request),
    'student_paragraph', p_paragraph, pg_temp.sha(p_paragraph));
  IF p_response IS NULL THEN RETURN; END IF;
  UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id = pg_temp.u(p_request);
  UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u(p_request);
  INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256)
  VALUES (pg_temp.u(p_request || '-r'), pg_temp.u(p_conv), pg_temp.id('fak_a'), p_seq + 1, pg_temp.u(p_request),
    'provider_response', p_response, pg_temp.sha(p_response));
END $$;

-- Ana's conversations on z1: conv_a with two responses, conv_b with one; and
-- Dora's conv_d on the same assignment.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_b'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_d'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'));
SELECT pg_temp.turn('conv_a', 'ana', 'r1', 1, 'Izmišljeni odlomak o vijeću.', 'Izmišljeni odgovor: Lorem odlomak o vijeću.');
SELECT pg_temp.turn('conv_a', 'ana', 'r2', 3, 'Izmišljeni drugi odlomak.', 'Izmišljeni drugi odgovor: Ipsum zaključak.');
SELECT pg_temp.turn('conv_b', 'ana', 'r3', 1, 'Izmišljeno pitanje.', 'Izmišljeni odgovor bez prijenosa.');
SELECT pg_temp.turn('conv_d', 'dora', 'r4', 1, 'Tuđi izmišljeni odlomak.', NULL);
RESET ROLE;

INSERT INTO ref SELECT 't1', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('r1-r') || $$', 'Lorem odlomak') $$);
INSERT INTO ref SELECT 't2', pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', '$$
  || pg_temp.u('r2-r') || $$', 'Ipsum zaključak') $$);
INSERT INTO ref
  SELECT r.name || '_sha', t.record_sha256
    FROM ref r JOIN assistant.ai_transfer t ON t.transfer_id::text = r.val
   WHERE r.name IN ('t1', 't2');
SELECT is((SELECT count(*)::int FROM ref WHERE name ~ '^t[12](_sha)?$'), 4, 'fixture: two transfers from conv_a and their hashes');

-- Revision 1 names nothing, revision 2 names t1 (seq 2), revision 3 names t2 (seq 4).
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v2-1', pg_temp.descriptor(),
    0, repeat('a', 64), repeat('d', 64), repeat('b', 64), '[]'::jsonb),
  'reserved', 'fixture: revision 1 is a segment without links');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-2',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
      p_hash => repeat('c', 64), p_predecessor => repeat('b', 64))),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64), jsonb_build_array(pg_temp.link('t1'))),
  'reserved', 'fixture: revision 2 is a v4 segment naming t1');
SELECT is(pg_temp.call4('ana', 'pkg-a', 'v4-3',
    pg_temp.v4(pg_temp.descriptor(p_segment => 'segment-a-3', p_sequence_from => 3, p_sequence_to => 3,
      p_hash => repeat('9', 64), p_predecessor => repeat('c', 64))),
    2, repeat('e', 64), repeat('f', 64), repeat('9', 64), jsonb_build_array(pg_temp.link('t2'))),
  'reserved', 'fixture: revision 3 is a v4 segment naming t2');

-- 0. Catalogue: the helper and the switch.
SELECT is((SELECT format('%s|%s|%s|%s', proowner::regrole, prosecdef, provolatile, 'search_path=""' = ANY (proconfig))
    FROM pg_proc WHERE oid = 'assistant.ai_transfer_through_seqs(uuid,uuid,text,uuid,uuid[])'::regprocedure),
  'ductus_identity|t|s|t', 'the helper: identity owner, a definer, STABLE, empty search_path');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'assistant.ai_transfer_through_seqs(uuid,uuid,text,uuid,uuid[])', 'EXECUTE') $$,
  'only the evidence owner calls the helper');
SELECT ok(has_function_privilege('ductus_evidence', 'assistant.ai_transfer_through_seqs(uuid,uuid,text,uuid,uuid[])', 'EXECUTE'),
  'the evidence owner calls it');
SELECT is((SELECT format('%s|%s|%s', c.relowner::regrole, c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c WHERE c.oid = 'declaration.mandatory_attachment_setting'::regclass),
  'ductus_evidence|t|t', 'the switch: evidence owner, forced RLS');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_identity',
                                'ductus_test_stranger', 'public']) r
      WHERE has_table_privilege(r, 'declaration.mandatory_attachment_setting', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') $$,
  'no other role has a privilege on the switch');
SELECT matches(pg_temp.ask_as(r, a, format(
    'WITH x AS (INSERT INTO declaration.mandatory_attachment_setting (institution_id, enabled) VALUES (%L, true) RETURNING 1)
     SELECT count(*)::text FROM x', pg_temp.id('fak_a'))),
  '^42501', format('%s with the session of %s cannot turn the check on', r, a))
FROM (VALUES ('ductus_app', 'ana'), ('ductus_app', 'iva'), ('ductus_app', 'anon'), ('ductus_worker', 'anon'),
             ('ductus_identity', 'anon'), ('ductus_retention', 'anon'), ('ductus_auth', 'anon')) v (r, a);
SELECT matches(pg_temp.ask_as('ductus_app', a, 'SELECT count(*)::text FROM declaration.mandatory_attachment_setting'),
  '^42501', format('the web role with the session of %s reads nothing of the switch', a))
FROM unnest(ARRAY['ana', 'anon']) a;

-- 1. The snapshot follows the chain up to the revision. With the switch off
-- (no row) a transferred conversation requires nothing (seq 0); section 3
-- reads the seqs with the switch on.
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 1, 'conv_a'), 'student_added|0',
  'up to revision 1 no record names conv_a: student_added');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 2, 'conv_a'), 'transferred|0',
  'switch off, up to revision 2: transferred, nothing required');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 3, 'conv_a'), 'transferred|0',
  'switch off, up to revision 3: transferred, nothing required');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 3, 'conv_b'), 'student_added|0',
  'a conversation no record comes from stays student_added');
SELECT is(pg_temp.snap('dora', 'z1', 'doc-a', 3, 'conv_d'), 'student_added|0',
  'another student''s conversation is never made mandatory by Ana''s records');
SELECT is(pg_temp.snap('ana', 'z3', 'doc-a', 3, 'conv_a'), 'none', 'another assignment has none of Ana''s conversations');
SELECT is(pg_temp.seqs('ana', 'doc-a', 'z1'), pg_temp.u('conv_a') || '|4', 'the helper: conv_a through seq 4');
SELECT is(pg_temp.seqs('dora', 'doc-a', 'z1') || pg_temp.seqs('ana', 'doc-b', 'z1') || pg_temp.seqs('ana', 'doc-a', 'z3'), '',
  'another student, document or assignment gets nothing from the helper');
SELECT is(pg_temp.ask('ana', $$ SELECT declaration.list_conversations({z1}) #> '{conversations}' $$)::jsonb
    @> jsonb_build_array(jsonb_build_object('conversationId', pg_temp.u('conv_a'), 'reason', 'transferred')), true,
  'the candidate list shows conv_a as transferred');

-- 2. Switch off (no row): nothing is mandatory, the reason is still given.
SELECT is(pg_temp.save(3, true, '[]'::jsonb) #>> '{statement,state}', 'confirmed',
  'switch off: confirmed without the transferred conversation');
SELECT is(pg_temp.save(3, true, jsonb_build_array(pg_temp.att('conv_a', 2))) #> '{statement,payload,ai,attachments}',
  jsonb_build_array(pg_temp.att('conv_a', 2) || '{"reason":"transferred"}'::jsonb),
  'switch off: a throughSeq below the last transfer is confirmed, with reason transferred');

-- 3. Switch on, written by the owner's SQL.
SET LOCAL ROLE ductus_evidence;
INSERT INTO declaration.mandatory_attachment_setting (institution_id, enabled) VALUES (pg_temp.id('fak_a'), true);
RESET ROLE;
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 1, 'conv_a'), 'student_added|0',
  'switch on, up to revision 1 no record names conv_a: student_added');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 2, 'conv_a'), 'transferred|2',
  'switch on, up to revision 2 the record of revision 1 is in: transferred through the response at seq 2');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 3, 'conv_a'), 'transferred|4',
  'switch on, up to revision 3 the last transferred response is at seq 4');
SELECT is(pg_temp.snap('ana', 'z1', 'doc-a', 3, 'conv_b'), 'student_added|0',
  'switch on: a conversation no record comes from stays student_added with 0');
SELECT is(pg_temp.snap('dora', 'z1', 'doc-a', 3, 'conv_d'), 'student_added|0',
  'switch on: another student''s conversation is never made mandatory by Ana''s records');
SELECT is(pg_temp.save(3, true, '[]'::jsonb),
  jsonb_build_object('status', 'conflict', 'reason', 'mandatory_attachment_missing',
    'conversationIds', jsonb_build_array(pg_temp.u('conv_a'))),
  'switch on: a confirmation without conv_a is mandatory_attachment_missing');
SELECT is(pg_temp.save(3, false, '[]'::jsonb) #>> '{reason}', 'mandatory_attachment_missing',
  'switch on: a draft without it too');
SELECT is(pg_temp.save(3, true, jsonb_build_array(pg_temp.att('conv_a', 2))),
  jsonb_build_object('status', 'conflict', 'reason', 'attachment_stale',
    'conversationIds', jsonb_build_array(pg_temp.u('conv_a'))),
  'switch on: a throughSeq below the last transfer is attachment_stale');
SELECT is(pg_temp.save(3, true, jsonb_build_array(pg_temp.att('conv_a', 4))) #> '{statement,payload,ai,attachments}',
  jsonb_build_array(pg_temp.att('conv_a', 4) || '{"reason":"transferred"}'::jsonb),
  'switch on: through the last transfer it is confirmed; conv_b is not mandatory');

-- 4. A row with enabled false is off as well.
SET LOCAL ROLE ductus_evidence;
UPDATE declaration.mandatory_attachment_setting SET enabled = false WHERE institution_id = pg_temp.id('fak_a');
RESET ROLE;
SELECT is(pg_temp.save(3, true, '[]'::jsonb) #>> '{statement,state}', 'confirmed',
  'switch turned off again: confirmed without the conversation');

-- 5. A confirmation against an older revision (switch off). A transfer that
-- appeared since gives attachment_stale (before: stale_revision); without a
-- change of reason it stays stale_revision.
SELECT is(pg_temp.save(1, true, '[]'::jsonb),
  jsonb_build_object('status', 'conflict', 'reason', 'attachment_stale',
    'conversationIds', jsonb_build_array(pg_temp.u('conv_a'))),
  'confirming revision 1 after conv_a became transferred: attachment_stale');
SELECT is(pg_temp.save(2, true, '[]'::jsonb),
  jsonb_build_object('status', 'conflict', 'reason', 'stale_revision', 'currentRevision', 3),
  'confirming revision 2, where conv_a was already transferred: stale_revision');

SELECT * FROM finish();
ROLLBACK;
