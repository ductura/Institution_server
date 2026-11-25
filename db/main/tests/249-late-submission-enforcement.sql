-- SRV-NF4-KASNA-PROVEDBA (Ductus#2055, decision A): when the teacher of an
-- assignment does not allow a submission after its deadline, a submission
-- request whose click is after the deadline that holds for the student is
-- refused with the existing outcome not_open, before anything is written. An
-- extension moves that deadline; a request already made stays as it is.
-- Every person, course, document and date below is invented
-- (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in it).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Z1 gets a version 3 whose deadline passed yesterday; Ana and Dora
-- acknowledge it. Dora gets her own document of Z1 (as 167).
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.assignment_version (
  assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
  evidence_profile, import_allowed, created_by
) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Upute za izmišljeni zadatak.', 'essay', now() - interval '2 days',
          now() - interval '1 day', 'partially_allowed', '{proofreading}', 'extended', true, pg_temp.id('vesna'));
UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT pg_temp.id('z1'), 3, pg_temp.id(s), pg_temp.id('fak_a') FROM unnest(ARRAY['ana', 'dora']) AS s;
RESET ROLE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE ductus_evidence;
INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id) VALUES
  ('project-d', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'));
INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 'project-d', pg_temp.id('dora'), pg_temp.h('a'));
INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash) VALUES
  ('doc-d', pg_temp.id('fak_a'), 0, pg_temp.id('dora'), pg_temp.h('a'));
INSERT INTO evidence.package (
  id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id, max_payload_bytes
) VALUES ('pkg-d', pg_temp.id('fak_a'), '00000000-0000-4000-8000-0000000000d1', 'doc-d', 'project-d',
          pg_temp.id('dora'), 'standard-v1', 2097152);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS evidence.evidence_document_current_revision_fkey DEFERRED;
RESET ROLE;

-- The field through the bridge, as the evidence role; "null" for none.
CREATE FUNCTION pg_temp.allowed(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(pg_temp.ask_as('ductus_evidence', p_actor,
                                 $q$ SELECT app.student_late_submission_allowed({z1})::text $q$), 'null')
$$;
CREATE FUNCTION pg_temp.set_allowed(p_allowed boolean) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format(
    'SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({z1}, %L)', p_allowed))
$$;
CREATE FUNCTION pg_temp.request(p_student text, p_document text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_student, format($q$ SELECT outcome FROM app.request_submission(%L, 1) $q$, p_document))
$$;
-- The requests of a student on Z1, with their pinned deadline against now().
CREATE FUNCTION pg_temp.requests(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg((due_at - now())::text, ' '), 'none') FROM evidence.submission_request
   WHERE principal_id = pg_temp.id(p_student) AND assignment_id = pg_temp.id('z1')
$$;

-- Catalogue: the bridge and the refusal in request_submission.
SELECT is(
  (SELECT format('%s %s %s %s', pg_get_userbyid(proowner), prosecdef::text, provolatile, ('search_path=""' = ANY(proconfig))::text)
     FROM pg_proc WHERE oid = 'app.student_late_submission_allowed(uuid)'::regprocedure),
  'ductus_identity true s true', 'the bridge is the identity role''s, SECURITY DEFINER, STABLE, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
     WHERE has_function_privilege(r, 'app.student_late_submission_allowed(uuid)', 'EXECUTE') $$,
  $$ VALUES ('ductus_evidence') $$,
  'of the other roles only the evidence role executes the bridge; the web reads the field through its own RPC');
SELECT is(pg_get_function_arguments('app.student_late_submission_allowed(uuid)'::regprocedure), 'p_assignment_id uuid',
  'the bridge takes only the assignment: the student comes from the session');
SELECT ok(prosrc LIKE '%IF v_now > v_due AND app.student_late_submission_allowed(v_project.assignment_id) IS NOT TRUE THEN%'
          AND strpos(prosrc, 'app.student_late_submission_allowed(') > strpos(prosrc, 'v_due := app.student_effective_due_at(')
          AND strpos(prosrc, 'app.student_late_submission_allowed(') < strpos(prosrc, 'INSERT INTO evidence.submission_request'),
  'request_submission refuses strictly after the effective deadline (P6), after reading it and before writing')
FROM pg_proc WHERE oid = 'app.request_submission(text,bigint)'::regprocedure;

-- Who reads the field through the bridge: only a student of Z1.
SELECT is(pg_temp.allowed(a.name), a.result, format('%s reads the field of Z1 through the bridge: %s', a.name, a.result))
FROM (VALUES ('ana', 'true'), ('dora', 'true'), ('vesna', 'null'), ('marko', 'null'), ('boris', 'null'),
             ('tomo', 'null'), ('anon', 'null')) AS a (name, result);
SELECT is(pg_temp.ask_as('ductus_evidence', 'ana', $$ SELECT app.student_late_submission_allowed({z3}) IS NULL $$),
  'true', 'nor on an assignment of another institution');

-- Both commit revision 1 after the version's deadline.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a',64), repeat('d',64), repeat('b',64)),
  'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.call('dora', 'pkg-d', 'request-d1',
    pg_temp.descriptor(p_package=>'pkg-d', p_document=>'doc-d', p_segment=>'segment-d-1', p_session=>'capture-session-d'),
    0, repeat('a',64), repeat('e',64), repeat('b',64)),
  'reserved', 'fixture: Dora commits revision 1');

-- Vesna does not allow late submission: after the deadline the request is
-- refused and nothing is written.
SELECT is(pg_temp.set_allowed(false), 'false', 'Vesna does not allow late submission on Z1');
SELECT is(pg_temp.allowed('dora'), 'false', 'Dora reads the new value through the bridge');
SELECT is(pg_temp.request('dora', 'doc-d'), 'not_open', 'Dora''s request after the deadline is refused as not_open');
SELECT is(pg_temp.requests('dora'), 'none', 'the refusal writes no request');

-- An extension moves the deadline that holds: Ana is in time again.
SELECT is(pg_temp.ask('vesna', $$ SELECT earlier_submissions::text FROM institution.extend_assignment_deadline(
            {z1}, {ana}, now() + interval '1 day', 'justified') $$),
  'false', 'Vesna extends Ana''s deadline to tomorrow');
SELECT is(pg_temp.request('ana', 'doc-a'), 'requested', 'Ana''s request before her extended deadline is accepted');
SELECT is(pg_temp.requests('ana'), '1 day', 'Ana''s request pins her extended deadline');

-- Allowed again: Dora's late request is accepted and is after the deadline.
SELECT is(pg_temp.set_allowed(true), 'true', 'Vesna allows late submission on Z1 again');
SELECT is(pg_temp.request('dora', 'doc-d'), 'requested', 'Dora''s late request is now accepted');
SELECT is(pg_temp.requests('dora'), '-1 days', 'Dora''s request pins the passed deadline');

-- Not allowed once more: a request already made stays, and repeating it is
-- answered as before.
SELECT is(pg_temp.set_allowed(false), 'false', 'Vesna does not allow late submission again');
SELECT is(pg_temp.requests('dora'), '-1 days', 'Dora''s request already made is unchanged');
SELECT is(pg_temp.request('dora', 'doc-d'), 'existing', 'repeating it is answered as an existing request');

SELECT * FROM finish();
ROLLBACK;
