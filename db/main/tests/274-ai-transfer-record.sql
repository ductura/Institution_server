-- SRV-1809 step 3 (Ductus docs/contracts/evidence-segment-v4.md; owner decisions
-- Ductus#2059, comments 7208668664 and 7208831876): the record of a transfer of
-- assistant text into a work, ductus-ai-transfer-v1 (20261220440000).
-- Acceptance: (1) the canonical text in SQL equals the golden vectors of the
-- contract; (2) only the student owner records, and only from a response of
-- her own conversation on the work's assignment, the rest reads as one ZD403;
-- (3) the text must be a contiguous part of that response and is stored only as
-- its hash; (4) provider, model and purpose come from the request, the phase
-- from the state of the work (drafting, revision, after_submission), the time
-- is a whole minute; (5) the record is append only and written only through
-- the RPC. Every person, document and text below is invented; the documents
-- are those of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-' || substr(md5('srv1809-' || p_name), 1, 12))::uuid
$$;
-- The transfer as the route asks for it; the new id, or the error.
CREATE FUNCTION pg_temp.transfer(p_actor text, p_response text, p_text text, p_document text DEFAULT 'doc-a')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT transfer_id::text FROM assistant.create_ai_transfer(%L, %L, %L)',
    p_document, pg_temp.u(p_response), p_text))
