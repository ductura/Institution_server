-- SRV-1307 (M10.5; D-271 MQ02): the export of a student's own data through
-- the registry office. A clerk of the registry office (appointed by the
-- operator, as an administrator is, DAN-525) requests and confirms the
-- identity check; an administrator of the institution approves with the job
-- reference; the worker marks the package ready with the SHA-256 of a one-time
-- token; the link lets through exactly once within 24 hours.
--
-- Every person, reference and token below is invented
-- (fixtures/institution.inc: Iva and Lea are the administrators of fak-a and
-- fak-b, Ana and Dora students of fak-a, Boris a person of fak-a in no course;
-- Rada and Goran are added here as the clerks of fak-a and fak-b).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- The two clerks: a person of each institution, with a session of their own.
INSERT INTO person VALUES
  ('rada', '00000000-0000-4000-8000-000000000171', pg_temp.id('fak_a'), 'fak-a'),
  ('goran', '00000000-0000-4000-8000-000000000172', pg_temp.id('fak_b'), 'fak-b');
INSERT INTO tok VALUES ('rada', repeat('R', 43)), ('goran', repeat('Q', 43));
INSERT INTO ref SELECT name, id::text FROM person WHERE name IN ('rada', 'goran');
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
SELECT id, institution_id, 'https://issuer.test', 'sub-' || name, name || '@' || faculty || '.example'
  FROM person WHERE name IN ('rada', 'goran');
INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
SELECT sha256(convert_to(t.token, 'UTF8')), p.id, p.institution_id, now() + interval '1 hour'
  FROM person p JOIN tok t USING (name) WHERE p.name IN ('rada', 'goran');

-- The worker process: ductus_worker without a session.
CREATE FUNCTION pg_temp.work(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_worker', 'anon', p_sql) $$;
-- The token of a link and its SHA-256 as a bytea literal for ask().
CREATE FUNCTION pg_temp.token(p_n integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'izmisljeni-token-' || p_n || '-' || repeat('t', 30) $$;
CREATE FUNCTION pg_temp.hash_lit(p_n integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('%L::bytea', '\x' || encode(sha256(convert_to(pg_temp.token(p_n), 'UTF8')), 'hex'))
$$;
CREATE FUNCTION pg_temp.export_state(p_ref text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT e.status || ' ' || (e.token_hash IS NOT NULL)::text
    FROM app.student_data_export e WHERE e.id = (SELECT val::uuid FROM ref WHERE name = p_ref)
$$;

-- 1. Catalogue: owners, SECURITY DEFINER only for the RPCs, an empty
-- search_path, and EXECUTE only where it is needed.
SELECT is(
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
                     || p.prosecdef || ' ' || ('search_path=""' = ANY (p.proconfig)), ', '
                     ORDER BY p.oid::regprocedure::text COLLATE "C")
     FROM pg_proc p
    WHERE p.pronamespace = 'app'::regnamespace
      AND (p.proname LIKE '%student\_data\_export%' OR p.proname LIKE '%registry\_clerk%')),
  'app.appoint_registry_clerk(uuid,text) ductus_identity false true, '
  || 'app.approve_student_data_export(uuid,text) ductus_identity true true, '
  || 'app.consume_student_data_export(bytea) ductus_identity true true, '
  || 'app.refuse_student_data_export_removal() ductus_identity false true, '
  || 'app.registry_clerk_revoke_only() ductus_identity false true, '
  || 'app.request_student_data_export(uuid,boolean,text) ductus_identity true true, '
  || 'app.revoke_registry_clerk(uuid,text) ductus_identity false true, '
  || 'app.student_data_export_actor() ductus_identity false true, '
  || 'app.student_data_export_forward_only() ductus_identity false true, '
  || 'app.student_data_exports() ductus_identity true true, '
  || 'app.worker_expire_student_data_exports() ductus_identity true true, '
  || 'app.worker_mark_student_data_export_ready(uuid,bytea) ductus_identity true true, '
  || 'app.worker_student_data_exports_to_prepare() ductus_identity true true',
  'owners, SECURITY DEFINER only for the RPCs, and an empty search_path');
SELECT bag_eq(
  $$ SELECT r || ' ' || p.oid::regprocedure::text
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_evidence', 'ductus_auth',
                         'ductus_test_stranger', 'public']) r
      CROSS JOIN pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace
        AND (p.proname LIKE '%student\_data\_export%' OR p.proname LIKE '%registry\_clerk%')
        AND has_function_privilege(r, p.oid, 'EXECUTE') $$,
  ARRAY['ductus_app app.request_student_data_export(uuid,boolean,text)',
        'ductus_app app.approve_student_data_export(uuid,text)', 'ductus_app app.student_data_exports()',
        'ductus_app app.consume_student_data_export(bytea)',
        'ductus_worker app.worker_student_data_exports_to_prepare()',
        'ductus_worker app.worker_mark_student_data_export_ready(uuid,bytea)',
        'ductus_worker app.worker_expire_student_data_exports()'],
  'the web role runs the four RPCs, the worker its three steps, nobody else anything');
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole
    AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner),
  c.relname || ' has forced RLS and no privilege outside its owner')
  FROM pg_class c WHERE c.oid IN ('app.registry_clerk'::regclass, 'app.student_data_export'::regclass);
