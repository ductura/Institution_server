-- SRV-1903 (P-D3): a student withdraws a submission and submits again while
-- the deadline in force lasts. Every submission and withdrawal is written with
-- its own receipt and never changes; after the deadline a withdrawal is
-- refused; the teacher may switch withdrawal off per assignment; an extension
-- (SRV-1108C) moves the boundary. Every person, key, signature, course and
-- date below is invented (fixtures/institution.inc: Vesna teaches K1, Ana and
-- Dora study in it, Tomo is of another institution).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.signing_key
  (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
SELECT k.name, '1', k.domain::uuid, pg_temp.id(k.faculty), 'receipt', 'Ed25519',
  'MCowBQYDK2VwAyEA' || translate(rtrim(encode(decode(repeat(k.byte, 32), 'hex'), 'base64'), '='), '+/', '-_'),
  date_trunc('minute', now()) - interval '1 day'
FROM (VALUES ('key-a', '00000000-0000-4000-8000-0000000000d1', 'fak_a', '11'),
             ('key-other', '00000000-0000-4000-8000-0000000000d2', 'fak_b', '33')) AS k (name, domain, faculty, byte);
RESET ROLE;

CREATE FUNCTION pg_temp.sig(p_key text DEFAULT 'key-a', p_fill text DEFAULT 'A') RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('algorithm', 'Ed25519', 'keyId', p_key, 'keyVersion', '1',
    'signatureEncoding', 'raw', 'signatureBase64Url', repeat(p_fill, 85) || 'A')
$$;
CREATE FUNCTION pg_temp.withdraw(p_actor text, p_key text DEFAULT 'key-a', p_assignment text DEFAULT '{z1}')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.withdraw_submission(%s::uuid, %L, ''1'')', p_assignment, p_key))
$$;
CREATE FUNCTION pg_temp.state(p_actor text DEFAULT 'ana') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT concat_ws(' ', state, revision) FROM app.my_submission_state({z1}) $q$)
$$;
-- kind:attempt:revision:signed per event, oldest first.
CREATE FUNCTION pg_temp.history(p_actor text, p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(string_agg(concat_ws(':', kind, attempt, revision, (signature IS NOT NULL)::text), ' '), '-')
          FROM %s $q$, p_sql))