$$;
-- VOLATILE, so it sees the row the transfer in its argument wrote.
CREATE FUNCTION pg_temp.phase_of(p_id text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT phase_id FROM assistant.ai_transfer WHERE transfer_id::text = p_id
$$;

-- Ana's conversation on z1 (her paragraph and the response) and Dora's.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.conversation (id, institution_id, student_id, assignment_id) VALUES
  (pg_temp.u('conv_a'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1')),
  (pg_temp.u('conv_d'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'));
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state) VALUES
  (pg_temp.u('r1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.u('conv_a'),
   '00000000-0000-4000-8000-000000001809', pg_temp.sha('r1'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved'),
  (pg_temp.u('r2'), pg_temp.id('fak_a'), pg_temp.id('dora'), pg_temp.id('z1'), 2, pg_temp.u('conv_d'),
   '00000000-0000-4000-8000-00000000180a', pg_temp.sha('r2'), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', 'reserved');
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m1'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 1, pg_temp.u('r1'), 'student_paragraph',
   'Izmišljeni odlomak o vijeću.', pg_temp.sha('Izmišljeni odlomak o vijeću.')),
  (pg_temp.u('m3'), pg_temp.u('conv_d'), pg_temp.id('fak_a'), 1, pg_temp.u('r2'), 'student_paragraph',
   'Dorin izmišljeni odlomak.', pg_temp.sha('Dorin izmišljeni odlomak.'));
UPDATE assistant.request SET state = 'sent', sent_at = now() WHERE id IN (pg_temp.u('r1'), pg_temp.u('r2'));
UPDATE assistant.request SET state = 'completed', finished_at = now() WHERE id IN (pg_temp.u('r1'), pg_temp.u('r2'));
INSERT INTO assistant.message (id, conversation_id, institution_id, seq, request_id, role, content, content_sha256) VALUES
  (pg_temp.u('m2'), pg_temp.u('conv_a'), pg_temp.id('fak_a'), 2, pg_temp.u('r1'), 'provider_response',
   'Izmišljeni odgovor: Lorem odlomak 1 o gradskom vijeću. Kraj.',
   pg_temp.sha('Izmišljeni odgovor: Lorem odlomak 1 o gradskom vijeću. Kraj.')),
  (pg_temp.u('m4'), pg_temp.u('conv_d'), pg_temp.id('fak_a'), 2, pg_temp.u('r2'), 'provider_response',
   'Dorin izmišljeni odgovor.', pg_temp.sha('Dorin izmišljeni odgovor.'));
RESET ROLE;

-- 0. Catalogue: the owner, forced RLS, one policy, and no direct privilege.
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(c.relowner), c.relrowsecurity::text, c.relforcerowsecurity::text)
             FROM pg_class c WHERE c.oid = 'assistant.ai_transfer'::regclass),
  'ductus_identity true true', 'the record: owner and forced RLS');
SELECT bag_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text
       FROM pg_policy WHERE polrelid = 'assistant.ai_transfer'::regclass $$,
  ARRAY['ai_transfer_owner * {ductus_identity}'], 'only the owner''s policy');
SELECT is_empty(
  $$ SELECT r || ' ' || p
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, 'assistant.ai_transfer', p) $$,
  'besides the owner nobody reads or writes the table directly');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                                'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'assistant.create_ai_transfer(text,uuid,text)', 'EXECUTE') $$,
  ARRAY['ductus_app'], 'only the web role calls the RPC');
SELECT is(pg_get_function_arguments('assistant.create_ai_transfer(text,uuid,text)'::regprocedure),
  'p_document_id text, p_response_id uuid, p_text text',
  'a transfer names no person, institution, phase, provider or time');

-- 1. The canonical text equals the contract's golden vectors
-- (server/contracts/evidence-transfer/golden-vectors/ai-transfer-v1.json).
SELECT is(assistant.ai_transfer_canonical(g.transfer_id::uuid, g.document_id, g.conversation_id::uuid,
            g.response_id::uuid, g.provider_id, g.model_id, g.catalog, g.purpose_id, g.phase_id, g.text_sha256,
            g.at::timestamptz),
          g.canonical, 'golden vector ' || g.name || ': the canonical text')
FROM (VALUES
  ('proofreading-nfc-text', '00000000-0000-4000-8000-0000000000a1', 'doc-lorem-1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 'provider-test-a', 'model-test-1', 2, 'proofreading', 'final_editing', 'e9ee3032c2882b8f53689f270ec63bdec47f9eba37099ca96e72378838031999', '2026-11-02T10:40:00.000Z', '{"conversationId":"00000000-0000-4000-8000-0000000000c1","documentId":"doc-lorem-1","modelId":"model-test-1","phaseId":"final_editing","providerId":"provider-test-a","purposeCatalogVersion":2,"purposeId":"proofreading","responseId":"00000000-0000-4000-8000-0000000000d1","textSha256":"e9ee3032c2882b8f53689f270ec63bdec47f9eba37099ca96e72378838031999","transferId":"00000000-0000-4000-8000-0000000000a1","transferSchema":"ductus-ai-transfer-v1","transferredAt":"2026-11-02T10:40:00.000Z"}', '26cef97f801fca721568196eb3d923533b32776f13f4e0be2f84daa643b4461f'),
  ('explanation-nfd-text-max-catalog', '00000000-0000-4000-8000-0000000000a2', 'dokument-č-2', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 'provider-test-a', 'model-test-1', 2147483647, 'explanation', 'drafting', 'ac0584a4e02fac7a3e9e55b471008147421209bbb2576c6ed8482e7618bb35c2', '2026-11-02T10:40:00.000Z', '{"conversationId":"00000000-0000-4000-8000-0000000000c1","documentId":"dokument-č-2","modelId":"model-test-1","phaseId":"drafting","providerId":"provider-test-a","purposeCatalogVersion":2147483647,"purposeId":"explanation","responseId":"00000000-0000-4000-8000-0000000000d1","textSha256":"ac0584a4e02fac7a3e9e55b471008147421209bbb2576c6ed8482e7618bb35c2","transferId":"00000000-0000-4000-8000-0000000000a2","transferSchema":"ductus-ai-transfer-v1","transferredAt":"2026-11-02T10:40:00.000Z"}', 'a1901143453977580a1fdda7df3b565b086636af5edc5cd48cba7a108c1e3ba0')
) AS g (name, transfer_id, document_id, conversation_id, response_id, provider_id, model_id, catalog, purpose_id,
        phase_id, text_sha256, at, canonical, sha256);
SELECT is(pg_temp.sha('{"conversationId":"00000000-0000-4000-8000-0000000000c1","documentId":"dokument-č-2","modelId":"model-test-1","phaseId":"drafting","providerId":"provider-test-a","purposeCatalogVersion":2147483647,"purposeId":"explanation","responseId":"00000000-0000-4000-8000-0000000000d1","textSha256":"ac0584a4e02fac7a3e9e55b471008147421209bbb2576c6ed8482e7618bb35c2","transferId":"00000000-0000-4000-8000-0000000000a2","transferSchema":"ductus-ai-transfer-v1","transferredAt":"2026-11-02T10:40:00.000Z"}'),
  'a1901143453977580a1fdda7df3b565b086636af5edc5cd48cba7a108c1e3ba0',
  'the record hash is the SHA-256 of the UTF-8 bytes of the canonical text');
SELECT is(assistant.ai_transfer_canonical('00000000-0000-4000-8000-0000000000a1', 'doc-lorem-1',
            '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 'provider-test-a',
            'model-test-1', 2, 'proofreading', 'final_editing', repeat('e', 64), '2026-11-02T12:40:00+02:00'),
          assistant.ai_transfer_canonical('00000000-0000-4000-8000-0000000000a1', 'doc-lorem-1',
            '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 'provider-test-a',
            'model-test-1', 2, 'proofreading', 'final_editing', repeat('e', 64), '2026-11-02T10:40:00Z'),
  'the time is written in UTC whatever the offset it was given in');

-- 2. Who may record: one answer for everyone but the student owner.
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ SELECT collaboration.document_submission_state('doc-a') $$),
  'none', 'nothing submitted yet');
