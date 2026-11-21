-- SRV-1312 (plan M7.10): the three existing reads behind
-- student.portable-record.get (server/database/portable-record), run in one
-- session as the adapter runs them. Two invented students of the same course:
-- Ana, whose submission it is, gets her receipt, the exact submitted text
-- (whose SHA-256 is the receipt's artifact hash) and the receipt key; Dora,
-- her coursemate, gets not_found at the first read and so nothing else. No
-- new function: only the answers the portable record relies on. Every
-- person, key, text and signature below is invented.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Fixture: Ana's submission of doc-a at revision 1, text repeat('d', 64), bound to key-a.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64), repeat('b', 64)),
  'reserved', 'fixture: revision one exists');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested', 'fixture: request');
SELECT is(pg_temp.ask('ana', format('SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)',
  pg_temp.h('d'))), 'recorded', 'fixture: recorded submission');
INSERT INTO ref SELECT 'submission', id::text FROM evidence.submission;
INSERT INTO ref VALUES ('text', pg_temp.h('d'));
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.signing_key
  (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
VALUES ('key-a', '1', '00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'receipt', 'Ed25519',
  'MCowBQYDK2VwAyEA' || translate(rtrim(encode(decode(repeat('11', 32), 'hex'), 'base64'), '='), '+/', '-_'),
  date_trunc('minute', now()) - interval '1 day');
RESET ROLE;

-- 1. Before a receipt is bound the record has nothing to give: none, as not_found to the route.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.read_submission_receipt({submission}::uuid) $$),
  'none', 'no bound receipt yet: none');

INSERT INTO ref SELECT 'i1', pg_temp.ask('ana',
  $$ SELECT issuance_id::text FROM app.prepare_submission_receipt({submission}::uuid, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.attach_submission_receipt({i1}::uuid,
    (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance WHERE id = {i1}::uuid),
    jsonb_build_object('algorithm', 'Ed25519', 'keyId', 'key-a', 'keyVersion', '1',
      'signatureEncoding', 'raw', 'signatureBase64Url', repeat('A', 86))) $$),
  'attached', 'fixture: the receipt is bound');

-- 2. Ana: her receipt, which names doc-a, revision 1 and the hash of the text.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.read_submission_receipt({submission}::uuid) $$),
  'found', 'the owner reads her receipt');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('|', p->>'documentId', p->>'revision', p->>'artifactSha256',
    p->>'submissionId') FROM (SELECT receipt_payload::jsonb AS p
    FROM app.read_submission_receipt({submission}::uuid)) r $$),
  concat_ws('|', 'doc-a', '1', pg_temp.h('d'), (SELECT val FROM ref WHERE name = 'submission')),
  'the receipt names the work, the revision and the hash of the text');

-- 3. Ana: the exact stored text of that revision, whose SHA-256 is the receipt's.
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('|', outcome, revision, kind, body)
    FROM app.read_work_export('doc-a', 1) $$),
  concat_ws('|', 'found', '1', 'submitted', repeat('d', 64)), 'the owner reads the submitted text');
SELECT is(pg_temp.ask('ana', $$ SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex')
    FROM app.read_work_export('doc-a', 1) $$),
  pg_temp.h('d'), 'the text hashes to the artifact hash of the receipt');

-- 4. Ana: the key the receipt is signed with, from the read of the public check.
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws('|', outcome, key_purpose, key_evidence_domain_id)
    FROM app.public_receipt_verification({submission}::uuid, {text}) $$),
  'match|receipt|00000000-0000-4000-8000-0000000000d1', 'the owner reads the receipt key');

-- 5. Dora, a student of the same course, and Tomo of another institution: the
--    first read is not_found, the same as an unknown id, so the route stops there.
SELECT is(pg_temp.ask(v.actor, $$ SELECT concat_ws('|', outcome, receipt_payload, payload_digest_sha256, signature::text)
    FROM app.read_submission_receipt({submission}::uuid) $$), 'not_found', v.what)
FROM (VALUES
  (1, 'dora', 'a coursemate does not read the receipt'),
  (2, 'tomo', 'a student of another institution does not read the receipt'),
  (3, 'vesna', 'the teacher of the course does not read it through the student read')
) AS v (n, actor, what)
ORDER BY v.n;
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.read_submission_receipt('00000000-0000-4000-8000-0000000000ff'::uuid) $$),
  'not_found', 'an unknown submission is the same not_found');
SELECT is(pg_temp.ask('dora', $$ SELECT outcome FROM app.read_work_export('doc-a', 1) $$),
  'not_found', 'a coursemate does not read the submitted text either');

-- 6. Read only: nothing was written by any read.
SELECT is((SELECT count(*) FROM evidence.submission_receipt), 1::bigint, 'still one bound receipt');

SELECT * FROM finish();
ROLLBACK;