$$;
CREATE FUNCTION pg_temp.setting(p_actor text, p_allowed text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT allowed::text FROM institution.set_submission_withdrawal({z1}, %s)', p_allowed))
$$;
-- Writes of the given SQL as p_role, rolled back; the answer of the write.
CREATE FUNCTION pg_temp.alone(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    v := pg_temp.ask_as(p_role, 'ana', p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ205';
  EXCEPTION WHEN SQLSTATE 'ZZ205' THEN
    RETURN v;
  END;
END
$$;

-- 1. Catalogue: owners, forced RLS, policies, grants, signatures.
SELECT is((SELECT string_agg(format('%s %s %s %s', c.oid::regclass, pg_get_userbyid(c.relowner),
                                    c.relrowsecurity::text, c.relforcerowsecurity::text), ', ' ORDER BY c.oid::regclass::text)
             FROM pg_class c
            WHERE c.oid IN ('institution.submission_withdrawal_setting'::regclass,
                            'evidence.submission_withdrawal'::regclass,
                            'evidence.submission_withdrawal_receipt'::regclass)),
  'evidence.submission_withdrawal ductus_evidence true true, '
  'evidence.submission_withdrawal_receipt ductus_evidence true true, '
  'institution.submission_withdrawal_setting ductus_identity true true',
  'the three new tables: owners and forced RLS');
SELECT bag_eq(
  $$ SELECT polrelid::regclass::text || ' ' || polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text
       FROM pg_policy
      WHERE polrelid IN ('institution.submission_withdrawal_setting'::regclass,
                         'evidence.submission_withdrawal'::regclass,
                         'evidence.submission_withdrawal_receipt'::regclass) $$,
  ARRAY['institution.submission_withdrawal_setting submission_withdrawal_setting_owner * {ductus_identity}',
        'evidence.submission_withdrawal evidence_submission_withdrawal_owner * {ductus_evidence}',
        'evidence.submission_withdrawal evidence_submission_withdrawal_read r {ductus_app}',
        'evidence.submission_withdrawal_receipt evidence_submission_withdrawal_receipt_owner * {ductus_evidence}'],
  'only the owners'' policies and the student''s own-rows read');
SELECT bag_eq(
  $$ SELECT r || ' ' || p || ' ' || t
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      CROSS JOIN unnest(ARRAY['institution.submission_withdrawal_setting', 'evidence.submission_withdrawal',
                              'evidence.submission_withdrawal_receipt']) t
      WHERE has_table_privilege(r, t, p)
        AND NOT (r = 'ductus_identity' AND t LIKE 'institution.%')
        AND NOT (r = 'ductus_evidence' AND t LIKE 'evidence.%') $$,
  ARRAY['ductus_app SELECT evidence.submission_withdrawal'],
  'besides the owners only the web role reads the withdrawals; nobody writes any of the tables directly');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['app.withdraw_submission(uuid,text,text)', 'app.attach_withdrawal_receipt(uuid,text,jsonb)',
                              'app.submission_history_of(uuid,uuid)', 'app.my_submission_history(uuid)',
                              'app.my_withdrawal_terms(uuid)', 'app.teacher_submission_history(uuid,uuid)',
                              'app.student_withdrawal_terms(uuid)', 'institution.submission_withdrawal_setting(uuid)',
                              'institution.set_submission_withdrawal(uuid,boolean)',
                              'institution.withdrawal_setting_of(uuid)', 'evidence.submission_withdrawn(uuid)',
                              'evidence.request_live(uuid,uuid)']) f
      WHERE has_function_privilege(r, f, 'EXECUTE')
        AND NOT (r = 'ductus_evidence' AND f IN ('app.withdraw_submission(uuid,text,text)',
                 'app.attach_withdrawal_receipt(uuid,text,jsonb)', 'app.submission_history_of(uuid,uuid)',
                 'evidence.submission_withdrawn(uuid)', 'evidence.request_live(uuid,uuid)'))
        AND NOT (r = 'ductus_identity' AND f IN ('app.my_submission_history(uuid)', 'app.my_withdrawal_terms(uuid)',
                 'app.teacher_submission_history(uuid,uuid)', 'app.student_withdrawal_terms(uuid)',
                 'institution.submission_withdrawal_setting(uuid)', 'institution.set_submission_withdrawal(uuid,boolean)',
                 'institution.withdrawal_setting_of(uuid)')) $$,
  ARRAY['ductus_app app.withdraw_submission(uuid,text,text)', 'ductus_app app.attach_withdrawal_receipt(uuid,text,jsonb)',
        'ductus_app app.my_submission_history(uuid)', 'ductus_app app.my_withdrawal_terms(uuid)',
        'ductus_app app.teacher_submission_history(uuid,uuid)', 'ductus_app app.student_withdrawal_terms(uuid)',
        'ductus_app institution.submission_withdrawal_setting(uuid)',
        'ductus_app institution.set_submission_withdrawal(uuid,boolean)',
        'ductus_evidence app.student_withdrawal_terms(uuid)', 'ductus_identity app.submission_history_of(uuid,uuid)'],
  'who executes what, besides the owners');
SELECT is_empty(
  $$ SELECT oid::regprocedure::text FROM pg_proc
      WHERE oid IN ('app.withdraw_submission(uuid,text,text)'::regprocedure,
                    'app.attach_withdrawal_receipt(uuid,text,jsonb)'::regprocedure,
                    'app.submission_history_of(uuid,uuid)'::regprocedure,
                    'app.my_submission_history(uuid)'::regprocedure, 'app.my_withdrawal_terms(uuid)'::regprocedure,
                    'app.teacher_submission_history(uuid,uuid)'::regprocedure,
                    'app.student_withdrawal_terms(uuid)'::regprocedure,
                    'institution.submission_withdrawal_setting(uuid)'::regprocedure,
                    'institution.set_submission_withdrawal(uuid,boolean)'::regprocedure)
        AND (NOT prosecdef OR NOT 'search_path=""' = ANY (proconfig)) $$,
  'every RPC is SECURITY DEFINER with an empty search_path');
SELECT is(pg_get_function_arguments('app.withdraw_submission(uuid,text,text)'::regprocedure),
  'p_assignment_id uuid, p_key_id text, p_key_version text',
  'a withdrawal names no person, institution, time, submission or payload');
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint
            WHERE conrelid = 'evidence.submission_request'::regclass AND conname = 'evidence_submission_request_attempt_key'),
  'UNIQUE (assignment_id, institution_id, principal_id, attempt)', 'a request is one per student, assignment and attempt');
