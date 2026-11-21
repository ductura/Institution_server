-- SRV-1213 (B1): the teacher of a course reads the declaration bound to a
-- student's live submission; the read is logged with the surface
-- 'declaration'. Every person, key, signature, course and text below is
-- invented (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in
-- it, Marko teaches K2, Tomo is of another institution).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.signing_key
  (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
VALUES ('key-a', '1', '00000000-0000-4000-8000-0000000000d1', pg_temp.id('fak_a'), 'receipt', 'Ed25519',
  'MCowBQYDK2VwAyEA' || translate(rtrim(encode(decode(repeat('11', 32), 'hex'), 'base64'), '='), '+/', '-_'),
  date_trunc('minute', now()) - interval '1 day');
RESET ROLE;

CREATE FUNCTION pg_temp.statement_form() RETURNS text LANGUAGE sql AS $$
  SELECT '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}'
$$;
CREATE FUNCTION pg_temp.statement_body() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'baseVersion', 0, 'revision', 1, 'confirm', true,
    'form', jsonb_build_object('formId','test-izjava','formVersion',1,
      'formSha256',pg_temp.sha(pg_temp.statement_form())),
    'ownWork', '{"confirmed":true}'::jsonb,
    'humanHelp', '{"received":false,"entries":[]}'::jsonb,
    'ai', '{"use":"not_used","attachments":[],"declaredTools":[],"externalAttachmentIds":[]}'::jsonb)
$$;
-- state, digest, payload digest of the teacher's read; the error otherwise.
CREATE FUNCTION pg_temp.read(p_actor text, p_student text DEFAULT '{ana}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT concat_ws(' ', state, coalesce(declaration_sha256, '-'),
                         coalesce(encode(sha256(convert_to(payload_jcs, 'UTF8')), 'hex'), '-'))
          FROM app.teacher_declaration({z1}, %s) $q$, p_student))
$$;
CREATE FUNCTION pg_temp.logged() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(concat_ws(':', u.name, l.reader_role, l.document_id), ' ' ORDER BY u.name), '-')
    FROM audit.access_log l
    JOIN ref u ON u.val = l.reader_id::text
   WHERE l.surface = 'declaration'
$$;

-- 1. Catalogue.
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
                     || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig)), ', ' ORDER BY p.proname)
     FROM pg_proc p
    WHERE p.oid IN ('app.bound_declaration_of(uuid,uuid)'::regprocedure,
                    'app.teacher_declaration(uuid,uuid)'::regprocedure)),
  'app.bound_declaration_of(uuid,uuid) ductus_evidence true true, '
  || 'app.teacher_declaration(uuid,uuid) ductus_identity true true',
  'owners, SECURITY DEFINER and an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['app.bound_declaration_of(uuid,uuid)', 'app.teacher_declaration(uuid,uuid)']) f
      WHERE has_function_privilege(r, f, 'EXECUTE')
        AND NOT (r = 'ductus_evidence' AND f = 'app.bound_declaration_of(uuid,uuid)')
        AND NOT (r = 'ductus_identity' AND f = 'app.teacher_declaration(uuid,uuid)') $$,
  ARRAY['ductus_app app.teacher_declaration(uuid,uuid)', 'ductus_identity app.bound_declaration_of(uuid,uuid)'],
  'only the app reads through the teacher''s RPC; only identity calls the helper');
SELECT is(pg_get_function_arguments('app.teacher_declaration(uuid,uuid)'::regprocedure),
  'p_assignment_id uuid, p_student_id uuid', 'the reader names no institution or reader');
SELECT is((SELECT concat_ws(' ', convalidated, pg_get_constraintdef(oid) LIKE '%''submitted_text''%''declaration''%')
             FROM pg_constraint WHERE conname = 'access_log_surface_check'
              AND conrelid = 'audit.access_log'::regclass), 't t',
  'the surface list grows by declaration and stays validated');