SELECT is(pg_temp.ask_as(r, 'iva', 'SELECT count(*)::text FROM app.student_data_export'),
  '42501: permission denied for table student_data_export', r || ' cannot read the table directly')
  FROM unnest(ARRAY['ductus_app', 'ductus_worker']) r;

-- 4 (acceptance). The token is never stored readable: the only column about
-- the link is token_hash, a bytea of exactly 32 bytes, and no other column
-- could take a token.
SELECT results_eq(
  $$ SELECT a.attname::text COLLATE "default", format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
      WHERE a.attrelid = 'app.student_data_export'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.attname LIKE '%token%' OR a.atttypid IN ('text'::regtype, 'bytea'::regtype, 'varchar'::regtype))
      ORDER BY a.attname $$,
  $$ VALUES ('identity_check_ref'::text, 'text'::text), ('job_ref', 'text'), ('status', 'text'),
            ('token_hash', 'bytea') $$,
  'the token is kept only as token_hash; the other text columns are references and the state');
SELECT ok(pg_get_constraintdef(c.oid) LIKE '%octet_length(token_hash) = 32%', 'token_hash holds exactly 32 bytes')
  FROM pg_constraint c WHERE c.conrelid = 'app.student_data_export'::regclass AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) LIKE '%octet_length(token_hash)%';

-- 2. The operator appoints the clerks on a request reference (the test runs
-- as the operator, the superuser); the web role cannot.
SELECT is(pg_temp.ask('iva', $$ SELECT app.appoint_registry_clerk({boris}, 'Zahtjev 1/2026')::text $$),
  '42501: permission denied for function appoint_registry_clerk', 'the web role cannot appoint a clerk');
SELECT is(pg_temp.ask('iva', $$ SELECT app.revoke_registry_clerk({rada}, 'Zahtjev 1/2026')::text $$),
  '42501: permission denied for function revoke_registry_clerk', 'the web role cannot revoke a clerk');
SELECT matches(app.appoint_registry_clerk(pg_temp.id('rada'), 'Zahtjev referada-a/2026')::text, '^[0-9a-f-]{36}$',
  'the operator appoints Rada as the clerk of fak-a');
SELECT matches(app.appoint_registry_clerk(pg_temp.id('goran'), 'Zahtjev referada-b/2026')::text, '^[0-9a-f-]{36}$',
  'the operator appoints Goran as the clerk of fak-b');
SELECT is((SELECT institution_id FROM app.registry_clerk WHERE user_id = pg_temp.id('goran')), pg_temp.id('fak_b'),
  'the clerk belongs to the institution of the person');
