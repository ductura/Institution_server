-- F4-NAS-R16-SRV (NAS-R16): the revision due date of a work is read back
-- (app.read_work_revision_due, 20261220210000). Only the student who owns the
-- work and a teacher of its assignment read it; a student of the course, a
-- teacher of another course, another institution and an unknown work read
-- not_found. The read writes nothing. Every person, document and date below is
-- invented (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in it,
-- Marko teaches another course, Tomo is of another institution).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.due(p_actor text, p_doc text DEFAULT 'doc-a') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT concat_ws('' '', outcome, attempt, to_char(revision_due_at AT TIME ZONE ''UTC'', ''YYYY-MM-DD HH24:MI''), returned_at IS NOT NULL) FROM app.read_work_revision_due(%L)', p_doc))
$$;

-- 1. Catalogue: SECURITY DEFINER of the evidence role, empty search_path, web role only.
SELECT is_empty(
  $$ SELECT p.oid::regprocedure::text FROM pg_proc p
      WHERE p.oid = 'app.read_work_revision_due(text)'::regprocedure
        AND (NOT p.prosecdef OR p.proowner <> 'ductus_evidence'::regrole OR NOT 'search_path=""' = ANY (p.proconfig)) $$,
  'the read is a SECURITY DEFINER function of the evidence role with an empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_identity', 'ductus_test_stranger', 'public']) AS r
      WHERE has_function_privilege(r, 'app.read_work_revision_due(text)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app') $$,
  'only the web role calls the read (besides its owner)');
SELECT ok(NOT has_schema_privilege('ductus_evidence', 'app', 'CREATE'),
  'after the migration the evidence role keeps no CREATE on schema app');
SELECT is(pg_get_function_arguments('app.read_work_revision_due(text)'::regprocedure),
  'p_document_id text', 'the read names no person, institution or role: they come from the session');

-- 2. Fixture: Ana submits revision 1.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
                       repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.due('ana'), 'not_found', 'a work never submitted reads as not found, even for its owner');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'requested 1', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
CREATE TEMP TABLE snap AS
  SELECT (SELECT count(*) FROM evidence.submission_return) AS returns,
         (SELECT count(*) FROM audit.access_log) AS log;

-- 3. Submitted, not returned: an ok answer with nothing open, for the owner and the teacher.
SELECT is(pg_temp.due(a.name), 'ok false', a.name || ' reads no open return of a submitted work')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

-- 4. Vesna returns the work with a due date.
SELECT is(pg_temp.ask('vesna', $$ SELECT outcome FROM app.return_work_for_revision('doc-a', 'Doradi uvod.', '2027-01-15T12:00:00Z') $$),
  'returned', 'fixture: Vesna returns the work with a revision due date');
SELECT is(pg_temp.due(a.name), 'ok 1 2027-01-15 12:00 true', a.name || ' reads the round and the due date')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

-- 5. Nobody else reads it, and the answer is the same as for an unknown work.
SELECT is(pg_temp.due(a.name), 'not_found', a.name || ' reads nothing of Ana''s work')
FROM (VALUES ('dora'), ('marko'), ('tomo')) AS a (name);
SELECT is(pg_temp.due('vesna', 'doc-nobody'), 'not_found', 'an unknown work is not found');
SELECT is(pg_temp.due('vesna', 'doc-b'), 'not_found', 'a work of another institution is not found');
SELECT is(pg_temp.due('ana', ''), 'invalid', 'an empty document id is invalid');
SELECT is(pg_temp.due(t.name), 'unauthorized', 'session ' || t.name || ' is not signed in')
FROM (VALUES ('anon'), ('expired'), ('closed')) AS t (name);
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.read_work_revision_due(NULL) $$), 'invalid', 'a missing id is invalid');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM evidence.submission_return $$), '0',
  'the table itself is still readable only by the owner student (the read gives Dora nothing)');

-- 6. The comment is not part of the answer.
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest((SELECT proargnames FROM pg_proc WHERE oid = 'app.read_work_revision_due(text)'::regprocedure)) n
                       WHERE n IN ('comment', 'returned_by')),
  'the RPC returns neither the comment nor the teacher');

-- 7. Reads write nothing.
SELECT is((SELECT count(*) FROM evidence.submission_return), (SELECT returns FROM snap),
  'the reads wrote no return');
SELECT is((SELECT count(*) FROM audit.access_log), (SELECT log FROM snap),
  'the reads left no row in the access log');

-- 8. Ana submits again: the return is no longer open.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'fixture: Ana requests the next round');
SELECT is(pg_temp.due(a.name), 'ok false', a.name || ' reads no open return after the student submitted again')
FROM (VALUES ('ana'), ('vesna')) AS a (name);

SELECT * FROM finish();
ROLLBACK;