SELECT is_empty(
  $$ SELECT conname FROM pg_constraint
      WHERE conrelid IN ('evidence.submission'::regclass, 'evidence.submission_request'::regclass) AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (assignment_id, institution_id, principal_id)' $$,
  'neither table keeps one row per student and assignment');

-- 2. Ana's first submission: revision 1, requested and recorded.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
                       repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'requested 1', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
INSERT INTO ref SELECT 's1', id::text FROM evidence.submission;
SELECT is((SELECT attempt FROM evidence.submission_request), 1, 'the first request is attempt 1');
SELECT is((SELECT bool_or(accepts_evidence)::text FROM evidence.package WHERE document_id = 'doc-a'), 'false',
  'the submission closed her package');

-- Before its receipt is bound, the submission is not withdrawn.
SELECT is(pg_temp.withdraw('ana'), 'pending', 'a submission without a bound receipt is not withdrawn');
INSERT INTO ref SELECT 'i1', pg_temp.ask('ana', $$ SELECT issuance_id::text
  FROM app.prepare_submission_receipt({s1}::uuid, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.attach_submission_receipt({i1}::uuid, %L, %L::jsonb)',
    (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance), pg_temp.sig()::text)),
  'attached', 'fixture: her receipt is bound');
SELECT is(pg_temp.state(), 'potvrdeno 1', 'Ana''s submission is confirmed');

-- 3. Who may withdraw: only the student, of her own submission.
SELECT is(pg_temp.withdraw(a.name), a.result, a.name || ': ' || a.result)
FROM (VALUES ('anon', 'unauthorized'), ('expired', 'unauthorized'), ('closed', 'unauthorized'),
             ('vesna', 'not_found'), ('marko', 'not_found'), ('tomo', 'not_found'), ('dora', 'none')) AS a (name, result);
SELECT is(pg_temp.withdraw('ana', 'key-a', '{nobody}'), 'not_found', 'an unknown assignment is not found');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.withdraw_submission({z1}::uuid, '', '1') $$), 'invalid',
  'a key id of the wrong form is invalid');

-- 4. The switch: on by default, only the teacher of the assignment sets it.
SELECT is(pg_temp.ask('vesna', $$ SELECT concat_ws(' ', allowed, changed_at IS NULL)
  FROM institution.submission_withdrawal_setting({z1}) $$), 't t', 'by default withdrawal is allowed');
SELECT matches(pg_temp.setting(a.name, 'false'), '^ZD40[13]', a.name || ' may not switch it')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('tomo'), ('iva'), ('anon')) AS a (name);
SELECT matches(pg_temp.ask('marko', $$ SELECT allowed::text FROM institution.submission_withdrawal_setting({z1}) $$),
  '^ZD403', 'a teacher of another course does not read it');
SELECT is(pg_temp.setting('vesna', 'NULL'), 'ZD422: invalid input', 'the switch is true or false');
SELECT is(pg_temp.setting('vesna', 'false'), 'false', 'Vesna switches withdrawal off on Z1');
SELECT is(pg_temp.withdraw('ana'), 'disabled', 'switched off: the withdrawal is refused (409 on the wire)');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws(' ', outcome, allowed) FROM app.my_withdrawal_terms({z1}) $$),
  'found f', 'Ana''s terms show it');
SELECT is(pg_temp.setting('vesna', 'false'), 'false', 'setting the value in force again changes nothing');
SELECT is((SELECT count(*)::integer FROM institution.submission_withdrawal_setting), 1, 'so one record');
SELECT is(pg_temp.setting('vesna', 'true'), 'true', 'Vesna switches it on again');
SELECT is(pg_temp.state(), 'potvrdeno 1', 'the refusals changed nothing');

-- 5. The deadline: Z1 gets a version 3 whose deadline passed yesterday.
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now() - interval '2 days',
          now() - interval '1 day', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
VALUES (pg_temp.id('z1'), 3, pg_temp.id('ana'), pg_temp.id('fak_a'));
RESET ROLE;
SELECT is(pg_temp.withdraw('ana'), 'after_deadline', 'after the deadline in force the withdrawal is refused');
SELECT is((SELECT count(*)::integer FROM evidence.submission_withdrawal), 0, 'and nothing is written');
SELECT is(pg_temp.history('ana', 'app.my_submission_history({z1})'), 'submission:1:1:true',
  'her history is the one confirmed submission');