SELECT throws_ok($$ SELECT app.appoint_registry_clerk(pg_temp.id('rada'), 'Zahtjev 2/2026') $$, 'ZD409', 'conflict',
  'a clerk is not appointed twice');
SELECT throws_ok($$ SELECT app.appoint_registry_clerk(pg_temp.id('iva'), 'Zahtjev 3/2026') $$, 'ZD409', 'conflict',
  'a confirmed administrator is not appointed a clerk');
SELECT throws_ok($$ SELECT app.appoint_registry_clerk(pg_temp.id('nobody'), 'Zahtjev 4/2026') $$, 'ZD404',
  'not found', 'an unknown person is not appointed');
SELECT throws_ok($$ SELECT app.appoint_registry_clerk(pg_temp.id('boris'), ' Zahtjev ') $$, 'ZD422',
  'invalid input', 'the request reference is a plain label');

-- 3. The request: only a clerk, who is not an administrator, for a person of
-- the own institution, with the identity confirmed.
CREATE FUNCTION pg_temp.req(p_actor text, p_student text, p_verified text DEFAULT 'true',
  p_check text DEFAULT '''Provjera osobne iskaznice 12/2026''') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.request_student_data_export({%s}, %s, %s)::text', p_student,
                                     p_verified, p_check))
$$;
INSERT INTO ref VALUES ('e1', pg_temp.req('rada', 'ana'));
SELECT matches((SELECT val FROM ref WHERE name = 'e1'), '^[0-9a-f-]{36}$', 'Rada requests the export of Ana');
SELECT is(pg_temp.export_state('e1'), 'requested false', 'the request starts as requested, without a link');
SELECT is(pg_temp.req(c.actor, c.student), c.result, format('%s requests for %s: %s', c.actor, c.student, c.result))
FROM (VALUES
  ('iva', 'dora', 'ZD403: forbidden'),        -- acceptance 1: the administrator cannot request for the office
  ('vesna', 'dora', 'ZD403: forbidden'),
  ('marko', 'dora', 'ZD403: forbidden'),
  ('dora', 'dora', 'ZD403: forbidden'),
  ('lea', 'dora', 'ZD403: forbidden'),
  ('goran', 'dora', 'ZD404: not found'),      -- the clerk of fak-b does not reach a person of fak-a
  ('goran', 'nobody', 'ZD404: not found'),
  ('rada', 'rada', 'ZD403: forbidden'),       -- not for oneself
  ('rada', 'ana', 'ZD409: conflict'),         -- one open request per person
  ('closed', 'dora', 'ZD401: not authenticated'),
  ('anon', 'dora', 'ZD401: not authenticated')
) AS c (actor, student, result);
SELECT is(pg_temp.req('rada', 'dora', c.verified, c.check_ref), 'ZD422: invalid input',
  format('the request needs the identity confirmed and a plain reference: %s, %s', c.verified, c.check_ref))
FROM (VALUES ('false', '''Provjera 1/2026'''), ('NULL', '''Provjera 1/2026'''), ('true', 'NULL'),
             ('true', ''''''), ('true', ''' Provjera '''), ('true', format('%L', repeat('x', 121)))
) AS c (verified, check_ref);
SELECT is(
  (SELECT e.institution_id::text || ' ' || e.requested_by::text || ' ' || e.identity_check_ref
     FROM app.student_data_export e WHERE e.id = (SELECT val::uuid FROM ref WHERE name = 'e1')),
  pg_temp.id('fak_a')::text || ' ' || pg_temp.id('rada')::text || ' Provjera osobne iskaznice 12/2026',
  'the institution and the clerk come from the session; the identity check is recorded');

