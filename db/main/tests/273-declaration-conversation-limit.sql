-- SRV-F4-EDI-R07: the candidate list holds at most 200 conversations (the
-- response limit of the route), so a student with more still gets a list.
-- Synthetic rows only.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id)
  SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')
    FROM generate_series(1, 201) n;
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state)
  SELECT ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid, pg_temp.id('fak_a'), pg_temp.id('ana'),
         pg_temp.id('z1'), 2, ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid, pg_temp.sha('r' || n), 1, 'proofreading',
         'provider-test-a', 'model-test-1', 'test-1', 'reserved'
    FROM generate_series(1, 201) n;
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256)
  SELECT ('00000000-0000-4000-b000-' || lpad(n::text, 12, '0'))::uuid,
         ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, pg_temp.id('fak_a'), 1,
         ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid, 'student_paragraph',
         'Izmišljeni odlomak ' || n, pg_temp.sha('Izmišljeni odlomak ' || n)
    FROM generate_series(1, 201) n;
RESET ROLE;

SELECT is(jsonb_array_length(pg_temp.ask('ana', 'SELECT declaration.list_conversations({z1}) -> ''conversations''')::jsonb),
  200, 'a student with 201 conversations gets 200, which the route can answer');
SELECT * FROM finish();
ROLLBACK;