-- 6. An extension (SRV-1108C) moves the boundary.
SELECT is(pg_temp.ask('vesna', $$ SELECT earlier_submissions::text
  FROM institution.extend_assignment_deadline({z1}, {ana}, now() + interval '1 day', 'justified') $$), 'true',
  'Vesna extends Ana''s deadline to tomorrow');
SELECT is(pg_temp.withdraw('ana', 'key-other'), 'key_unavailable', 'a key of another institution does not sign');
SELECT is((SELECT count(*)::integer FROM evidence.submission_withdrawal), 0, 'and nothing is written');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws(' ', outcome, signature IS NULL)
  FROM app.withdraw_submission({z1}::uuid, 'key-a', '1') $$), 'withdrawn t',
  'within her extended deadline Ana withdraws');
INSERT INTO ref SELECT 'w1', id::text FROM evidence.submission_withdrawal;

-- The withdrawal and its frozen receipt.
SELECT is((SELECT concat_ws(' ', w.submission_id = pg_temp.id('s1'), w.principal_id = pg_temp.id('ana'),
                            w.due_at - now(), w.withdrawn_at <= w.signed_at, w.key_id)
             FROM evidence.submission_withdrawal w), 't t 1 day t key-a',
  'the row names her submission, the deadline in force and the key');
SELECT is((SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(
             (SELECT receipt_payload::jsonb FROM evidence.submission_withdrawal)) k),
  ARRAY['assignmentId', 'dueAt', 'evidenceDomainId', 'principalId', 'receiptSchema', 'signedAt', 'submissionId',
        'submissionReceiptSha256', 'withdrawalId', 'withdrawnAt'],
  'the receipt carries exactly these fields');
SELECT is((SELECT concat_ws(' ', p ->> 'receiptSchema', p ->> 'withdrawalId' = w.id::text,
                            p ->> 'submissionId' = w.submission_id::text,
                            p ->> 'submissionReceiptSha256' = r.payload_digest_sha256,
                            p ->> 'evidenceDomainId', p ->> 'principalId' = w.principal_id::text,
                            p ->> 'assignmentId' = w.assignment_id::text,
                            p ->> 'withdrawnAt' = to_char(w.withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                            p ->> 'dueAt' = to_char(w.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
             FROM evidence.submission_withdrawal w
             JOIN evidence.submission_receipt r ON r.submission_id = w.submission_id
             CROSS JOIN LATERAL (SELECT w.receipt_payload::jsonb) j (p)),
  'ductus-submission-withdrawal-receipt-v1 t t t 00000000-0000-4000-8000-0000000000d1 t t t t',
  'it names the withdrawal, the submission and the digest of its receipt');
SELECT ok((SELECT receipt_payload !~ '[ \n]' AND left(receipt_payload, 16) = '{"assignmentId":'
                  AND payload_digest_sha256 = encode(sha256(convert_to(receipt_payload, 'UTF8')), 'hex')
             FROM evidence.submission_withdrawal),
  'the frozen text is compact, in key order, and its digest is its SHA-256');

-- What changed with it: the package accepts again, the state is none.
SELECT is((SELECT bool_and(accepts_evidence)::text FROM evidence.package WHERE document_id = 'doc-a'), 'true',
  'her package accepts evidence again');
SELECT is(pg_temp.state(), 'none', 'Ana has no valid submission now');
SELECT is(pg_temp.ask('ana', $$ SELECT app.work_submitted({z1})::text $$), 'false', 'the work is not submitted');
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT app.document_submitted('doc-a')::text $$), 'false',
  'nor the document (collaboration and live state may continue)');
SELECT is(pg_temp.ask('ana', $$ SELECT coalesce(submitted_revision::text, '-') FROM app.student_workspace()
  WHERE assignment_id = {z1} $$), '-', 'her workspace shows no submission');
SELECT is(pg_temp.ask('vesna', $$ SELECT submitted::text FROM app.assignment_submissions({z1}) WHERE student_id = {ana} $$),
  'false', 'Vesna''s list shows her as not submitted');
SELECT is(pg_temp.history('vesna', 'app.teacher_submission_history({z1}, {ana})'),
  'submission:1:1:true withdrawal:1:1:false', 'Vesna sees the submission and the withdrawal');

-- 7. The withdrawal receipt is bound once, as a submission receipt.
CREATE FUNCTION pg_temp.attach(p_actor text, p_signature jsonb, p_digest text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.attach_withdrawal_receipt({w1}::uuid, %L, %L::jsonb)',
    coalesce(p_digest, (SELECT payload_digest_sha256 FROM evidence.submission_withdrawal)), p_signature::text))
