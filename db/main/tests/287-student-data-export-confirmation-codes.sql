-- F4-1.1-4-6-SRV (Dizajn 1.1, val 2; continues SRV#964): the worker's read of
-- the confirmation codes for the package of an approved student data export.
-- Ana and Dora of fak-a each submitted Z1, Tomo of fak-b submitted Z3, and
-- each submission has a bound code. Ana's export reads Ana's code alone, only
-- while it is approved, and only the worker reads it. Every person, code and
-- reference is invented (fixtures/institution.inc and evidence-acceptance.inc).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE TEMP TABLE due AS
SELECT pg_temp.id('z1') AS z1, (SELECT due_at FROM institution.assignment_version
                                  WHERE assignment_id = pg_temp.id('z1') AND version_no = 2) AS z1_due,
       (SELECT due_at FROM institution.assignment_version
         WHERE assignment_id = pg_temp.id('z3') AND version_no = 1) AS z3_due;
GRANT SELECT ON due TO PUBLIC;

SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.sha(repeat('d', 64)));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT r.doc, pg_temp.id(r.fak), r.revision, nullif(r.revision - 1, -1), pg_temp.id(r.who), pg_temp.sha(r.body)
  FROM (VALUES ('doc-a', 'fak_a', 1, 'ana', 'Izmišljeni predani tekst Ane.'),
               ('doc-b', 'fak_b', 1, 'tomo', 'Izmišljeni predani tekst Tome.'),
               ('doc-d', 'fak_a', 0, 'dora', repeat('d', 64)),
               ('doc-d', 'fak_a', 1, 'dora', 'Izmišljeni predani tekst Dore.')
  ) AS r (doc, fak, revision, who, body);
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body, content_hash, created_at)
SELECT r.doc, pg_temp.id(r.fak), 1, r.body, pg_temp.sha(r.body), now()
  FROM (VALUES ('doc-a', 'fak_a', 'Izmišljeni predani tekst Ane.'),
               ('doc-b', 'fak_b', 'Izmišljeni predani tekst Tome.'),
               ('doc-d', 'fak_a', 'Izmišljeni predani tekst Dore.')
  ) AS r (doc, fak, body);
INSERT INTO evidence.submission_request (
  id, institution_id, assignment_id, assignment_version, project_id, document_id, principal_id,
  revision, content_hash, requested_at
)
SELECT r.id::uuid, pg_temp.id(r.fak), pg_temp.id(r.z), r.version, r.project, r.doc, pg_temp.id(r.who),
       1, pg_temp.sha(r.body), r.at
  FROM due, LATERAL (VALUES
    ('00000000-0000-4000-8000-0000000002e1', 'fak_a', 'z1', 2, 'project-a', 'doc-a', 'ana', 'Izmišljeni predani tekst Ane.',
     due.z1_due - interval '1 day'),
    ('00000000-0000-4000-8000-0000000002e2', 'fak_a', 'z1', 2, 'project-d', 'doc-d', 'dora', 'Izmišljeni predani tekst Dore.',
     due.z1_due - interval '2 days'),
    ('00000000-0000-4000-8000-0000000002e3', 'fak_b', 'z3', 1, 'project-b', 'doc-b', 'tomo', 'Izmišljeni predani tekst Tome.',
     due.z3_due - interval '1 day')
  ) AS r (id, fak, z, version, project, doc, who, body, at);
INSERT INTO evidence.submission (
  submission_request_id, institution_id, principal_id, assignment_id, assignment_version, revision,
  artifact_hash, requested_at, due_at, recorded_at
)
SELECT q.id, q.institution_id, q.principal_id, q.assignment_id, q.assignment_version, q.revision,
       q.content_hash, q.requested_at, CASE WHEN q.assignment_id = due.z1 THEN due.z1_due ELSE due.z3_due END,
       q.requested_at + interval '2 seconds'
  FROM evidence.submission_request q, due
 WHERE q.id::text LIKE '00000000-0000-4000-8000-0000000002e%';