SELECT is(left(pg_temp.transfer(a.name, 'm2', 'Lorem odlomak 1'), 5), a.result, a.name || ': ' || a.result)
FROM (VALUES ('anon', 'ZD401'), ('expired', 'ZD401'), ('closed', 'ZD401'),
             ('dora', 'ZD403'), ('vesna', 'ZD403'), ('marko', 'ZD403'),
             ('iva', 'ZD403'), ('tomo', 'ZD403')) AS a (name, result);
SELECT is(pg_temp.transfer('ana', 'm4', 'Dorin'), 'ZD403: forbidden', 'a response of Dora''s conversation reads as missing');
SELECT is(pg_temp.transfer('ana', 'm1', 'Izmišljeni'), 'ZD403: forbidden', 'her own paragraph is not a response');
SELECT is(pg_temp.transfer('ana', 'nobody', 'Lorem'), 'ZD403: forbidden', 'a missing response reads the same');
SELECT is(pg_temp.transfer('ana', 'm2', 'Lorem', 'doc-b'), 'ZD403: forbidden', 'a work of another institution reads the same');
SELECT is(pg_temp.transfer('ana', 'm2', 'Lorem', 'doc-nobody'), 'ZD403: forbidden', 'a missing work reads the same');
SELECT is(pg_temp.transfer('dora', 'm4', 'Dorin'), 'ZD403: forbidden', 'Dora''s own response does not go into Ana''s work');

-- 3. The text: a non-empty, contiguous part of the response, exactly as stored.
SELECT is(pg_temp.transfer('ana', 'm2', t.txt), 'ZD422: invalid input', t.why)
FROM (VALUES ('Lorem odlomak 2', 'a text the response does not hold is refused'),
             ('', 'an empty text is refused'),
             ('lorem odlomak 1', 'the comparison is exact, case included'),
             ('Lorem  odlomak 1', 'the comparison is exact, spacing included'),
             ('Izmišljeni odgovor: Lorem odlomak 1 o gradskom vijeću. Kraj. Više.', 'a text longer than the response is refused')
     ) AS t (txt, why);
SELECT is(pg_temp.ask('ana', $$ SELECT transfer_id::text FROM assistant.create_ai_transfer('doc-a', NULL, 'Lorem') $$),
  'ZD403: forbidden', 'no response id reads as missing');
SELECT is(pg_temp.ask('ana', format('SELECT transfer_id::text FROM assistant.create_ai_transfer(%L, %L, NULL)',
  'doc-a', pg_temp.u('m2'))), 'ZD422: invalid input', 'no text is refused');
SELECT is((SELECT count(*)::int FROM assistant.ai_transfer), 0, 'nothing of the refusals was written');

-- 4. Ana records a transfer while drafting.
INSERT INTO ref SELECT 't1', pg_temp.transfer('ana', 'm2', 'Lorem odlomak 1 o gradskom vijeću.');
SELECT matches((SELECT val FROM ref WHERE name = 't1'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'the transfer id is a version 4 UUID');
SELECT is((SELECT concat_ws(' ', t.institution_id = pg_temp.id('fak_a'), t.student_id = pg_temp.id('ana'), t.document_id,
                            t.conversation_id = pg_temp.u('conv_a'), t.response_id = pg_temp.u('m2'),
                            t.provider_id, t.model_id, t.purpose_catalog_version, t.purpose_id, t.phase_id)
             FROM assistant.ai_transfer t WHERE t.transfer_id::text = (SELECT val FROM ref WHERE name = 't1')),
  't t doc-a t t provider-test-a model-test-1 1 proofreading drafting',
  'the work, conversation and response are hers; provider, model and purpose are those of the request; the phase is drafting');
SELECT is((SELECT text_sha256 FROM assistant.ai_transfer WHERE transfer_id::text = (SELECT val FROM ref WHERE name = 't1')),
  'e9ee3032c2882b8f53689f270ec63bdec47f9eba37099ca96e72378838031999',
  'the text hash is that of the contract''s event text vector for the same text');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'assistant.ai_transfer'::regclass
             AND a.attnum > 0 AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = 'text'
             AND a.attname NOT IN ('document_id', 'provider_id', 'model_id', 'purpose_id', 'phase_id', 'text_sha256',
                                   'record_text', 'record_sha256')), 0,
  'no column holds the transferred text');
