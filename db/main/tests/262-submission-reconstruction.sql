-- F4-PM2-R01 (Ductus#2059): the worker's verdict of a recorded submission
-- (20261220320000). The worker of the domain lists the submissions without a
-- verdict, reads the record of one and keeps a verdict the database decides
-- by comparing hashes; the student reads only the own state. Synthetic rows only.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.worker(p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql)
$$;
CREATE FUNCTION pg_temp.req(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT id::text FROM evidence.submission_request WHERE principal_id = pg_temp.id(p_student)
$$;
CREATE FUNCTION pg_temp.sid() RETURNS text LANGUAGE sql AS $$ SELECT id::text FROM evidence.submission LIMIT 1 $$;
CREATE FUNCTION pg_temp.mine(p_actor text, p_assignment text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT outcome || ' ' || coalesce(state, '-') FROM app.my_submission_reconstruction(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.record_verdict(p_domain text, p_submission text, p_hash text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format('SELECT app.worker_record_submission_reconstruction(%L::uuid, %s, %s)',
    p_domain, coalesce(quote_literal(p_submission) || '::uuid', 'NULL'), coalesce(quote_literal(p_hash), 'NULL')))
$$;
CREATE FUNCTION pg_temp.listed(p_domain text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker(format(
    $q$ SELECT count(*)::text FROM app.worker_submissions_to_reconstruct(%L::uuid, 10) $q$, p_domain))
$$;

\set d1 '00000000-0000-4000-8000-0000000000d1'
\set d2 '00000000-0000-4000-8000-0000000000d2'

SELECT is(pg_temp.call('ana','pkg-a','request-1',pg_temp.descriptor(),0,repeat('a',64),repeat('d',64),repeat('b',64)),
  'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests revision 1');

-- Before a submission exists nothing is listed and the student reads not_found.
SELECT is(pg_temp.listed(:'d1'), '0', 'no submission, nothing to reconstruct');
SELECT is(pg_temp.mine('ana', format('%L::uuid', pg_temp.id('z1'))), 'not_found -', 'no submission reads not_found');
SELECT is(pg_temp.ask('ana', format($$ SELECT outcome FROM app.record_submission(%L::uuid, %L) $$,
  pg_temp.req('ana'), pg_temp.h('d'))), 'recorded', 'fixture: Ana submits');

-- Catalogue: the table keeps RLS with no privilege for a runtime role.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity
    AND NOT has_table_privilege('ductus_app', c.oid, 'SELECT')
    AND NOT has_table_privilege('ductus_worker', c.oid, 'SELECT')
    AND NOT has_table_privilege('ductus_app', c.oid, 'INSERT')
    AND NOT has_table_privilege('ductus_worker', c.oid, 'INSERT'),
  'the verdict table has forced RLS and no privilege for the web or the worker role')
FROM pg_class c WHERE c.oid = 'evidence.submission_reconstruction'::regclass;
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid IN ('app.worker_submissions_to_reconstruct(uuid,integer)'::regprocedure,
                      'app.worker_submission_record(uuid,uuid)'::regprocedure,
                      'app.worker_record_submission_reconstruction(uuid,uuid,text)'::regprocedure,
                      'app.my_submission_reconstruction(uuid)'::regprocedure)
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_evidence'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the four functions are SECURITY DEFINER of the evidence role with an empty search_path');
SELECT is_empty(
  $$ SELECT r || ' ' || p.oid::regprocedure::text FROM pg_proc p
      CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_retention', 'ductus_auth', 'ductus_identity', 'ductus_test_stranger']) AS r
      WHERE p.oid IN ('app.worker_submissions_to_reconstruct(uuid,integer)'::regprocedure,
                      'app.worker_submission_record(uuid,uuid)'::regprocedure,
                      'app.worker_record_submission_reconstruction(uuid,uuid,text)'::regprocedure)
        AND has_function_privilege(r, p.oid, 'EXECUTE') $$,
  'no other runtime role executes a worker function');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_identity', 'ductus_test_stranger']) AS r
      WHERE has_function_privilege(r, 'app.my_submission_reconstruction(uuid)'::regprocedure, 'EXECUTE') $$,
  'only the web role executes the student read');

-- The worker of the domain lists it; another domain and invalid input do not.
SELECT is(pg_temp.listed(:'d1'), '1', 'the worker of the domain lists the submission without a verdict');
SELECT is(pg_temp.listed(:'d2'), '0', 'the worker of another domain lists nothing of it');
SELECT matches(pg_temp.worker($$ SELECT * FROM app.worker_submissions_to_reconstruct(NULL, 10) $$), '^22023', 'NULL domain is invalid');
SELECT matches(pg_temp.worker(format($$ SELECT * FROM app.worker_submissions_to_reconstruct(%L::uuid, 0) $$, :'d1')),
  '^22023', 'limit 0 is invalid');
SELECT matches(pg_temp.worker(format($$ SELECT * FROM app.worker_submissions_to_reconstruct(%L::uuid, 1001) $$, :'d1')),
  '^22023', 'limit 1001 is invalid');
SELECT matches(pg_temp.ask('ana', format($$ SELECT * FROM app.worker_submissions_to_reconstruct(%L::uuid, 10) $$, :'d1')),
  'permission denied', 'the web role cannot list');

-- The record: the domain of another worker reads not_found.
SELECT is(pg_temp.worker(format($$ SELECT outcome FROM app.worker_submission_record(%L::uuid, %L::uuid) $$, :'d2', pg_temp.sid())),
  'not_found', 'another domain reads not_found');
SELECT is(pg_temp.worker(format($$ SELECT outcome FROM app.worker_submission_record(%L::uuid, %L::uuid) $$, :'d1', pg_temp.sid())),
  'found', 'the worker of the domain reads the record of the submission');
SELECT is(pg_temp.worker(format($$ SELECT outcome FROM app.worker_submission_record(%L::uuid, '00000000-0000-4000-8000-0000000000ff') $$, :'d1')),
  'not_found', 'an unknown submission reads not_found');

-- Pending until a verdict; another student reads the same as for nothing.
SELECT is(pg_temp.mine('ana', format('%L::uuid', pg_temp.id('z1'))), 'found pending', 'the owner reads pending');
SELECT is(pg_temp.mine('dora', format('%L::uuid', pg_temp.id('z1'))), 'not_found -', 'a classmate reads not_found');
SELECT is(pg_temp.mine('vesna', format('%L::uuid', pg_temp.id('z1'))), 'not_found -', 'the teacher reads not_found');
SELECT is(pg_temp.mine('tomo', format('%L::uuid', pg_temp.id('z1'))), 'not_found -', 'a student of another institution reads not_found');
SELECT is(pg_temp.mine('ana', format('%L::uuid', pg_temp.id('z3'))), 'not_found -', 'another assignment reads not_found');
SELECT is(pg_temp.mine('ana', 'NULL'), 'not_found -', 'NULL assignment reads not_found');
SELECT matches(pg_temp.mine('anon', format('%L::uuid', pg_temp.id('z1'))), '^ZD401', 'no session is ZD401');

-- The verdict is the database's: a hash that is not the recorded one is a mismatch.
SELECT is(pg_temp.record_verdict(:'d2', pg_temp.sid(), pg_temp.h('d')), 'not_found', 'another domain keeps nothing');
SELECT is(pg_temp.record_verdict(:'d1', '00000000-0000-4000-8000-0000000000ff', pg_temp.h('d')), 'not_found', 'an unknown submission keeps nothing');
SELECT matches(pg_temp.record_verdict(:'d1', pg_temp.sid(), 'XYZ'), '^22023', 'a malformed hash is invalid');
SELECT is((SELECT count(*)::text FROM evidence.submission_reconstruction), '0', 'refusals write nothing');
SELECT is(pg_temp.record_verdict(:'d1', pg_temp.sid(), repeat('f', 64)), 'mismatch', 'another hash is a mismatch');
SELECT is(pg_temp.record_verdict(:'d1', pg_temp.sid(), pg_temp.h('d')), 'exists', 'the first verdict stays');
SELECT is(pg_temp.mine('ana', format('%L::uuid', pg_temp.id('z1'))), 'found mismatch', 'the owner reads the verdict');
SELECT is(pg_temp.listed(:'d1'), '0', 'a submission with a verdict is not listed again');
SELECT matches(pg_temp.ask('ana', format($$ SELECT app.worker_record_submission_reconstruction(%L::uuid, %L::uuid, NULL) $$, :'d1', pg_temp.sid())),
  'permission denied', 'the web role cannot keep a verdict');

SELECT * FROM finish();
ROLLBACK;