-- Dora's and Tomo's codes; Ana's submission still waits for its receipt, so
-- it has none yet (step 3 binds it).
INSERT INTO evidence.submission_confirmation_code (submission_id, institution_id, principal_id, code)
SELECT s.id, s.institution_id, s.principal_id, c.code
  FROM evidence.submission s
  JOIN (VALUES ('dora', 'DDDD-0000-1111-2222'), ('tomo', 'TTTT-0000-1111-2222')) AS c (who, code)
    ON s.principal_id = pg_temp.id(c.who)
 WHERE s.submission_request_id::text LIKE '00000000-0000-4000-8000-0000000002e%';
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

-- The exports, written as the operator: Ana's approved, Dora's still
-- requested. Boris stands in for the clerk who requested, Iva approved.
INSERT INTO app.student_data_export (id, institution_id, student_id, status, requested_by, identity_check_ref,
                                     approved_by, approved_at, job_ref)
VALUES
  ('00000000-0000-4000-8000-0000000002f1', pg_temp.id('fak_a'), pg_temp.id('ana'), 'approved', pg_temp.id('boris'),
   'osobna iskaznica: Provjera 1/2026', pg_temp.id('iva'), now(), 'Posao 1/2026'),
  ('00000000-0000-4000-8000-0000000002f2', pg_temp.id('fak_a'), pg_temp.id('dora'), 'requested', pg_temp.id('boris'),
   'osobna iskaznica: Provjera 2/2026', NULL, NULL, NULL);

CREATE FUNCTION pg_temp.work(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql) $$;
CREATE FUNCTION pg_temp.codes(p_export text) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(pg_temp.work(format(
    'SELECT string_agg(code, '';'' ORDER BY code) FROM app.worker_student_data_export_confirmation_codes(%s)',
    p_export)), 'none')
$$;

-- 1. Catalogue: the evidence role owns it, SECURITY DEFINER with an empty
-- search_path, it returns the submission id and the code alone, and only the
-- worker (and the owner) executes it.
SELECT is(
  (SELECT pg_get_userbyid(p.proowner) || ' ' || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig))
     FROM pg_proc p WHERE p.oid = 'app.worker_student_data_export_confirmation_codes(uuid)'::regprocedure),
  'ductus_evidence true true', 'owner of the codes, SECURITY DEFINER and an empty search_path');
SELECT is(pg_get_function_result('app.worker_student_data_export_confirmation_codes(uuid)'::regprocedure),
  'TABLE(submission_id uuid, code text)', 'the read carries the submission id and its code only');
SELECT is(pg_get_function_arguments('app.worker_student_data_export_confirmation_codes(uuid)'::regprocedure),
  'p_export_id uuid', 'the read takes the export id alone; the person comes from the export');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence',
                                'ductus_identity', 'ductus_auth', 'ductus_test_stranger', 'public']) r
      WHERE has_function_privilege(r, 'app.worker_student_data_export_confirmation_codes(uuid)', 'EXECUTE') $$,
  ARRAY['ductus_worker', 'ductus_evidence'],
  'only the worker and the owning evidence role execute the read');
SELECT is_empty(
  $$ SELECT rolname FROM pg_roles
      WHERE rolname NOT IN ('ductus_worker', 'ductus_evidence') AND NOT rolsuper
        AND has_function_privilege(oid, 'app.worker_student_data_export_confirmation_codes(uuid)', 'EXECUTE')
        AND NOT pg_has_role(oid, 'ductus_worker', 'MEMBER') AND NOT pg_has_role(oid, 'ductus_evidence', 'MEMBER') $$,
  'no other role executes it');

-- 2. The web role, with any session, and the other runtime roles read nothing.
SELECT is(pg_temp.ask(a, $$ SELECT count(*)::text FROM app.worker_student_data_export_confirmation_codes(
                              '00000000-0000-4000-8000-0000000002f1') $$),
  '42501: permission denied for function worker_student_data_export_confirmation_codes', a || ' cannot run the read')
  FROM unnest(ARRAY['ana', 'iva', 'vesna', 'anon']) a;