SELECT is((SELECT count(*)::int FROM assistant.ai_transfer
            WHERE record_text LIKE '%Lorem%' OR record_text LIKE '%vijeću%'), 0,
  'the record text does not hold the transferred text');
SELECT is((SELECT concat_ws(' ', extract(second FROM transferred_at)::int,
                            transferred_at <= statement_timestamp(), transferred_at > statement_timestamp() - interval '2 minutes')
             FROM assistant.ai_transfer WHERE transfer_id::text = (SELECT val FROM ref WHERE name = 't1')),
  '0 t t', 'the time is the database''s, to the whole minute');
SELECT is((SELECT (record_text::jsonb ->> 'transferId') || ' ' || (record_text::jsonb ->> 'transferSchema') || ' '
                  || (record_sha256 = pg_temp.sha(record_text))::text
             FROM assistant.ai_transfer WHERE transfer_id::text = (SELECT val FROM ref WHERE name = 't1')),
  (SELECT val FROM ref WHERE name = 't1') || ' ductus-ai-transfer-v1 true',
  'the record names its id and schema, and its hash is that of its text');
SELECT is(pg_temp.ask('ana', format(
    'SELECT (record_sha256 = encode(sha256(convert_to(record_text, ''UTF8'')), ''hex''))::text FROM assistant.create_ai_transfer(%L, %L, %L)',
    'doc-a', pg_temp.u('m2'), 'Kraj.')), 'true', 'a second transfer, of a part at the end; the RPC returns the record and its hash');
SELECT is((SELECT count(DISTINCT transfer_id)::int FROM assistant.ai_transfer), 2, 'each transfer is its own record');

-- 5. The phase follows the state of the work.
SET LOCAL ROLE ductus_identity;
INSERT INTO collaboration.revision_send (institution_id, assignment_id, owner_id, document_id, round, answered_seq)
VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'), 'doc-a', 1, 1);
RESET ROLE;
SELECT is(pg_temp.phase_of(pg_temp.transfer('ana', 'm2', 'gradskom')), 'revision', 'after a revision round: revision');
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
                       repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'requested 1', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ SELECT collaboration.document_submission_state('doc-a') $$),
  'current', 'a live submission');
SELECT is(pg_temp.ask_as('ductus_identity', 'dora', $$ SELECT collaboration.document_submission_state('doc-a') $$),
  'current', 'the state is read in the caller''s institution');
SELECT is(pg_temp.ask_as('ductus_identity', 'tomo', $$ SELECT collaboration.document_submission_state('doc-a') $$),
  'none', 'another institution sees nothing submitted');
SELECT is(pg_temp.phase_of(pg_temp.transfer('ana', 'm2', 'Lorem')), 'after_submission', 'after a submission: after_submission');
SELECT is(pg_temp.ask('vesna', $$ SELECT outcome FROM app.return_work_for_revision('doc-a', 'Doradi uvod.', NULL) $$),
  'returned', 'fixture: Vesna returns the work for revision');
SELECT is(pg_temp.ask_as('ductus_identity', 'ana', $$ SELECT collaboration.document_submission_state('doc-a') $$),
  'earlier', 'a returned submission is an earlier one');
SELECT is(pg_temp.phase_of(pg_temp.transfer('ana', 'm2', 'odlomak')), 'revision', 'after a return: revision again');

-- 6. Append only, and written only through the RPC.
SELECT matches(pg_temp.ask_as('ductus_identity', 'ana', $$ UPDATE assistant.ai_transfer SET phase_id = 'drafting' $$),
  '^ZD409', 'an update is refused, the owner too');
