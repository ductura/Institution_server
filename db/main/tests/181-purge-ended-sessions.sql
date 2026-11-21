-- SRV-1303 (M10.0-S2; D-273 MQ08, MQ14): app.purge_ended_sessions(p_before),
-- the first scheduled job of the worker. It deletes only the sessions that
-- ended before the cut and returns their number; live sessions and sessions
-- that ended after the cut stay. Only ductus_retention executes it; the web
-- role does not. A repeat with the same cut deletes nothing. Synthetic
-- fixtures only: institutions a.example and b.example, nina and ana in A, lea
-- in B. now() is fixed for the transaction, so every boundary below is exact.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL lc_messages TO 'C';
CREATE ROLE ductus_test_stranger_181 NOLOGIN;
GRANT USAGE ON SCHEMA public TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_identity, ductus_test_stranger_181;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_identity, ductus_test_stranger_181;

SELECT plan(33);

INSERT INTO identity.institution (id, slug) VALUES
  ('00000000-0000-4000-8000-00000000181a', 'test-181-a'),
  ('00000000-0000-4000-8000-00000000181b', 'test-181-b');
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id) VALUES
  ('00000000-0000-4000-8000-0000000181a1', '00000000-0000-4000-8000-00000000181a', 'https://issuer.test', 'sub-181-nina', 'nina@a.example'),
  ('00000000-0000-4000-8000-0000000181a2', '00000000-0000-4000-8000-00000000181a', 'https://issuer.test', 'sub-181-ana', 'ana@a.example'),
  ('00000000-0000-4000-8000-0000000181b1', '00000000-0000-4000-8000-00000000181b', 'https://issuer.test', 'sub-181-lea', 'lea@b.example');

-- One row per fixture session. The cut of the schedule is now() - 30 days
-- (D-200 P2); `ends` is when the session ended, relative to that cut.
CREATE TEMP TABLE fx (
  name text PRIMARY KEY, person text NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL, closed_at timestamptz, close_reason text
);
INSERT INTO fx VALUES
  -- Ended before the cut: deleted.
  ('closed_old',     'nina', now() - interval '31 days 1 hour', now() - interval '30 days 13 hours', now() - interval '31 days 1 hour', now() - interval '31 days', 'logout'),
  ('closed_by_idp',  'lea',  now() - interval '45 days 1 hour', now() - interval '44 days 13 hours', now() - interval '45 days 1 hour', now() - interval '45 days', 'backchannel_logout'),
  ('closed_edge',    'ana',  now() - interval '30 days 2 hours', now() - interval '29 days 14 hours', now() - interval '30 days 2 hours', now() - interval '30 days 1 second', 'logout'),
  ('expired_old',    'nina', now() - interval '32 days', now() - interval '31 days 12 hours', now() - interval '31 days 13 hours', NULL, NULL),
  ('idle_old',       'ana',  now() - interval '31 days 3 hours', now() - interval '30 days 15 hours', now() - interval '31 days 3 hours', NULL, NULL),
  -- Ended at the cut or after it, or not ended: kept.
  ('closed_at_cut',  'lea',  now() - interval '30 days 2 hours', now() - interval '29 days 14 hours', now() - interval '30 days 2 hours', now() - interval '30 days', 'logout'),
  ('closed_recent',  'nina', now() - interval '29 days 1 hour', now() - interval '28 days 13 hours', now() - interval '29 days 1 hour', now() - interval '29 days', 'logout_all'),
  ('expired_recent', 'ana',  now() - interval '29 days 12 hours', now() - interval '29 days', now() - interval '29 days 11 hours', NULL, NULL),
  ('closed_today',   'lea',  now() - interval '1 hour', now() + interval '11 hours', now() - interval '20 minutes', now() - interval '10 minutes', 'logout'),
  ('live',           'nina', now() - interval '1 hour', now() + interval '11 hours', now() - interval '5 minutes', NULL, NULL);

CREATE TEMP TABLE person (name text PRIMARY KEY, user_id uuid NOT NULL, institution_id uuid NOT NULL);
INSERT INTO person VALUES
  ('nina', '00000000-0000-4000-8000-0000000181a1', '00000000-0000-4000-8000-00000000181a'),
  ('ana',  '00000000-0000-4000-8000-0000000181a2', '00000000-0000-4000-8000-00000000181a'),
  ('lea',  '00000000-0000-4000-8000-0000000181b1', '00000000-0000-4000-8000-00000000181b');