-- 4. The approval: only a confirmed administrator of the same institution,
-- who did not request; a clerk cannot approve (acceptance 1).
CREATE FUNCTION pg_temp.approve(p_actor text, p_export text, p_job text DEFAULT '''Posao izvoza 1/2026''')
RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format('SELECT app.approve_student_data_export({%s}, %s) IS NOT NULL', p_export, p_job))
$$;
SELECT is(pg_temp.approve(c.actor, 'e1'), c.result, format('%s approves: %s', c.actor, c.result))
FROM (VALUES
  ('rada', 'ZD403: forbidden'),               -- acceptance 1: the registry office cannot approve
  ('goran', 'ZD403: forbidden'),
  ('vesna', 'ZD403: forbidden'),
  ('ana', 'ZD403: forbidden'),
  ('lea', 'ZD404: not found'),                -- the administrator of fak-b does not reach a request of fak-a
  ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.approve('iva', 'e1', c.job), 'ZD422: invalid input', 'the job reference is a plain label: ' || c.job)
FROM (VALUES ('NULL'), (''''''), (''' Posao''')) AS c (job);
SELECT is(pg_temp.approve('iva', 'nobody'), 'ZD404: not found', 'an unknown request is not found');
SELECT is(pg_temp.export_state('e1'), 'requested false', 'no refused approval changed the request');
SELECT is(pg_temp.approve('iva', 'e1'), 'true', 'Iva approves the request with the job reference');
SELECT is(pg_temp.approve('iva', 'e1'), 'ZD409: conflict', 'a request is approved once');
SELECT is(
  (SELECT e.status || ' ' || e.approved_by::text || ' ' || e.job_ref
     FROM app.student_data_export e WHERE e.id = (SELECT val::uuid FROM ref WHERE name = 'e1')),
  'approved ' || pg_temp.id('iva')::text || ' Posao izvoza 1/2026', 'the request is approved by Iva with the job');

-- A clerk who later becomes a confirmed administrator neither requests nor
-- approves the own request (approved_by <> requested_by).
DO $$ BEGIN PERFORM app.appoint_registry_clerk(pg_temp.id('boris'), 'Zahtjev referada-boris/2026'); END $$;
INSERT INTO ref VALUES ('e2', pg_temp.req('boris', 'dora'));
SELECT matches((SELECT val FROM ref WHERE name = 'e2'), '^[0-9a-f-]{36}$', 'Boris, a clerk, requests for Dora');
DO $$ BEGIN PERFORM institution.appoint_institution_admin(pg_temp.id('boris'), 'Zahtjev boris/2026'); END $$;
SELECT is(pg_temp.req('boris', 'vesna'), 'ZD403: forbidden', 'a clerk who is a confirmed administrator cannot request');
SELECT is(pg_temp.approve('boris', 'e2'), 'ZD403: forbidden', 'the administrator does not approve the own request');
SELECT throws_ok(
  $$ UPDATE app.student_data_export SET status = 'approved', approved_by = requested_by, approved_at = now(),
            job_ref = 'Posao' WHERE id = (SELECT val::uuid FROM ref WHERE name = 'e2') $$,
  '23514', NULL, 'the table itself refuses an approval by the clerk who requested');
SELECT is(pg_temp.approve('iva', 'e2', '''Posao izvoza 2/2026'''), 'true', 'Iva approves the request of Dora');

-- 3 (acceptance). Who sees the requests: the clerks and administrators of the
-- institution all of them, the person their own, nobody of another
-- institution any.
SELECT is(pg_temp.ask(c.actor, 'SELECT count(*)::text FROM app.student_data_exports()'), c.result,
  format('%s sees %s requests', c.actor, c.result))
FROM (VALUES
  ('rada', '2'), ('iva', '2'), ('boris', '2'), ('ana', '1'), ('dora', '1'), ('vesna', '0'), ('nina', '0'),
  ('lea', '0'), ('goran', '0'), ('petra', '0'), ('tomo', '0'),
  ('closed', 'ZD401: not authenticated'), ('anon', 'ZD401: not authenticated')
) AS c (actor, result);
SELECT is(pg_temp.ask('ana', 'SELECT student_id::text FROM app.student_data_exports()'), pg_temp.id('ana')::text,
  'Ana sees only her own request');