SELECT matches(pg_temp.ask_as('ductus_identity', 'ana', $$ DELETE FROM assistant.ai_transfer $$),
  '^ZD409', 'a delete is refused');
SELECT matches(pg_temp.ask_as('ductus_identity', 'ana', $$ TRUNCATE assistant.ai_transfer $$),
  '^ZD409', 'a truncate is refused');
SELECT matches(pg_temp.ask('ana', $$ SELECT count(*)::text FROM assistant.ai_transfer $$),
  '^42501', 'the web role cannot read the table');
SELECT matches(pg_temp.ask('ana', format($f$ INSERT INTO assistant.ai_transfer
    SELECT gen_random_uuid(), institution_id, student_id, document_id, conversation_id, response_id, provider_id,
           model_id, purpose_catalog_version, purpose_id, phase_id, text_sha256, transferred_at, record_text, %L
      FROM assistant.ai_transfer LIMIT 1 $f$, repeat('0', 64))),
  '^42501', 'the web role cannot write the table');
SELECT matches(pg_temp.ask_as('ductus_identity', 'ana', $$ INSERT INTO assistant.ai_transfer
    SELECT gen_random_uuid(), institution_id, student_id, document_id, conversation_id, response_id, provider_id,
           model_id, purpose_catalog_version, purpose_id, 'after_submission', text_sha256, transferred_at, record_text,
           repeat('0', 64)
      FROM assistant.ai_transfer WHERE phase_id = 'drafting' LIMIT 1 $$),
  '^23514', 'a row whose record text does not match its columns is refused, the owner too');
SELECT is(pg_temp.ask('ana', $$ SELECT assistant.ai_transfer_phase('doc-a', NULL) $$) LIKE '42501%', true,
  'the web role cannot call a helper');
SELECT is(pg_temp.ask('ana', $$ SELECT collaboration.document_submission_state('doc-a') $$) LIKE '42501%', true,
  'the web role cannot read the submission state');
SELECT is((SELECT count(*)::int FROM assistant.ai_transfer), 5, 'the controls left every record in place');

-- 7. At most assistant.ai_transfer_max() transfers per work (AI-RECORDED-5000): the
-- 5000th is recorded, the 5001st refused. The fixture fills the work up to 4999 with
-- copies of one record under new ids, written as the test runner.
SELECT is(assistant.ai_transfer_max(), 5000, 'a work holds at most 5000 transfers');
INSERT INTO assistant.ai_transfer
  (transfer_id, institution_id, student_id, document_id, conversation_id, response_id, provider_id, model_id,
   purpose_catalog_version, purpose_id, phase_id, text_sha256, transferred_at, record_text, record_sha256)
SELECT c.id, s.institution_id, s.student_id, s.document_id, s.conversation_id, s.response_id, s.provider_id,
       s.model_id, s.purpose_catalog_version, s.purpose_id, s.phase_id, s.text_sha256, s.transferred_at,
       c.record, encode(sha256(convert_to(c.record, 'UTF8')), 'hex')
  FROM (SELECT * FROM assistant.ai_transfer WHERE document_id = 'doc-a' LIMIT 1) s
 CROSS JOIN generate_series(1, 4999 - (SELECT count(*)::int FROM assistant.ai_transfer WHERE document_id = 'doc-a')) n
 CROSS JOIN LATERAL (SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid AS id) i
 CROSS JOIN LATERAL (SELECT i.id, assistant.ai_transfer_canonical(i.id, s.document_id, s.conversation_id,
       s.response_id, s.provider_id, s.model_id, s.purpose_catalog_version, s.purpose_id, s.phase_id,
       s.text_sha256, s.transferred_at) AS record) c;
SELECT is((SELECT count(*)::int FROM assistant.ai_transfer WHERE document_id = 'doc-a'), 4999,
  'fixture: the work holds 4999 transfers');
SELECT matches(pg_temp.transfer('ana', 'm2', 'Kraj.'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'the 5000th transfer is recorded');
SELECT is(pg_temp.transfer('ana', 'm2', 'Kraj.'), 'ZD422: invalid input', 'the 5001st transfer is refused');
SELECT is((SELECT count(*)::int FROM assistant.ai_transfer WHERE document_id = 'doc-a'), 5000,
  'the refusal wrote nothing');

SELECT * FROM finish();
ROLLBACK;
