-- F4-PRE-R02-SRV2 (R-35): the student may explain, with a declaration saved
-- through save_statement_explained, why the chosen pattern of use differs from
-- the record of transfers. The explanation is bound to one statement row (a
-- draft or a confirmed version), so it goes with a replaced draft, never
-- changes on a confirmed version and is stale or bound as the declaration is;
-- it never blocks a submission. Only the owner writes and reads it; a
-- classmate, a student of another institution and the web role itself see
-- nothing of it. Synthetic people, documents and texts only; each case is
-- rolled back.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
-- mentorship.inc writes an assignment before its first version, as in 038.
SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED;
\ir fixtures/mentorship.inc
SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE;
SELECT plan(35);

CREATE TEMP TABLE demo_conversation (
  conversation_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  reason text NOT NULL,
  required_through_seq integer NOT NULL,
  message_hashes text[] NOT NULL
);
GRANT SELECT ON demo_conversation TO ductus_evidence;

-- Only this test transaction replaces the M9.5 source (as 209, 228 and 232).
CREATE OR REPLACE FUNCTION declaration.conversation_snapshot(
  p_institution uuid, p_assignment uuid, p_student uuid, p_document text, p_revision bigint
) RETURNS TABLE (conversation_id uuid, reason text, required_through_seq integer, message_hashes text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.conversation_id, c.reason, c.required_through_seq, c.message_hashes FROM pg_temp.demo_conversation c
    WHERE c.student_id = p_student AND p_institution = pg_temp.id('fak_a')
      AND p_assignment = pg_temp.id('z1') AND p_document = 'doc-a'
$$;

CREATE FUNCTION pg_temp.body(p_base int, p_confirm boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('baseVersion',p_base,'revision',1,'confirm',p_confirm,
    'form',jsonb_build_object('formId','test-izjava','formVersion',1,'formSha256',pg_temp.sha(
      '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}')),
    'ownWork','{"confirmed":true}'::jsonb,'humanHelp','{"received":false,"entries":[]}'::jsonb,
    'ai',jsonb_build_object('use','not_used','attachments','[]'::jsonb,'declaredTools','[]'::jsonb,
      'externalAttachmentIds','[]'::jsonb))
$$;
-- p_explanation is an SQL literal (or NULL), so a non-text value can be tried too.
CREATE FUNCTION pg_temp.save(p_actor text, p_base int, p_confirm boolean, p_explanation text,
  p_assignment text DEFAULT '{z1}')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.save_statement_explained(%s, %L::jsonb, %L, NULL, %s)',
    p_assignment, pg_temp.body(p_base, p_confirm),
    '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}',
    p_explanation))::jsonb