-- 5. The worker: the approved jobs, then ready with the hash of a token.
SELECT is(pg_temp.work('SELECT count(*)::text FROM app.worker_student_data_exports_to_prepare()'), '2',
  'the worker sees the two approved jobs');
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM app.worker_student_data_exports_to_prepare()'),
  '42501: permission denied for function worker_student_data_exports_to_prepare', 'the web role does not');
SELECT is(pg_temp.ask('iva', format('SELECT app.worker_mark_student_data_export_ready({e1}, %s)::text', pg_temp.hash_lit(1))),
  '42501: permission denied for function worker_mark_student_data_export_ready', 'the web role cannot mark a job ready');
SELECT is(pg_temp.work($$ SELECT app.worker_mark_student_data_export_ready({e1}, '\x0102'::bytea)::text $$),
  'ZD422: invalid input', 'the link is a SHA-256 of 32 bytes');
SELECT is(pg_temp.work(format('SELECT app.worker_mark_student_data_export_ready({nobody}, %s)::text', pg_temp.hash_lit(1))),
  'ZD404: not found', 'an unknown job is not found');
SELECT is(pg_temp.work(format('SELECT (app.worker_mark_student_data_export_ready({e1}, %s) = now() + interval ''24 hours'')::text',
                              pg_temp.hash_lit(1))),
  'true', 'the job of Ana is ready; the link expires 24 hours later');
SELECT is(pg_temp.work(format('SELECT app.worker_mark_student_data_export_ready({e1}, %s)::text', pg_temp.hash_lit(9))),
  'ZD409: conflict', 'a ready job is not made ready again');
SELECT is(pg_temp.export_state('e1'), 'ready true', 'the request is ready with its hash');

-- 4 (acceptance). Nothing of the table holds the token in a readable form,
-- neither as text nor as its bytes.
SELECT is(
  (SELECT count(*) FROM app.student_data_export e
    WHERE e::text LIKE '%' || pg_temp.token(1) || '%'
       OR e::text LIKE '%' || encode(convert_to(pg_temp.token(1), 'UTF8'), 'hex') || '%'),
  0::bigint, 'the token itself is stored nowhere in the table');
SELECT is(
  (SELECT e.token_hash FROM app.student_data_export e WHERE e.id = (SELECT val::uuid FROM ref WHERE name = 'e1')),
  sha256(convert_to(pg_temp.token(1), 'UTF8')), 'only the SHA-256 of the token is stored');

-- 6. The one-time link (acceptance 2): it lets through exactly once.
SELECT is(pg_temp.ask_as('ductus_worker', 'anon', format('SELECT export_id::text FROM app.consume_student_data_export(%s)',
                                                         pg_temp.hash_lit(1))),
  '42501: permission denied for function consume_student_data_export', 'the worker does not consume a link');
SELECT is(pg_temp.ask('anon', $$ SELECT export_id::text FROM app.consume_student_data_export('\x00'::bytea) $$),
  'ZD422: invalid input', 'a link that is not a SHA-256 is invalid');
SELECT is(pg_temp.ask('anon', format('SELECT export_id::text FROM app.consume_student_data_export(%s)', pg_temp.hash_lit(7))),
  'ZD410: gone', 'an unknown link is gone');