-- 2. Before a submission there is nothing to read and nothing is logged.
SELECT is(pg_temp.call('ana', 'pkg-a', 'req-statement', pg_temp.descriptor(), 0,
  repeat('a', 64), repeat('d', 64), repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
INSERT INTO ref SELECT 'saved', pg_temp.ask('ana', format('SELECT declaration.save_statement(%L, %L::jsonb, %L)',
  pg_temp.id('z1'), pg_temp.statement_body(), pg_temp.statement_form()));
SELECT is((SELECT val::jsonb #>> '{statement,state}' FROM ref WHERE name = 'saved'), 'confirmed',
  'fixture: Ana confirms her declaration');
SELECT is(pg_temp.read('vesna'), 'none - -', 'a confirmed but unsubmitted declaration is not the teacher''s');
SELECT is(pg_temp.logged(), '-', 'and nothing is logged');

-- 3. Submitted: Vesna reads exactly the bound declaration.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
SELECT is(pg_temp.read('vesna'),
  'bound ' || (SELECT val::jsonb #>> '{statement,declarationSha256}' FROM ref WHERE name = 'saved') || ' '
  || (SELECT encode(sha256(convert_to(payload_jcs, 'UTF8')), 'hex') FROM declaration.statement WHERE payload_jcs IS NOT NULL),
  'the teacher of the course reads the bound declaration and its digest');
SELECT is(pg_temp.logged(), 'vesna:teacher:doc-a', 'the read is logged as a teacher''s, on the declaration surface');

-- 4. Nobody else reads it, and nothing more is logged.
SELECT matches(pg_temp.read(a.name), '^ZD40[13]', a.name || ' does not read Ana''s declaration')
FROM (VALUES ('ana'), ('dora'), ('marko'), ('tomo'), ('iva'), ('anon')) AS a (name);
SELECT matches(pg_temp.read('vesna', '{dora}'), '^none', 'Dora submitted nothing');
SELECT matches(pg_temp.read('vesna', '{tomo}'), '^ZD403', 'a student outside the course is refused');
SELECT matches(pg_temp.read('vesna', 'NULL'), '^ZD403', 'no student is refused');
SELECT is(pg_temp.logged(), 'vesna:teacher:doc-a', 'the refusals wrote nothing');
SELECT matches(pg_temp.ask('vesna', 'SELECT count(*)::text FROM app.bound_declaration_of({z1}, {ana})'),
  '^42501', 'the session cannot call the helper itself');
SELECT is(pg_get_function_arguments('app.bound_declaration_of(uuid,uuid)'::regprocedure),
  'p_assignment_id uuid, p_student_id uuid', 'the helper takes the institution from the session, not from its caller');

-- 5. Withdrawn: the declaration is no longer the teacher's.
INSERT INTO ref SELECT 's1', id::text FROM evidence.submission;
INSERT INTO ref SELECT 'i1', pg_temp.ask('ana', $$ SELECT issuance_id::text
  FROM app.prepare_submission_receipt({s1}::uuid, 'key-a', '1') $$);
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.attach_submission_receipt({i1}::uuid, %L, %L::jsonb)',
    (SELECT payload_digest_sha256 FROM evidence.submission_receipt_issuance),
    jsonb_build_object('algorithm', 'Ed25519', 'keyId', 'key-a', 'keyVersion', '1',
      'signatureEncoding', 'raw', 'signatureBase64Url', repeat('A', 86))::text)),
  'attached', 'fixture: her receipt is bound');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.withdraw_submission({z1}::uuid, 'key-a', '1') $$),
  'withdrawn', 'fixture: Ana withdraws');
SELECT is(pg_temp.read('vesna'), 'none - -', 'a withdrawn submission carries no declaration for the teacher');
SELECT is(pg_temp.logged(), 'vesna:teacher:doc-a', 'and that read is not logged');

SELECT * FROM finish();
ROLLBACK;
