-- F4 wave 2 #3 (design order 1.4, 20261220645000): the student of a declined
-- mentorship request reads the teacher's reason, and nobody else does through
-- the function. Personas of institution.inc; every request below is invented.
--
--   rq_reason   Ana asked Vesna for a bachelor thesis; declined with a reason
--   rq_bare     Ana asked Vesna for a master thesis; declined without one
--   rq_open     Ana asked Marko for a doctoral thesis; still open
--   rq_gone     Dora asked Vesna for a bachelor thesis; withdrew it
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- 1. The catalogue: a SECURITY DEFINER function of the identity role with an
-- empty search_path, executable only by the web role (and its owner).
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig) AND p.proowner = 'ductus_identity'::regrole
          AND pg_get_function_result(p.oid) = 'text',
  'student_mentorship_decline_reason is a SECURITY DEFINER text function of the identity role with an empty search_path')
FROM pg_proc p WHERE p.oid = 'app.student_mentorship_decline_reason(uuid)'::regprocedure;
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute the decline reason'
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.student_mentorship_decline_reason(uuid)', 'EXECUTE') $$,
  'only the application role and the owner execute the decline reason');
SELECT ok(has_function_privilege('ductus_app', 'app.student_mentorship_decline_reason(uuid)', 'EXECUTE'),
  'the application role can call the decline reason');
SELECT is_empty(
  $$ SELECT r FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence', 'ductus_auth']) r
      WHERE has_table_privilege(r, 'audit.mentorship_event', 'SELECT') $$,
  'the audit table itself stays closed to the other roles');

-- 2. The requests.
INSERT INTO ref VALUES
  ('rq_reason', pg_temp.ask('ana', $$ SELECT institution.request_mentorship({vesna}, 'bachelor_thesis') $$)),
  ('rq_bare', pg_temp.ask('ana', $$ SELECT institution.request_mentorship({vesna}, 'master_thesis') $$)),
  ('rq_open', pg_temp.ask('ana', $$ SELECT institution.request_mentorship({marko}, 'doctoral_thesis') $$)),
  ('rq_gone', pg_temp.ask('dora', $$ SELECT institution.request_mentorship({vesna}, 'bachelor_thesis') $$));
SELECT matches(r.val, '^[0-9a-f-]{36}$', 'the request exists: ' || r.name)
FROM ref r WHERE r.name IN ('rq_reason', 'rq_bare', 'rq_open', 'rq_gone');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.decline_mentorship_request({rq_reason}, 'Ovaj semestar nemam slobodnih termina.')::text $$),
  'true', 'Vesna declines the bachelor thesis with a reason');
SELECT is(pg_temp.ask('vesna', $$ SELECT institution.decline_mentorship_request({rq_bare}, NULL)::text $$),
  'true', 'Vesna declines the master thesis without a reason');
SELECT is(pg_temp.ask('dora', $$ SELECT institution.withdraw_mentorship_request({rq_gone})::text $$),
  'true', 'Dora withdraws her request');

-- 3. The cells. Only the student of the request reads; everyone else gets
-- the same answer as for a request that does not exist.
SELECT is(
  pg_temp.ask(c.actor, format($$ SELECT coalesce(app.student_mentorship_decline_reason({%s}), 'null') $$, c.req)),
  c.result, format('%s reads the decline reason of %s: %s', c.actor, c.req, c.result))
FROM (VALUES
  ('ana', 'rq_reason', 'Ovaj semestar nemam slobodnih termina.'),
  ('ana', 'rq_bare', 'null'),
  ('ana', 'rq_open', 'null'),
  ('dora', 'rq_gone', 'null'),
  ('dora', 'rq_reason', 'ZD403: forbidden'),
  ('boris', 'rq_reason', 'ZD403: forbidden'),
  ('tomo', 'rq_reason', 'ZD403: forbidden'),
  ('nina', 'rq_reason', 'ZD403: forbidden'),
  ('vesna', 'rq_reason', 'ZD403: forbidden'),
  ('marko', 'rq_reason', 'ZD403: forbidden'),
  ('marko', 'rq_open', 'ZD403: forbidden'),
  ('petra', 'rq_reason', 'ZD403: forbidden'),
  ('iva', 'rq_reason', 'ZD403: forbidden'),
  ('ana', 'rq_gone', 'ZD403: forbidden'),
  ('anon', 'rq_reason', 'ZD401: not authenticated'),
  ('expired', 'rq_reason', 'ZD401: not authenticated')
) AS c (actor, req, result);
SELECT is(pg_temp.ask('ana', $$ SELECT coalesce(app.student_mentorship_decline_reason('00000000-0000-4000-8000-00000000dead'), 'null') $$),
  'ZD403: forbidden', 'a request that does not exist reads as one that is not the caller''s');
SELECT is(pg_temp.ask('ana', $$ SELECT coalesce(app.student_mentorship_decline_reason(NULL), 'null') $$),
  'ZD403: forbidden', 'a null request reads as one that is not the caller''s');
-- The error carries no input: neither the request nor the reason.
SELECT unlike(pg_temp.ask('vesna', $$ SELECT app.student_mentorship_decline_reason({rq_reason}) $$),
  '%' || (SELECT val FROM ref WHERE name = 'rq_reason') || '%', 'the refusal does not name the request');

SELECT * FROM finish();
ROLLBACK;