-- The token hash of a fixture is the SHA-256 of its name.
INSERT INTO identity.session (token_hash, user_id, institution_id, created_at, expires_at, last_seen_at, closed_at, close_reason)
SELECT sha256(convert_to('181:' || f.name, 'UTF8')), p.user_id, p.institution_id,
       f.created_at, f.expires_at, f.last_seen_at, f.closed_at, f.close_reason
FROM fx f JOIN person p ON p.name = f.person;

-- Read only as the test owner.
CREATE FUNCTION pg_temp.present() RETURNS text[]
LANGUAGE sql AS $$
  SELECT coalesce(array_agg(f.name ORDER BY f.name), '{}')
  FROM fx f JOIN identity.session s ON s.token_hash = sha256(convert_to('181:' || f.name, 'UTF8'))
$$;
-- Rows outside these fixtures that end before a cut: the count the function
-- returns includes them, and nothing here assumes the database is empty.
CREATE FUNCTION pg_temp.foreign_before(p_cut timestamptz) RETURNS integer
LANGUAGE sql AS $$
  SELECT count(*)::integer FROM identity.session s
  WHERE LEAST(s.closed_at, s.expires_at, s.last_seen_at + interval '2 hours') < p_cut
    AND s.token_hash NOT IN (SELECT sha256(convert_to('181:' || name, 'UTF8')) FROM fx)
$$;
CREATE TEMP TABLE snap (label text PRIMARY KEY, val integer NOT NULL);
GRANT SELECT ON snap TO PUBLIC;
INSERT INTO snap VALUES
  ('accounts', (SELECT count(*)::integer FROM identity.user_account)),
  ('institutions', (SELECT count(*)::integer FROM identity.institution)),
  ('foreign_40', pg_temp.foreign_before(now() - interval '40 days')),
  ('foreign_30', pg_temp.foreign_before(now() - interval '30 days'));

-- 1. The shape: one cut in, one count out, a definer with an empty path.
SELECT has_function('app', 'purge_ended_sessions', ARRAY['timestamp with time zone'], 'app.purge_ended_sessions(timestamptz) exists');
SELECT ok(
  (SELECT p.prosecdef AND p.prorettype = 'integer'::regtype AND NOT p.proretset
          AND p.proconfig = ARRAY['search_path=""'] AND p.proowner = 'ductus_identity'::regrole
   FROM pg_proc p WHERE p.oid = 'app.purge_ended_sessions(timestamptz)'::regprocedure),
  'a SECURITY DEFINER of the session owner with an empty search_path that returns one integer'
);

-- 2. Who may execute it: the retention role and the owner, nobody else.
SELECT is_empty(
  $$ SELECT r.rolname
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_retention', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     WHERE has_function_privilege(r.rolname, 'app.purge_ended_sessions(timestamptz)', 'EXECUTE') $$,
  'only ductus_retention and the owner execute app.purge_ended_sessions'
);
SELECT ok(NOT has_function_privilege('ductus_app', 'app.purge_ended_sessions(timestamptz)', 'EXECUTE'),
  'the web role has no EXECUTE');
SELECT ok(has_function_privilege('ductus_retention', 'app.purge_ended_sessions(timestamptz)', 'EXECUTE'),
  'the retention role has EXECUTE');

SET LOCAL ROLE ductus_app;
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() - interval '30 days') $$, '42501', NULL, 'ductus_app: purge is denied');
RESET ROLE;
SET LOCAL ROLE ductus_auth;
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() - interval '30 days') $$, '42501', NULL, 'ductus_auth: purge is denied');
RESET ROLE;
SET LOCAL ROLE ductus_worker;
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() - interval '30 days') $$, '42501', NULL, 'ductus_worker: purge is denied');
RESET ROLE;
SET LOCAL ROLE ductus_test_stranger_181;
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() - interval '30 days') $$, '42501', NULL, 'a role without grants: purge is denied');
RESET ROLE;
SELECT is(pg_temp.present(), (SELECT array_agg(name ORDER BY name) FROM fx), 'the refused calls deleted nothing');

