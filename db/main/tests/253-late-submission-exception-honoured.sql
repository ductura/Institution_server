-- SRV-NF4-IZNIMKA-PREDAJA (Ductus#2055; NF-4, NZ-5 B): on an assignment whose
-- teacher does not allow late submission, a student with a late-submission
-- exception that still lasts may request a submission after the deadline; the
-- request still pins the deadline that holds, so it is after it. An expired
-- exception, another student's exception and an exception on another
-- assignment do not count.
-- Every person, course, document and date below is invented
-- (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in it).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Z1 gets a version 3 whose deadline passed yesterday; Ana and Dora
-- acknowledge it. Dora gets her own document of Z1 (as 249).
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

-- The exception through the bridge, as p_role; "null" for none, else the
-- time against now().
CREATE FUNCTION pg_temp.until_as(p_role text, p_actor text, p_assignment text DEFAULT 'z1') RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(pg_temp.ask_as(p_role, p_actor,
                                 format($q$ SELECT (app.student_late_exception_until({%s}) - now())::text $q$,
                                        p_assignment)), 'null')
$$;
CREATE FUNCTION pg_temp.grant_exception(p_student text, p_until interval) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format(
    $q$ SELECT reason_id FROM institution.grant_late_submission_exception({z1}, {%s}, now() + %L::interval, 'technical') $q$,
    p_student, p_until))
$$;
CREATE FUNCTION pg_temp.request(p_student text, p_document text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_student, format($q$ SELECT outcome FROM app.request_submission(%L, 1) $q$, p_document))
$$;
-- The requests of a student on Z1: the pinned deadline against now() and
-- whether the request is after it (what the submission's afterDeadline is).
CREATE FUNCTION pg_temp.requests(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(format('%s after=%s', due_at - now(), (requested_at > due_at)::text), ' '), 'none')
    FROM evidence.submission_request
   WHERE principal_id = pg_temp.id(p_student) AND assignment_id = pg_temp.id('z1')
$$;

-- Catalogue: the bridge, and the exception inside the late refusal.
SELECT is(
  (SELECT format('%s %s %s %s', pg_get_userbyid(proowner), prosecdef::text, provolatile, ('search_path=""' = ANY(proconfig))::text)
     FROM pg_proc WHERE oid = 'app.student_late_exception_until(uuid)'::regprocedure),
  'ductus_identity true s true', 'the bridge is the identity role''s, SECURITY DEFINER, STABLE, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
     WHERE has_function_privilege(r, 'app.student_late_exception_until(uuid)', 'EXECUTE') $$,
  $$ VALUES ('ductus_evidence'), ('ductus_app') $$,
  'only the evidence role (the request) and the web role (student.assignment-work.get) execute the bridge');
SELECT is(pg_get_function_arguments('app.student_late_exception_until(uuid)'::regprocedure), 'p_assignment_id uuid',
  'the bridge takes only the assignment: the student comes from the session');
SELECT ok(strpos(prosrc, 'app.student_late_exception_until(v_project.assignment_id)') >
            strpos(prosrc, 'IF v_now > v_due AND app.student_late_submission_allowed(v_project.assignment_id) IS NOT TRUE THEN')
          AND strpos(prosrc, 'IF v_now > v_due AND app.student_late_submission_allowed(') > 0
          AND strpos(prosrc, 'app.student_late_exception_until(') < strpos(prosrc, 'INSERT INTO evidence.submission_request'),
  'request_submission reads the exception only inside its late refusal, before writing')
FROM pg_proc WHERE oid = 'app.request_submission(text,bigint)'::regprocedure;

-- Both commit revision 1 after the version's deadline; Vesna does not allow
-- late submission.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a',64), repeat('d',64), repeat('b',64)),
  'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.call('dora', 'pkg-d', 'request-d1',
    pg_temp.descriptor(p_package=>'pkg-d', p_document=>'doc-d', p_segment=>'segment-d-1', p_session=>'capture-session-d'),
    0, repeat('a',64), repeat('e',64), repeat('b',64)),
  'reserved', 'fixture: Dora commits revision 1');
SELECT is(pg_temp.ask('vesna', $$ SELECT late_submission_allowed::text FROM institution.set_late_submission_allowed({z1}, false) $$),
  'false', 'Vesna does not allow late submission on Z1');
SELECT is(pg_temp.request('ana', 'doc-a'), 'not_open', 'without an exception Ana''s late request is refused');
SELECT is(pg_temp.requests('ana'), 'none', 'the refusal writes no request');

-- An expired exception of Dora (recorded two days ago, until an hour ago)
-- does not count. Written as the owner: the RPC accepts only a future time.
SET LOCAL ROLE ductus_identity;
INSERT INTO institution.late_submission_exception
  (institution_id, assignment_id, student_id, until_at, reason_id, created_by, created_at)
VALUES (pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), now() - interval '1 hour', 'justified',
        pg_temp.id('vesna'), now() - interval '2 days');
RESET ROLE;
SELECT is(pg_temp.until_as('ductus_evidence', 'dora'), '-01:00:00', 'Dora reads her expired exception through the bridge');
SELECT is(pg_temp.request('dora', 'doc-d'), 'not_open', 'with an expired exception Dora''s late request is refused');
SELECT is(pg_temp.requests('dora'), 'none', 'and nothing is written');

-- Vesna records a lasting exception for Ana.
SELECT is(pg_temp.grant_exception('ana', '1 day'), 'technical', 'Vesna records an exception for Ana until tomorrow');

-- Who reads Ana's exception through the bridge: only Ana herself.
SELECT is(pg_temp.until_as(r.role, a.name), a.result,
          format('%s reads through the bridge as %s: %s', a.name, r.role, a.result))
FROM (VALUES ('ana', '1 day'), ('dora', '-01:00:00'), ('vesna', 'null'), ('marko', 'null'), ('boris', 'null'),
             ('iva', 'null'), ('tomo', 'null'), ('anon', 'null')) AS a (name, result)
CROSS JOIN (VALUES ('ductus_evidence'), ('ductus_app')) AS r (role);
SELECT is(pg_temp.until_as('ductus_evidence', 'ana', 'z3'), 'null', 'nor on an assignment of another institution');
SELECT is(pg_temp.until_as('ductus_evidence', 'ana', 'z2'), 'null', 'nor on an assignment without an exception');

-- Another student's exception does not count: Dora is still refused.
SELECT is(pg_temp.request('dora', 'doc-d'), 'not_open', 'Ana''s exception does not let Dora''s late request through');
SELECT is(pg_temp.requests('dora'), 'none', 'and nothing is written for Dora');

-- Ana's lasting exception lets her request through, after the deadline.
SELECT is(pg_temp.request('ana', 'doc-a'), 'requested', 'with a lasting exception Ana''s late request is accepted');
SELECT is(pg_temp.requests('ana'), '-1 days after=true',
  'Ana''s request pins the passed deadline, so it is after the deadline');
SELECT is(pg_temp.request('ana', 'doc-a'), 'existing', 'repeating it is answered as an existing request');

-- The latest record holds: a newer, later exception for Dora lets her through.
SELECT is(pg_temp.grant_exception('dora', '2 hours'), 'technical', 'Vesna records a new exception for Dora');
SELECT is(pg_temp.until_as('ductus_evidence', 'dora'), '02:00:00', 'Dora now reads the latest exception');
SELECT is(pg_temp.request('dora', 'doc-d'), 'requested', 'Dora''s late request is accepted with the new exception');
SELECT is(pg_temp.requests('dora'), '-1 days after=true', 'and it is after the deadline');

SELECT * FROM finish();
ROLLBACK;