SELECT is(pg_temp.ask_as(r, 'anon', $$ SELECT count(*)::text FROM app.worker_student_data_export_confirmation_codes(
                                        '00000000-0000-4000-8000-0000000002f1') $$),
  c, r || ' cannot run the read')
  FROM (VALUES ('ductus_app', '42501: permission denied for function worker_student_data_export_confirmation_codes'),
               ('ductus_retention', '42501: permission denied for function worker_student_data_export_confirmation_codes'),
               ('ductus_auth', '42501: permission denied for schema app')) AS x (r, c);

-- 3 (acceptance). A submission without a code gives no row; once its receipt
-- is bound, the worker reads Ana's code and nobody else's.
SELECT is(pg_temp.codes('''00000000-0000-4000-8000-0000000002f1''::uuid'), 'none',
  'Ana''s submission waiting for its receipt has no code, and Dora''s and Tomo''s do not stand in');
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.submission_confirmation_code (submission_id, institution_id, principal_id, code)
SELECT s.id, s.institution_id, s.principal_id, 'AAAA-0000-1111-2222'
  FROM evidence.submission s WHERE s.submission_request_id = '00000000-0000-4000-8000-0000000002e1';
RESET ROLE;
SELECT is(pg_temp.codes('''00000000-0000-4000-8000-0000000002f1''::uuid'), 'AAAA-0000-1111-2222',
  'the worker reads the code of Ana''s bound receipt and nothing of Dora or Tomo');
SELECT is(pg_temp.work($$ SELECT string_agg(c.submission_id::text, ';')
                            FROM app.worker_student_data_export_confirmation_codes('00000000-0000-4000-8000-0000000002f1') c $$),
  (SELECT s.id::text FROM evidence.submission s WHERE s.submission_request_id = '00000000-0000-4000-8000-0000000002e1'),
  'the code comes with the id of Ana''s submission, the one its receipt is of');
SELECT is(pg_temp.work($$ SELECT count(*)::text
                            FROM app.worker_student_data_export_submissions('00000000-0000-4000-8000-0000000002f1') s
                            LEFT JOIN app.worker_student_data_export_confirmation_codes('00000000-0000-4000-8000-0000000002f1') c
                              ON c.submission_id = s.submission_id
                           WHERE c.code = 'AAAA-0000-1111-2222' $$),
  '1', 'the adapter''s join gives the code on Ana''s submission row');

-- 4. Only an approved export reads anything: Dora's requested one, an unknown
-- id and no id read no code.
SELECT is(pg_temp.codes(e.id), 'none', e.label || ' reads no code')
  FROM (VALUES ('''00000000-0000-4000-8000-0000000002f2''::uuid', 'a requested export'),
               ('''00000000-0000-4000-8000-0000000002ff''::uuid', 'an unknown export'),
               ('NULL::uuid', 'no export')) AS e (id, label);

-- 5. A ready export reads no code either: the job ends at ready.
SELECT is(pg_temp.work($$ SELECT app.worker_mark_student_data_export_ready('00000000-0000-4000-8000-0000000002f1',
                                   sha256('izmisljeni-token-287'::bytea)) IS NOT NULL $$),
  'true', 'the worker marks Ana''s export ready');
SELECT is(pg_temp.codes('''00000000-0000-4000-8000-0000000002f1''::uuid'), 'none', 'a ready export reads no code');

-- 6. A withdrawn submission's code stays out, as its submission does
-- (205-submission-withdrawal.sql tests the predicate).
SELECT ok(pg_get_functiondef('app.worker_student_data_export_confirmation_codes(uuid)'::regprocedure)
            LIKE '%NOT evidence.submission_withdrawn(s.id)%',
  'the codes read leaves a withdrawn submission out');

SELECT * FROM finish();
ROLLBACK;
