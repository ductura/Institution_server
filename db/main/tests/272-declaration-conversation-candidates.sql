-- SRV-F4-EDI-R07 (20261220320000): the conversations a student can attach to
-- the declaration. Only the owner of the assignment lists her own
-- conversations (C-23); another student, a teacher, another faculty and a
-- session-less caller get nothing. Messages are read as hashes only. People
-- and texts are the invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('srvr07-' || p_name), 1, 12))::uuid
$$;

SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_empty'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_d'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-0000000071e1', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved'),
  (pg_temp.u('r2'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'), 2, pg_temp.u('conv_d'),
   '00000000-0000-4000-8000-0000000071e2', pg_temp.sha('r2'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak.', pg_temp.sha('Izmišljeni odlomak.')),
  (pg_temp.u('m3'), pg_temp.u('conv_d'), pg_temp.id('fak_a'), 1, pg_temp.u('r2'), 'student_paragraph',
   'Tuđi izmišljeni odlomak.', pg_temp.sha('Tuđi izmišljeni odlomak.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id IN (pg_temp.u('r1'), pg_temp.u('r2'));
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id = pg_temp.u('r1');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor.', pg_temp.sha('Izmišljeni odgovor.'));
RESET ROLE;

CREATE FUNCTION pg_temp.list(p_actor text, p_path text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.list_conversations({z1}) #>> %L', p_path))
$$;

SELECT is(pg_temp.list('ana', '{status}'), 'ok', 'the owner lists her conversations');
SELECT is(pg_temp.list('ana', '{conversations}')::jsonb #>> '{0,conversationId}', pg_temp.u('conv_a')::text,
  'it is her own conversation');
SELECT is(jsonb_array_length(pg_temp.list('ana', '{conversations}')::jsonb), 1,
  'a conversation without a message is not a candidate, and nobody else''s is listed');
SELECT is(pg_temp.list('ana', '{conversations,0,reason}'), 'student_added', 'a chosen conversation is student_added');
SELECT is(pg_temp.list('ana', '{conversations,0,throughSeq}'), '2', 'through the last message');
SELECT is(pg_temp.list('ana', '{conversations,0,messagesSha256}'),
  pg_temp.sha('["' || pg_temp.sha('Izmišljeni odlomak.') || '","' || pg_temp.sha('Izmišljeni odgovor.') || '"]'),
  'the hash is the SHA-256 of the JCS array of the message hashes');
SELECT is(pg_temp.list('dora', '{conversations,0,conversationId}'), pg_temp.u('conv_d')::text,
  'a classmate sees only her own conversation');
SELECT isnt(pg_temp.list('dora', '{conversations}') ~ pg_temp.u('conv_a')::text, true,
  'and never the other student''s');
SELECT isnt(pg_temp.list('marko', '{status}'), 'ok', 'a teacher of another course gets no list');
SELECT isnt(pg_temp.list('tomo', '{status}'), 'ok', 'a student of another faculty gets no list');
SELECT is(pg_temp.list('anon', '{status}'), 'unauthorized', 'without a session nothing');
SELECT ok(NOT has_function_privilege('ductus_app', 'app.declaration_conversation_hashes(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'app.declaration_conversation_hashes(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('ductus_evidence', 'app.declaration_conversation_hashes(uuid,uuid)', 'EXECUTE'),
  'only the evidence role executes the hash bridge');
SELECT * FROM finish();
ROLLBACK;