$$;
CREATE FUNCTION pg_temp.read(p_actor text, p_path text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT declaration.read_statement({z1}) #>> %L', p_path))
$$;
CREATE FUNCTION pg_temp.rows() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM declaration.mismatch_explanation
$$;
CREATE FUNCTION pg_temp.submit() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('ana', format('SELECT outcome FROM app.request_submission(%L, %s)', 'doc-a', 1))
$$;

SELECT is(pg_temp.call('ana','pkg-a','req-mismatch-explanation',pg_temp.descriptor(),0,
  repeat('a',64),repeat('d',64),repeat('b',64)), 'reserved', 'fixture commits revision 1');

-- 1. With a draft: saved, read back, replaced with the draft.
SAVEPOINT draft;
SELECT is(pg_temp.read('ana', '{statement,mismatchExplanation}'), NULL, 'no declaration has an explanation by default');
SELECT is(pg_temp.save('ana', 0, false, quote_literal('Asistenta sam koristila samo za provjeru pravopisa.'))
  #>> '{statement,mismatchExplanation}', 'Asistenta sam koristila samo za provjeru pravopisa.',
  'the student saves a draft with an explanation');
SELECT is(pg_temp.read('ana', '{statement,mismatchExplanation}'), 'Asistenta sam koristila samo za provjeru pravopisa.',
  'and reads it back');
SELECT is(pg_temp.read('ana', '{statement,state}'), 'draft', 'the declaration is a draft');
SELECT is(pg_temp.rows(), 1::bigint, 'one explanation row is written');
SELECT is(pg_temp.save('ana', 1, false, 'NULL') #>> '{statement,mismatchExplanation}', NULL,
  'a new draft without an explanation has none');
SELECT is(pg_temp.rows(), 0::bigint, 'the replaced draft''s explanation went with it');
SELECT is(pg_temp.save('ana', 2, false, quote_literal(E'Prvi redak.\nDrugi redak.'))
  #>> '{statement,mismatchExplanation}', E'Prvi redak.\nDrugi redak.', 'an explanation may span lines');
SELECT is(pg_temp.save('ana', 3, false, quote_literal(repeat('ž', 2000)))
  #>> '{statement,mismatchExplanation}', repeat('ž', 2000), '2000 code points are accepted');
SELECT is(pg_temp.read('ana', '{statement,version}'), '4', 'each accepted save is a new version');
ROLLBACK TO SAVEPOINT draft;

-- 2. An invalid explanation writes nothing: neither the statement nor the row.
SAVEPOINT invalid;
SELECT is((pg_temp.save('ana', 0, false, quote_literal('')))::text, '{"status": "invalid_input"}',
  'an empty explanation is invalid');
SELECT is((pg_temp.save('ana', 0, false, quote_literal(repeat('ž', 2001))))::text, '{"status": "invalid_input"}',
  'over 2000 code points is invalid');
SELECT is((pg_temp.save('ana', 0, false, quote_literal(' Objašnjenje')))::text, '{"status": "invalid_input"}',
  'a leading space is invalid');
SELECT is((pg_temp.save('ana', 0, false, quote_literal('Obja' || chr(7) || 'šnjenje')))::text,
  '{"status": "invalid_input"}', 'a control character is invalid');
SELECT is((SELECT count(*) FROM declaration.statement), 0::bigint, 'no refused explanation wrote a statement row');
SELECT is(pg_temp.rows(), 0::bigint, 'nor an explanation row');
SELECT is((pg_temp.save('ana', 5, false, quote_literal('Objašnjenje.')))::text,
  (pg_temp.save('ana', 5, false, 'NULL'))::text,
  'a refusal of the declaration itself is answered unchanged, explanation or not');
SELECT is(pg_temp.rows(), 0::bigint, 'and writes no explanation');
ROLLBACK TO SAVEPOINT invalid;

-- 3. A confirmed version's explanation never changes; stale with the version.
SAVEPOINT confirmed;
SELECT is(pg_temp.save('ana', 0, true, quote_literal('Prijenos je bio iz drugog predmeta.'))
  #>> '{statement,state}', 'confirmed', 'the student confirms with an explanation');
SELECT throws_ok($$ UPDATE declaration.mismatch_explanation SET explanation_text = 'x' $$,
  'ZD403', 'append-only row', 'the explanation of a confirmed version cannot be changed');
SELECT throws_ok($$ DELETE FROM declaration.mismatch_explanation $$,
  'ZD403', 'append-only row', 'the explanation of a confirmed version cannot be deleted');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'anon', $$ TRUNCATE declaration.mismatch_explanation $$),
  '^ZD403', 'the explanations cannot be truncated');
INSERT INTO demo_conversation VALUES
  (pg_temp.id('ana'), pg_temp.id('ana'), 'pasted_known', 1, ARRAY[repeat('b',64)]);
SELECT is(pg_temp.read('ana', '{statement,state}'), 'stale', 'a new required conversation makes the version stale');
SELECT is(pg_temp.read('ana', '{statement,mismatchExplanation}'), 'Prijenos je bio iz drugog predmeta.',
  'and its explanation with it');
ROLLBACK TO SAVEPOINT confirmed;

-- 4. Never a gate: the request goes through as without an explanation.
SAVEPOINT gate;
SELECT is(pg_temp.save('ana', 0, true, quote_literal('Objašnjenje.')) #>> '{statement,state}', 'confirmed',
  'the student confirms with an explanation');
SELECT is(pg_temp.submit(), 'requested', 'an explanation never blocks the request');
ROLLBACK TO SAVEPOINT gate;

-- 5. Access: only the owner; never another person, never the web role directly.
SAVEPOINT access;
SELECT is(pg_temp.save('ana', 0, false, quote_literal('Samo moje.')) #>> '{statement,mismatchExplanation}',
  'Samo moje.', 'the student saves an explanation');
SELECT is(pg_temp.read('dora', '{statement,mismatchExplanation}'), NULL, 'a classmate reads nothing of it');
SELECT is((pg_temp.save('dora', 0, false, quote_literal('Tuđe.')))::text, '{"status": "not_found"}',
  'a classmate without a document cannot save anything');
SELECT is(pg_temp.read('tomo', '{status}'), 'not_found', 'a student of another institution finds no declaration');
SELECT is((pg_temp.save('tomo', 0, false, quote_literal('Tuđe.')))::text, '{"status": "not_found"}',
  'nor can save one');
SELECT is(pg_temp.rows(), 1::bigint, 'only the owner''s explanation was written');
SELECT is(substr(pg_temp.ask('ana', s), 1, 5), '42501', 'web role: ' || split_part(s, ' ', 1))
FROM unnest(ARRAY[
  'SELECT explanation_text FROM declaration.mismatch_explanation',
  'UPDATE declaration.mismatch_explanation SET explanation_text = ''x'' RETURNING 1']) s;
ROLLBACK TO SAVEPOINT access;

SELECT * FROM finish();
ROLLBACK;
