-- SRV-1108C (wave 11, N-13): a submission is judged against the deadline that
-- holds for its student (institution.effective_due_at, SRV-1108), pinned by
-- the request at the click, and the student's workspace and the teacher's
-- overview show that deadline. A submission already recorded never changes.
-- Every person, course, document and date below is invented
-- (fixtures/institution.inc: Vesna teaches K1, Ana and Dora study in it).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/evidence-acceptance.inc
SELECT no_plan();

-- Z1 gets a version 3 whose deadline passed yesterday; Ana and Dora
-- acknowledge it. Dora gets her own document of Z1.
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

-- The deadline of the caller through the bridge; "null" for none.
CREATE FUNCTION pg_temp.due(p_actor text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(pg_temp.ask(p_actor, $q$ SELECT (app.student_effective_due_at({z1}) - now())::text $q$), 'null')
$$;
-- The request's and the submission's deadline of a student, against now().
CREATE FUNCTION pg_temp.request_due(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((due_at - now())::text, 'null') FROM evidence.submission_request
   WHERE principal_id = pg_temp.id(p_student) AND assignment_id = pg_temp.id('z1')
$$;
CREATE FUNCTION pg_temp.submission(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws(' ', (due_at - now())::text, after_deadline, request_due_at = due_at, version_due_at IS NULL)
    FROM evidence.submission WHERE principal_id = pg_temp.id(p_student) AND assignment_id = pg_temp.id('z1')
$$;
CREATE FUNCTION pg_temp.record(p_student text, p_hash text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_student, format(
    $q$ SELECT concat_ws(' ', outcome, (due_at - now())::text, after_deadline)
          FROM app.record_submission(%L::uuid, %L) $q$,
    (SELECT id FROM evidence.submission_request WHERE principal_id = pg_temp.id(p_student)), p_hash))
$$;
CREATE FUNCTION pg_temp.workspace(p_student text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_student, $q$ SELECT concat_ws(' ', (due_at - now())::text, coalesce(after_deadline::text, '-'))
                                      FROM app.student_workspace() WHERE assignment_id = {z1} $q$)
$$;
CREATE FUNCTION pg_temp.overview() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text := pg_temp.ask('vesna', $q$ SELECT string_agg(concat_ws(':', student_id, (due_at - now())::text,
                                                       CASE WHEN NOT submitted THEN 'no' WHEN after_deadline THEN 'late'
                                                            ELSE 'on-time' END), ' ' ORDER BY student_id)
                                       FROM app.assignment_overview({z1}) $q$);
  r record;
BEGIN
  FOR r IN SELECT name, id FROM person LOOP
    v := replace(v, r.id::text, r.name);
  END LOOP;
  RETURN v;
END
$$;
CREATE FUNCTION pg_temp.extend(p_student text, p_days integer, p_reason text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format(
    'SELECT earlier_submissions::text FROM institution.extend_assignment_deadline({z1}, %s, now() + interval %L, %L)',
    p_student, p_days || ' days', p_reason))
$$;

-- Catalogue: the bridge and the new columns.
SELECT is(
  (SELECT format('%s %s %s %s', pg_get_userbyid(proowner), prosecdef::text, provolatile, ('search_path=""' = ANY(proconfig))::text)
     FROM pg_proc WHERE oid = 'app.student_effective_due_at(uuid)'::regprocedure),
  'ductus_identity true s true', 'the bridge is the identity role''s, SECURITY DEFINER, STABLE, empty search_path');
SELECT bag_eq(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                'ductus_evidence', 'ductus_test_stranger', 'public']) AS r
     WHERE has_function_privilege(r, 'app.student_effective_due_at(uuid)', 'EXECUTE') $$,
  $$ VALUES ('ductus_app'), ('ductus_evidence') $$,
  'of the other roles only the web role and the evidence role execute the bridge');
SELECT is(pg_get_function_arguments('app.student_effective_due_at(uuid)'::regprocedure), 'p_assignment_id uuid',
  'the bridge takes only the assignment: the student comes from the session');
SELECT ok(NOT has_function_privilege('ductus_evidence', 'institution.effective_due_at(uuid,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('ductus_app', 'institution.effective_due_at(uuid,uuid)', 'EXECUTE'),
  'neither runtime role calls the unchecked reader itself');
SELECT ok(NOT has_column_privilege('ductus_app', 'evidence.submission_request', 'due_at', 'INSERT')
          AND NOT has_column_privilege('ductus_app', 'evidence.submission_request', 'due_at', 'UPDATE')
          AND NOT has_column_privilege('ductus_app', 'evidence.submission', 'request_due_at', 'INSERT'),
  'the web role writes neither deadline: only through the RPCs');
SELECT is((SELECT attgenerated::text FROM pg_attribute
            WHERE attrelid = 'evidence.submission'::regclass AND attname = 'version_due_at'), 's',
  'version_due_at is generated and stored');

-- Vesna extends Ana's deadline past the version's; Dora keeps the version's.
SELECT is(pg_temp.due('ana'), '-1 days', 'before any extension Ana''s deadline is version 3''s');
SELECT is(pg_temp.extend('{ana}', 1, 'justified'), 'false', 'Vesna extends Ana''s deadline to tomorrow');
SELECT is(pg_temp.due('ana'), '1 day', 'Ana''s deadline is now the extended one');
SELECT is(pg_temp.due('dora'), '-1 days', 'Dora''s deadline is still the version''s');
SELECT is(pg_temp.due(a.name), 'null', a.name || ' is not a student of Z1 and gets no deadline')
FROM (VALUES ('vesna'), ('marko'), ('boris'), ('tomo'), ('anon')) AS a (name);
SELECT is(pg_temp.ask('ana', $$ SELECT app.student_effective_due_at({z3}) IS NULL $$), 'true',
  'nor on an assignment of another institution');

-- Both commit revision 1 and request it after the version's deadline.
SELECT is(pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a',64), repeat('d',64), repeat('b',64)),
  'reserved', 'fixture: Ana commits revision 1');
SELECT is(pg_temp.call('dora', 'pkg-d', 'request-d1',
    pg_temp.descriptor(p_package=>'pkg-d', p_document=>'doc-d', p_segment=>'segment-d-1', p_session=>'capture-session-d'),
    0, repeat('a',64), repeat('e',64), repeat('b',64)),
  'reserved', 'fixture: Dora commits revision 1');
SELECT is(pg_temp.ask('ana', $$ SELECT outcome FROM app.request_submission('doc-a', 1) $$), 'requested',
  'Ana requests revision 1');
SELECT is(pg_temp.ask('dora', $$ SELECT outcome FROM app.request_submission('doc-d', 1) $$), 'requested',
  'Dora requests revision 1');
SELECT is(pg_temp.request_due('ana'), '1 day', 'Ana''s request pins her extended deadline');
SELECT is(pg_temp.request_due('dora'), '-1 days', 'Dora''s request pins the version''s deadline');

-- What the screens show before anything is recorded.
SELECT is(pg_temp.workspace('ana'), '1 day -', 'Ana''s workspace shows her extended deadline');
SELECT is(pg_temp.workspace('dora'), '-1 days -', 'Dora''s workspace shows the version''s deadline');
SELECT is(pg_temp.overview(), 'ana:1 day:no dora:-1 days:no',
  'the overview shows each student''s own deadline');

-- Forgeries of the owner role against Dora's request, each rolled back: the
-- deadline of a submission is the request's (or, without one, the version's).
CREATE FUNCTION pg_temp.forge(p_due text, p_request_due text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask_as('ductus_evidence', 'anon', format($q$ WITH x AS (
    INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id,
                                     assignment_version, revision, artifact_hash, requested_at, due_at,
                                     request_due_at, recorded_at)
    SELECT r.id, r.institution_id, r.principal_id, r.assignment_id, r.assignment_version, r.revision,
           r.content_hash, r.requested_at, %s, %s, now() + interval '1 hour'
      FROM evidence.submission_request r WHERE r.principal_id = {dora}
    RETURNING 1) SELECT count(*)::text FROM x $q$, p_due, p_request_due))
$$;
-- The answer of one forgery, with whatever it wrote rolled back.
CREATE FUNCTION pg_temp.forge_alone(p_due text, p_request_due text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    v := pg_temp.forge(p_due, p_request_due);
    RAISE EXCEPTION USING ERRCODE = 'ZZ167';
  EXCEPTION WHEN SQLSTATE 'ZZ167' THEN
    RETURN v;
  END;
END
$$;
SELECT is(pg_temp.forge_alone('r.due_at', 'r.due_at'), '1',
  'control: the request''s own deadline passes every key (the row is rolled back)');
SELECT matches(pg_temp.forge_alone($$ r.due_at + interval '2 days' $$, 'r.due_at'), '^23514:',
  'a submission cannot judge against another deadline than the one it names');
SELECT matches(pg_temp.forge_alone($$ r.due_at + interval '2 days' $$, $$ r.due_at + interval '2 days' $$),
  '^23503: .*evidence_submission_request_due_fkey',
  'a submission cannot name another deadline than its request''s');
SELECT matches(pg_temp.forge_alone($$ now() + interval '1 day' $$, 'NULL'),
  '^23503: .*submission_version_institution_fkey',
  'without the request''s deadline only the version''s own deadline is accepted');

-- An extension for all after the click leaves both requests as they are.
-- (Its earlier_submissions flag is SRV-1108's: it counts recorded submissions,
-- and a request still waiting for its submission is not one.)
SELECT ok(pg_temp.extend('NULL', 2, 'all') IN ('true', 'false'),
  'Vesna extends the deadline for all while both submissions are pending');
SELECT is(pg_temp.record('ana', pg_temp.h('d')), 'recorded 1 day f',
  'Ana''s submission after the version''s deadline is on time: before her extended deadline');
SELECT is(pg_temp.record('dora', pg_temp.sha(repeat('e',64))), 'recorded -1 days t',
  'Dora''s is after the deadline: no extension of hers held at the click');
SELECT is(pg_temp.submission('ana'), '1 day f t t', 'Ana''s row carries her request''s deadline');
SELECT is(pg_temp.submission('dora'), '-1 days t t t', 'Dora''s row carries hers');
SELECT is(pg_temp.workspace('ana'), '2 days false', 'the workspace shows the deadline in force and the recorded flag');
SELECT is(pg_temp.workspace('dora'), '2 days true', 'the same for Dora');
SELECT is(pg_temp.overview(), 'ana:2 days:on-time dora:2 days:late',
  'the overview: the deadline in force, the lateness as recorded');

-- A later extension of Dora's own never changes her recorded submission.
SELECT is(pg_temp.extend('{dora}', 3, 'technical'), 'true', 'Vesna extends Dora''s deadline after she submitted');
SELECT is(pg_temp.submission('dora'), '-1 days t t t', 'Dora''s recorded submission is unchanged');
SELECT is(pg_temp.record('dora', pg_temp.sha(repeat('e',64))), 'existing -1 days t',
  'recording again returns the earlier submission as it was');
SELECT is(pg_temp.ask_as('ductus_evidence', 'anon',
    $$ UPDATE evidence.submission SET request_due_at = NULL WHERE principal_id = {dora} RETURNING 1 $$),
  'ZD403: append-only row', 'not even the owner role changes the row');
SELECT is(pg_temp.due('dora'), '3 days', 'the deadline in force for Dora is the new one');

SELECT * FROM finish();
ROLLBACK;