$$;
SELECT is(pg_temp.attach('anon', pg_temp.sig()), 'unauthorized', 'no session');
SELECT is(pg_temp.attach('dora', pg_temp.sig()), 'not_found', 'another student''s withdrawal is not found');
SELECT is(pg_temp.attach('ana', pg_temp.sig() - 'algorithm'), 'invalid', 'an envelope without a field is invalid');
SELECT is(pg_temp.attach('ana', pg_temp.sig() || '{"signatureBase64Url":"x"}'), 'invalid', 'a short signature too');
SELECT is(pg_temp.attach('ana', pg_temp.sig(), repeat('0', 64)), 'digest_mismatch', 'another digest is refused');
SELECT is(pg_temp.attach('ana', pg_temp.sig('key-other')), 'key_mismatch', 'another key is refused');
SELECT is((SELECT count(*)::integer FROM evidence.submission_withdrawal_receipt), 0, 'nothing is bound yet');
SELECT is(pg_temp.attach('ana', pg_temp.sig()), 'attached', 'the signature of the frozen key and digest is bound');
SELECT is(pg_temp.attach('ana', pg_temp.sig('key-a', 'B')), 'existing', 'a second signature returns the first');
SELECT is((SELECT signature FROM evidence.submission_withdrawal_receipt), pg_temp.sig(), 'which stays bound');
SELECT is(pg_temp.ask('ana', $$ SELECT concat_ws(' ', outcome, withdrawal_id = {w1}, signature IS NOT NULL)
  FROM app.withdraw_submission({z1}::uuid, 'key-a', '1') $$), 'existing t t',
  'withdrawing again returns the same withdrawal with its signature');

-- 8. History is never changed, not even by the owner roles.
SELECT matches(pg_temp.alone(t.role, t.sql), '^ZD403', t.label)
FROM (VALUES
  ('ductus_evidence', $$ UPDATE evidence.submission_withdrawal SET due_at = now() + interval '9 days' RETURNING 1 $$,
   'a withdrawal is not changed'),
  ('ductus_evidence', $$ DELETE FROM evidence.submission_withdrawal RETURNING 1 $$, 'nor deleted'),
  ('ductus_evidence', $$ UPDATE evidence.submission_withdrawal_receipt SET signature = signature RETURNING 1 $$,
   'a bound signature is not changed'),
  ('ductus_evidence', $$ DELETE FROM evidence.submission_withdrawal_receipt RETURNING 1 $$, 'nor deleted'),
  ('ductus_evidence', $$ DELETE FROM evidence.submission RETURNING 1 $$, 'the withdrawn submission is not deleted'),
  ('ductus_evidence', $$ UPDATE evidence.submission_request SET attempt = 2 RETURNING 1 $$,
   'an attempt is not renumbered'),
  ('ductus_identity', $$ UPDATE institution.submission_withdrawal_setting SET allowed = false RETURNING 1 $$,
   'a switch record is not changed'),
  ('ductus_identity', $$ DELETE FROM institution.submission_withdrawal_setting RETURNING 1 $$, 'nor deleted')
) AS t (role, sql, label);
SELECT matches(pg_temp.alone('ductus_app', s.sql), '^42501', s.label)
FROM (VALUES
  ($$ INSERT INTO evidence.submission_withdrawal SELECT * FROM evidence.submission_withdrawal RETURNING 1 $$,
   'the web role writes no withdrawal'),
  ($$ SELECT count(*)::text FROM evidence.submission_withdrawal_receipt $$, 'nor reads the bound signatures'),
  ($$ INSERT INTO institution.submission_withdrawal_setting (institution_id, assignment_id, allowed, created_by)
      VALUES ({fak_a}, {z1}, false, {vesna}) RETURNING 1 $$, 'nor writes a switch')
) AS s (sql, label);
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM evidence.submission_withdrawal $$), '0',
  'Dora does not read Ana''s withdrawal');
