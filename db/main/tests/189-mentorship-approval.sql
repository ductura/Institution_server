-- SRV-1407 (Plan M2, D-204): a mentorship exists only once the teacher a
-- student asked approves the request; the approval of the per-request route,
-- app.approve_mentorship_request_once, is idempotent. Personas of
-- institution.inc and mentorship.inc, all invented: Boris asks Vesna, Dora
-- asks Vesna and is declined, Tomo asks Petra (fak-b) and withdraws.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
\ir fixtures/mentorship.inc
SELECT plan(29);

CREATE FUNCTION pg_temp.mentorships() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.mentorship $$;
CREATE FUNCTION pg_temp.assignments() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM institution.assignment $$;
CREATE FUNCTION pg_temp.approvals() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM audit.mentorship_event WHERE kind = 'approved' $$;
-- Mentorships the fixture did not write that no approved request points to.
CREATE FUNCTION pg_temp.unbacked() RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM institution.mentorship m
  WHERE m.confirmed_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM institution.mentorship_request r
                    WHERE r.mentorship_id = m.id AND r.approved_at IS NOT NULL)
$$;

-- 1. The catalogue and who may call it.
SELECT is(
  (SELECT pg_get_function_identity_arguments(p.oid) || ' ' || pg_get_function_result(p.oid)
          || CASE WHEN p.prosecdef THEN ' definer' ELSE '' END
          || CASE WHEN coalesce('search_path=""' = ANY (p.proconfig), false) THEN ' pinned' ELSE '' END
          || ' ' || p.proowner::regrole::text
   FROM pg_proc p WHERE p.oid = 'app.approve_mentorship_request_once(uuid)'::regprocedure),
  'p_request_id uuid uuid definer pinned ductus_identity',
  'the approval takes no actor, is SECURITY DEFINER with an empty search_path and belongs to the owner role');
SELECT is_empty(
  $$ SELECT r.rolname FROM (SELECT rolname::text FROM pg_roles
                            WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
                            UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.approve_mentorship_request_once(uuid)', 'EXECUTE') $$,
  'only ductus_app and the owner execute the approval');
SELECT ok(has_function_privilege('ductus_app', 'app.approve_mentorship_request_once(uuid)', 'EXECUTE'),
  'the web role executes the approval');
SELECT is_empty(
  $$ SELECT p FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
     WHERE has_table_privilege('ductus_app', 'institution.mentorship', p)
        OR has_table_privilege('ductus_app', 'institution.mentorship_request', p) $$,
  'the web role writes neither mentorships nor requests directly');

-- 2. Requests create no mentorship.
INSERT INTO ref VALUES
  ('rb', pg_temp.ask('boris', $$ SELECT institution.request_mentorship({vesna}, 'bachelor_thesis') $$)),
  ('rd', pg_temp.ask('dora', $$ SELECT institution.request_mentorship({vesna}, 'master_thesis') $$)),
  ('rt', pg_temp.ask('tomo', $$ SELECT institution.request_mentorship({petra}, 'doctoral_thesis') $$));
SELECT is((SELECT count(*) FROM ref WHERE name IN ('rb', 'rd', 'rt') AND val ~ '^[0-9a-f-]{36}$'), 3::bigint,
  'Boris, Dora and Tomo each request a mentorship');
SELECT is(pg_temp.mentorships(), 3::bigint, 'requested: no mentorship beyond the fixture''s three');
SELECT is(pg_temp.ask('boris', $$ INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type)
                                  VALUES ({fak_a}, {vesna}, {boris}, 'bachelor_thesis') RETURNING 'written' $$),
          '42501: permission denied for table mentorship', 'a student cannot write a mentorship directly');
SELECT is(pg_temp.ask('vesna', $$ INSERT INTO institution.mentorship (institution_id, mentor_id, student_id, work_type)
                                  VALUES ({fak_a}, {vesna}, {boris}, 'bachelor_thesis') RETURNING 'written' $$),
          '42501: permission denied for table mentorship', 'nor can the teacher, past the approval');

