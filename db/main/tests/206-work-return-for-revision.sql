-- SRV-1606: the teacher returns the whole submitted work for revision. A return
-- is written once and never changes; it makes the submission not the live one,
-- reopens the packages and lets the student submit the next round; only the
-- teacher of the assignment may do it (C-23). Every person, key, course and
-- date below is invented (fixtures/institution.inc: Vesna teaches K1, Ana and
-- Dora study in it, Marko teaches another course, Tomo is of another institution).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.back(p_actor text, p_doc text DEFAULT 'doc-a', p_comment text DEFAULT 'Doradi uvod.',
                             p_due text DEFAULT 'NULL')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    'SELECT outcome FROM app.return_work_for_revision(%L, %L, %s)', p_doc, p_comment, p_due))
$$;

-- 1. Catalogue.
SELECT is((SELECT concat_ws(' ', pg_get_userbyid(c.relowner), c.relrowsecurity::text, c.relforcerowsecurity::text)
             FROM pg_class c WHERE c.oid = 'evidence.submission_return'::regclass),
  'ductus_evidence true true', 'the record: owner and forced RLS');
SELECT bag_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text
       FROM pg_policy WHERE polrelid = 'evidence.submission_return'::regclass $$,
  ARRAY['evidence_submission_return_owner * {ductus_evidence}', 'evidence_submission_return_read r {ductus_app}'],
  'the owner''s policy and the student''s own-rows read');
SELECT bag_eq(
  $$ SELECT r || ' ' || p
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, 'evidence.submission_return', p) AND r <> 'ductus_evidence' $$,
  ARRAY['ductus_app SELECT'], 'besides the owner only the web role reads; nobody writes the table directly');
SELECT bag_eq(
  $$ SELECT r || ' ' || f
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_identity', 'ductus_evidence',
                         'ductus_auth', 'ductus_test_stranger', 'public']) r
      CROSS JOIN unnest(ARRAY['app.return_work_for_revision(text,text,timestamptz)',
                              'app.work_return_context(uuid,uuid)', 'app.notify_work_returned(uuid,uuid,uuid)']) f
      WHERE has_function_privilege(r, f, 'EXECUTE')
        AND NOT (r = 'ductus_identity' AND f <> 'app.return_work_for_revision(text,text,timestamptz)'
                 AND f <> 'app.work_return_context(uuid,uuid)' AND f <> 'app.notify_work_returned(uuid,uuid,uuid)') $$,
  ARRAY['ductus_app app.return_work_for_revision(text,text,timestamptz)',
        'ductus_evidence app.return_work_for_revision(text,text,timestamptz)',
        'ductus_evidence app.work_return_context(uuid,uuid)', 'ductus_evidence app.notify_work_returned(uuid,uuid,uuid)',
        'ductus_identity app.work_return_context(uuid,uuid)', 'ductus_identity app.notify_work_returned(uuid,uuid,uuid)'],
  'who executes what, besides the owners');
SELECT is_empty(
  $$ SELECT oid::regprocedure::text FROM pg_proc
      WHERE oid IN ('app.return_work_for_revision(text,text,timestamptz)'::regprocedure,
                    'app.work_return_context(uuid,uuid)'::regprocedure,
                    'app.notify_work_returned(uuid,uuid,uuid)'::regprocedure)
        AND (NOT prosecdef OR NOT 'search_path=""' = ANY (proconfig)) $$,
  'every function is SECURITY DEFINER with an empty search_path');
SELECT is(pg_get_function_arguments('app.return_work_for_revision(text,text,timestamptz)'::regprocedure),
  'p_document_id text, p_comment text, p_revision_due_at timestamp with time zone',
  'a return names no person, institution, assignment, time or role');

-- 2. Ana's submission: revision 1, requested and recorded, not yet returned.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64),
                       repeat('b', 64)), 'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.back('vesna'), 'not_found', 'never requested for submission: nothing to return');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome || ' ' || revision FROM app.request_submission('doc-a', 1) $$),
  'requested 1', 'fixture: Ana requests revision 1');
SELECT is(pg_temp.ask('ana', format(
    'SELECT outcome FROM app.record_submission((SELECT id FROM evidence.submission_request), %L)', pg_temp.h('d'))),
  'recorded', 'fixture: her submission is recorded');
SELECT is((SELECT bool_or(accepts_evidence)::text FROM evidence.package WHERE document_id = 'doc-a'), 'false',
  'the submission closed her package');

-- 3. Who may return, and what is checked first.
SELECT is(pg_temp.back(a.name), a.result, a.name || ': ' || a.result)
FROM (VALUES ('anon', 'unauthorized'), ('expired', 'unauthorized'), ('closed', 'unauthorized'),
             ('ana', 'forbidden'), ('dora', 'not_found'), ('marko', 'not_found'), ('tomo', 'not_found')) AS a (name, result);