SELECT is(pg_temp.ask('anon', format('SELECT export_id::text || '' '' || student_id::text || '' '' || job_ref
                                        FROM app.consume_student_data_export(%s)', pg_temp.hash_lit(1))),
  (SELECT val FROM ref WHERE name = 'e1') || ' ' || pg_temp.id('ana')::text || ' Posao izvoza 1/2026',
  'the link of Ana lets through once and names the job');
SELECT is(pg_temp.export_state('e1'), 'downloaded false', 'the request is downloaded and its hash is gone');
SELECT is(pg_temp.ask(c.actor, format('SELECT export_id::text FROM app.consume_student_data_export(%s)', pg_temp.hash_lit(1))),
  'ZD410: gone', format('the second use of the same link is gone (%s)', c.actor))
FROM unnest(ARRAY['anon', 'ana', 'iva']) AS c (actor);

-- 7. The link older than 24 hours (acceptance 2). The clock of the test cannot
-- move, so the ready time of Dora's job is set back with the triggers off.
SELECT is(pg_temp.work(format('SELECT (app.worker_mark_student_data_export_ready({e2}, %s) IS NOT NULL)::text',
                              pg_temp.hash_lit(2))),
  'true', 'the job of Dora is ready');
SET LOCAL session_replication_role = replica;
UPDATE app.student_data_export SET ready_at = now() - interval '24 hours 1 second',
       expires_at = now() - interval '1 second'
 WHERE id = (SELECT val::uuid FROM ref WHERE name = 'e2');
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.ask('anon', format('SELECT export_id::text FROM app.consume_student_data_export(%s)', pg_temp.hash_lit(2))),
  'ZD410: gone', 'a link older than 24 hours is gone');
SELECT is(pg_temp.export_state('e2'), 'ready true', 'the refused use wrote nothing');
SELECT is(pg_temp.ask('iva', 'SELECT app.worker_expire_student_data_exports()::text'),
  '42501: permission denied for function worker_expire_student_data_exports', 'the web role does not expire links');
SELECT is(pg_temp.work('SELECT app.worker_expire_student_data_exports()::text'), '1', 'the worker expires the one old link');
SELECT is(pg_temp.export_state('e2'), 'expired false', 'the expired request has lost its hash');
SELECT is(pg_temp.work('SELECT app.worker_expire_student_data_exports()::text'), '0', 'expiry runs once per link');
SELECT is(pg_temp.ask('anon', format('SELECT export_id::text FROM app.consume_student_data_export(%s)', pg_temp.hash_lit(2))),
  'ZD410: gone', 'an expired link stays gone');
SELECT matches(pg_temp.req('rada', 'dora'), '^[0-9a-f-]{36}$', 'after the expiry a new request for Dora is open');

-- 8. The rows only move forward and are never removed, not even by the owner.
CREATE FUNCTION pg_temp.as_owner(p_sql text) RETURNS text
LANGUAGE sql AS $$ SELECT pg_temp.ask_as('ductus_identity', 'anon', p_sql) $$;
SELECT is(pg_temp.as_owner(c.stmt), 'ZD403: append-only row', 'the owner cannot: ' || c.what)
FROM (VALUES
  ($$ UPDATE app.student_data_export SET status = 'ready' WHERE id = {e1} RETURNING 1 $$,
   'move a downloaded request back'),
  ($$ UPDATE app.student_data_export SET identity_check_ref = 'Drugo' WHERE id = {e1} RETURNING 1 $$,
   'change the recorded identity check'),
  ($$ DELETE FROM app.student_data_export WHERE false RETURNING 1 $$, 'delete a request'),
  ($$ DELETE FROM app.registry_clerk WHERE false RETURNING 1 $$, 'delete a clerk row'),
  ($$ UPDATE app.registry_clerk SET appoint_request_ref = 'Drugo' WHERE user_id = {rada} RETURNING 1 $$,
   'change a clerk row other than by its revocation')
) AS c (stmt, what);

-- 9. The operator revokes a clerk; the former clerk no longer requests.
SELECT ok(app.revoke_registry_clerk(pg_temp.id('rada'), 'Zahtjev opoziv-a/2026') IS NOT NULL,
  'the operator revokes Rada');
SELECT throws_ok($$ SELECT app.revoke_registry_clerk(pg_temp.id('rada'), 'Zahtjev opoziv-a/2026') $$, 'ZD404',
  'not found', 'a revoked clerk is not revoked again');
SELECT is(pg_temp.req('rada', 'marko'), 'ZD403: forbidden', 'a revoked clerk cannot request');
SELECT is(pg_temp.ask('rada', 'SELECT count(*)::text FROM app.student_data_exports()'), '0',
  'a revoked clerk sees no request of others');

SELECT * FROM finish();
ROLLBACK;