-- 3. Declined and withdrawn requests create none and cannot be approved.
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.decline_mentorship_request({rd}, NULL)::text $$), 'true',
  'Vesna declines Dora''s request');
SELECT is(pg_temp.ask('tomo', $$ SELECT institution.withdraw_mentorship_request({rt})::text $$), 'true',
  'Tomo withdraws the own request');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.approve_mentorship_request_once({rd}) $$), 'ZD409: conflict',
  'declined: the approval is refused');
SELECT is(pg_temp.ask('petra', $$ SELECT app.approve_mentorship_request_once({rt}) $$), 'ZD409: conflict',
  'withdrawn: the approval is refused');
SELECT is(pg_temp.mentorships(), 3::bigint, 'declined and withdrawn: still no new mentorship');

-- 4. Nobody but the teacher asked approves; each refusal writes nothing.
CREATE TEMP TABLE refusal (n int PRIMARY KEY, actor text, expected text, note text);
INSERT INTO refusal VALUES
  (1, 'anon', 'ZD401: not authenticated', 'no session'),
  (2, 'boris', 'ZD403: forbidden', 'the student cannot approve the own request'),
  (3, 'ana', 'ZD403: forbidden', 'another student'),
  (4, 'marko', 'ZD403: forbidden', 'another teacher of the institution'),
  (5, 'iva', 'ZD403: forbidden', 'the administrator'),
  (6, 'petra', 'ZD403: forbidden', 'a teacher of another institution (the route reads 404)'),
  (7, 'nina', 'ZD403: forbidden', 'a teacher without a confirmed role');
SELECT is(pg_temp.ask(c.actor, $$ SELECT app.approve_mentorship_request_once({rb}) $$), c.expected,
          format('refusal %s: %s', c.n, c.note))
FROM refusal c ORDER BY c.n;
SELECT is(pg_temp.mentorships() || '/' || pg_temp.approvals(), '3/0', 'the refusals wrote no mentorship and no approval');

-- 5. Vesna approves twice: one mentorship, one work, one audit row.
INSERT INTO ref VALUES ('mb', pg_temp.ask('vesna', $$ SELECT app.approve_mentorship_request_once({rb}) $$));
SELECT is(
  (SELECT r.mentorship_id::text FROM institution.mentorship_request r WHERE r.id = pg_temp.id('rb') AND r.approved_at IS NOT NULL),
  (SELECT val FROM ref WHERE name = 'mb'),
  'the approval returns the mentorship the approved request points to');
SELECT row_eq(
  $$ SELECT mentor_id, student_id, work_type, confirmed_by FROM institution.mentorship WHERE id = pg_temp.id('mb') $$,
  ROW(pg_temp.id('vesna'), pg_temp.id('boris'), 'bachelor_thesis'::text, pg_temp.id('vesna')),
  'Vesna mentors Boris''s bachelor thesis and is recorded as the one who confirmed it');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.approve_mentorship_request_once({rb}) $$), (SELECT val FROM ref WHERE name = 'mb'),
  'approving again returns the same mentorship');
SELECT is(pg_temp.mentorships() || '/' || pg_temp.approvals() || '/' || pg_temp.assignments(), '4/1/7',
  'the second approval wrote nothing: one mentorship, one approval and one work more');
SELECT is(pg_temp.ask('boris', $$ SELECT app.approve_mentorship_request_once({rb}) $$), 'ZD403: forbidden',
  'the student cannot approve even after the teacher did');
SELECT is(pg_temp.unbacked(), 0::bigint, 'every confirmed mentorship has an approved request pointing to it');

-- 6. A revoked teacher no longer approves, not even again.
SELECT is(pg_temp.ask('iva', $$ SELECT institution.revoke_teacher_role({vesna})::text $$), 'true', 'Iva revokes Vesna''s role');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.approve_mentorship_request_once({rb}) $$), 'ZD403: forbidden',
  'a revoked teacher gets ZD403 for the approved request as well');

SELECT * FROM finish();
ROLLBACK;