SELECT is(pg_temp.back('vesna', 'doc-nobody'), 'not_found', 'an unknown work is not found');
SELECT is(pg_temp.back('vesna', 'doc-b'), 'not_found', 'a work of another institution is not found');
SELECT is(pg_temp.back('vesna', 'doc-a', ''), 'invalid', 'the comment is required');
SELECT is(pg_temp.back('vesna', 'doc-a', E' \n '), 'invalid', 'a blank comment is invalid');
SELECT is(pg_temp.back('vesna', 'doc-a', repeat('x', 2001)), 'invalid', 'the comment is at most 2000 characters');
SELECT is(pg_temp.ask('vesna', $$ SELECT outcome FROM app.return_work_for_revision('doc-a', NULL, NULL) $$),
  'invalid', 'a missing comment is invalid');
SELECT is(pg_temp.back('vesna', 'doc-a', 'Doradi uvod.', $$'10000-01-01T00:00:00Z'$$), 'invalid',
  'a revision due date outside the range is invalid');
SELECT is((SELECT count(*)::int FROM evidence.submission_return), 0, 'nothing of the refusals was written');

-- 4. The return.
SELECT is(pg_temp.ask('vesna', $$ SELECT concat_ws(' ', outcome, attempt, comment, revision_due_at IS NOT NULL)
  FROM app.return_work_for_revision('doc-a', 'Doradi uvod.', '2027-01-15T12:00:00Z') $$),
  'returned 1 Doradi uvod. t', 'Vesna returns the work with a comment and a new due date');
SELECT is((SELECT concat_ws(' ', count(*), min(comment), bool_and(returned_by = pg_temp.id('vesna')),
                            bool_and(principal_id = pg_temp.id('ana')), bool_and(document_id = 'doc-a'))
             FROM evidence.submission_return),
  '1 Doradi uvod. t t t', 'one record: the comment, the teacher, the student, the work');
SELECT is((SELECT bool_and(accepts_evidence)::text FROM evidence.package WHERE document_id = 'doc-a'), 'true',
  'the packages accept evidence again: she edits');
SELECT is(pg_temp.back('vesna'), 'not_submitted', 'returning twice: the submission is no longer live');
SELECT is((SELECT count(*)::int FROM evidence.submission_return), 1, 'still one record');
SELECT is((SELECT concat_ws(' ', count(*), min(kind), bool_and(target_id = pg_temp.id('z1')))
             FROM institution.notification WHERE recipient_id = pg_temp.id('ana') AND kind = 'work_returned'),
  '1 work_returned t', 'Ana is notified once');
SELECT is((SELECT count(*)::int FROM institution.notification
            WHERE kind = 'work_returned' AND recipient_id <> pg_temp.id('ana')), 0, 'nobody else is');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM evidence.submission_return $$), '1',
  'Ana reads her own return');
SELECT is(pg_temp.ask('dora', $$ SELECT count(*)::text FROM evidence.submission_return $$), '0',
  'another student reads none');
SELECT isnt(pg_temp.ask('ana', $$ SELECT state FROM app.my_submission_state({z1}) $$), 'potvrdeno',
  'for Ana the work is no longer confirmed as submitted');

-- 5. The record never changes, and nobody but the RPC writes it.
SELECT matches(pg_temp.ask_as('ductus_evidence', 'vesna', $$ UPDATE evidence.submission_return SET comment = 'x' $$),
  '^ZD40', 'an update is refused');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'vesna', $$ DELETE FROM evidence.submission_return $$),
  '^ZD40', 'a delete is refused');
SELECT matches(pg_temp.ask_as('ductus_evidence', 'vesna', $$ TRUNCATE evidence.submission_return $$),
  '^ZD40', 'a truncate is refused');
SELECT matches(pg_temp.ask_as('ductus_app', 'vesna', $$ INSERT INTO evidence.submission_return
  (submission_id, institution_id, principal_id, assignment_id, document_id, returned_by, comment)
  SELECT id, institution_id, principal_id, assignment_id, 'doc-a', principal_id, 'x' FROM evidence.submission $$),
  '^42501', 'the web role cannot write a return');

-- 6. The next round: Ana submits again as the next attempt.
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'after the return a new request is made, not the old live one');
SELECT is((SELECT max(attempt)::int FROM evidence.submission_request WHERE principal_id = pg_temp.id('ana')), 2,
  'Ana''s next request is attempt 2');
SELECT is((SELECT count(*)::int FROM evidence.submission_request WHERE principal_id = pg_temp.id('ana')), 2,
  'two rounds of requests; the first and its submission stay');
SELECT is((SELECT count(*)::int FROM evidence.submission), 1, 'the returned submission is kept');

SELECT * FROM finish();
ROLLBACK;