-- 3. A cut that is missing, infinite or inside the 30 days is refused.
SET LOCAL ROLE ductus_retention;
SELECT throws_ok($$ SELECT app.purge_ended_sessions(NULL) $$, 'ZD422', 'invalid input', 'no cut: refused');
SELECT throws_ok($$ SELECT app.purge_ended_sessions('infinity') $$, 'ZD422', 'invalid input', 'an infinite cut: refused');
SELECT throws_ok($$ SELECT app.purge_ended_sessions('-infinity') $$, 'ZD422', 'invalid input', 'a cut at minus infinity: refused');
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now()) $$, 'ZD422', 'invalid input', 'a cut of now: refused');
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() - interval '29 days 23 hours 59 minutes 59.999999 seconds') $$,
  'ZD422', 'invalid input', 'a cut one microsecond inside the 30 days: refused');
SELECT throws_ok($$ SELECT app.purge_ended_sessions(now() + interval '1 day') $$, 'ZD422', 'invalid input', 'a cut in the future: refused');
RESET ROLE;
SELECT is(pg_temp.present(), (SELECT array_agg(name ORDER BY name) FROM fx), 'the refused cuts deleted nothing');

-- 4. An earlier cut deletes only what ended before it.
SET LOCAL ROLE ductus_retention;
SELECT is(app.purge_ended_sessions(now() - interval '40 days'),
  1 + (SELECT val FROM snap WHERE label = 'foreign_40'),
  'a cut of 40 days deletes the one session closed 45 days ago');
RESET ROLE;
SELECT is(pg_temp.present(),
  ARRAY['closed_at_cut', 'closed_edge', 'closed_old', 'closed_recent', 'closed_today', 'expired_old', 'expired_recent', 'idle_old', 'live'],
  'only the session closed 45 days ago is gone');

-- 5. The cut of the schedule: what ended before now() - 30 days goes.
SET LOCAL ROLE ductus_retention;
SELECT is(app.purge_ended_sessions(now() - interval '30 days'),
  4 + (SELECT val FROM snap WHERE label = 'foreign_30') - (SELECT val FROM snap WHERE label = 'foreign_40'),
  'the 30-day cut deletes the four remaining sessions that ended before it and returns their number');
RESET ROLE;
SELECT is(pg_temp.present(),
  ARRAY['closed_at_cut', 'closed_recent', 'closed_today', 'expired_recent', 'live'],
  'kept: closed exactly at the cut, closed or expired within 30 days, closed today and the live session');
SELECT ok(NOT ('closed_old' = ANY (pg_temp.present())) AND NOT ('closed_edge' = ANY (pg_temp.present())),
  'a logged-out session is gone once its close is before the cut, by one second too');
SELECT ok(NOT ('expired_old' = ANY (pg_temp.present())), 'a session past its twelve hours before the cut is gone');
SELECT ok(NOT ('idle_old' = ANY (pg_temp.present())), 'a session idle for two hours before the cut is gone');
SELECT ok('live' = ANY (pg_temp.present()) AND 'closed_today' = ANY (pg_temp.present()),
  'the live session and the one closed today stay');

-- 6. Idempotent: the same slot again, or an earlier one, deletes nothing.
SET LOCAL ROLE ductus_retention;
SELECT is(app.purge_ended_sessions(now() - interval '30 days'), 0, 'the same cut a second time deletes nothing');
SELECT is(app.purge_ended_sessions(now() - interval '40 days'), 0, 'an earlier cut afterwards deletes nothing');
SELECT throws_ok($$ SELECT count(*) FROM identity.session $$, '42501', NULL, 'ductus_retention still cannot read the session table');
RESET ROLE;
SELECT is(pg_temp.present(),
  ARRAY['closed_at_cut', 'closed_recent', 'closed_today', 'expired_recent', 'live'],
  'the repeats left every kept session in place');

-- 7. Nothing else is touched.
SELECT is((SELECT count(*)::integer FROM identity.user_account), (SELECT val FROM snap WHERE label = 'accounts'),
  'the purge removes no account');
SELECT is((SELECT count(*)::integer FROM identity.institution), (SELECT val FROM snap WHERE label = 'institutions'),
  'the purge removes no institution');
SELECT is_empty(
  $$ SELECT conrelid::regclass::text FROM pg_constraint WHERE confrelid = 'identity.session'::regclass $$,
  'no table refers to a session row, so a purge leaves no reference behind'
);
SELECT has_function('identity', 'purge_ended_sessions', ARRAY[]::text[],
  'the earlier unscheduled identity.purge_ended_sessions() is still there');

SELECT * FROM finish();
ROLLBACK;