SELECT matches(pg_temp.ask('dora', $$ SELECT count(*)::text FROM app.teacher_submission_history({z1}, {ana}) $$),
  '^ZD403', 'nor her history through the teacher''s reader');
SELECT matches(pg_temp.ask('marko', $$ SELECT count(*)::text FROM app.teacher_submission_history({z1}, {ana}) $$),
  '^ZD403', 'nor does a teacher of another course');
SELECT matches(pg_temp.ask('vesna', $$ SELECT count(*)::text FROM app.my_submission_history({z1}) $$),
  '^ZD403', 'the student''s reader is the student''s own');

-- 9. Ana works on and submits again: attempt 2.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-2',
    pg_temp.descriptor(p_segment => 'segment-a-2', p_sequence_from => 2, p_sequence_to => 2,
                       p_hash => repeat('c', 64), p_predecessor => repeat('b', 64)),
    1, repeat('d', 64), repeat('e', 64), repeat('c', 64)), 'reserved', 'Ana commits revision 2 after withdrawing');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 2) $$),
  'requested 2', 'and requests it: a new request');
SELECT is((SELECT string_agg(attempt || ':' || revision, ' ' ORDER BY attempt) FROM evidence.submission_request),
  '1:1 2:2', 'attempt 2 names revision 2; attempt 1 is unchanged');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'existing 2', 'a second click returns the live request, as before');
SELECT is(pg_temp.withdraw('ana'), 'none', 'a request not recorded yet is not withdrawn');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request WHERE attempt = 2), %L)',
    pg_temp.h('e'))), 'recorded', 'her second submission is recorded');
SELECT is((SELECT bool_or(accepts_evidence)::text FROM evidence.package WHERE document_id = 'doc-a'), 'false',
  'and closes her package again');
SELECT is(pg_temp.state(), 'ceka 2', 'her valid submission is now revision 2, waiting for its receipt');
SELECT is(pg_temp.ask('vesna', $$ SELECT concat_ws(' ', submitted, revision, after_deadline)
  FROM app.assignment_submissions({z1}) WHERE student_id = {ana} $$), 't 2 f',
  'Vesna sees the last valid submission, on time against Ana''s deadline');
SELECT is(pg_temp.history('vesna', 'app.teacher_submission_history({z1}, {ana})'),
  'submission:1:1:true withdrawal:1:1:true submission:2:2:false', 'and the whole history, oldest first');
SELECT is(pg_temp.history('ana', 'app.my_submission_history({z1})'),
  'submission:1:1:true withdrawal:1:1:true submission:2:2:false', 'Ana sees the same');
SELECT is((SELECT count(*)::integer FROM evidence.submission_withdrawal), 1, 'the first withdrawal is kept');
SELECT is((SELECT count(*)::integer FROM evidence.submission), 2, 'both submissions are kept');
SELECT is((SELECT count(*)::integer FROM evidence.submission_receipt), 1, 'and the first submission''s receipt');

-- 10. Switched off, a confirmed second submission stays.
INSERT INTO ref SELECT 's2', id::text FROM evidence.submission
 WHERE submission_request_id = (SELECT id FROM evidence.submission_request WHERE attempt = 2);
INSERT INTO ref SELECT 'i2', pg_temp.ask('ana', $$ SELECT issuance_id::text
  FROM app.prepare_submission_receipt({s2}::uuid, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.attach_submission_receipt({i2}::uuid, %L, %L::jsonb)',
    (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance WHERE id = pg_temp.id('i2')),
    pg_temp.sig()::text)), 'attached', 'fixture: the second receipt is bound');
-- An extension never shortens a deadline (SRV-1509: the latest of them), so
-- the switch closes the second round here.
SELECT is(pg_temp.setting('vesna', 'false'), 'false', 'Vesna switches withdrawal off again');
SELECT is(pg_temp.withdraw('ana'), 'disabled', 'the confirmed second submission is not withdrawn');
SELECT is(pg_temp.state(), 'potvrdeno 2', 'her second submission stays valid');
SELECT is((SELECT count(*)::integer FROM evidence.submission_withdrawal), 1, 'and no withdrawal is written');

SELECT * FROM finish();
ROLLBACK;
