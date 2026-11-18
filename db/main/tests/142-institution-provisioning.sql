-- Provisioning of an institution instance (contract Ductus#2028 c.6993786629
-- §2) and app.my_account (§3.3): the access matrix of identity.institution_seat,
-- who may call the three functions, every outcome of provision_institution,
-- that a provisioned institution takes a login at once, and the roles the
-- caller reads. Synthetic fixtures only (.test domains, invented names).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL lc_messages TO 'C';
GRANT USAGE ON SCHEMA public TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_migrator;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ductus_app, ductus_worker, ductus_retention, ductus_auth, ductus_migrator;

SELECT plan(43);

-- The answer of p_sql run as p_role (with p_token as the session, if any):
-- its text, or the SQLSTATE and message of the refusal.
CREATE FUNCTION pg_temp.as_role(p_role text, p_sql text, p_token text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_result text;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  PERFORM set_config('app.session_token', coalesce(p_token, ''), true);
  BEGIN
    EXECUTE p_sql INTO v_result;
  EXCEPTION WHEN OTHERS THEN
    v_result := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM set_config('app.session_token', '', true);
  RESET ROLE;
  RETURN v_result;
END
$$;
CREATE FUNCTION pg_temp.provision(p_slug text, p_name text, p_org text, p_issuer text,
                                  p_student int, p_teacher int, p_engineer int, p_admin int)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.as_role('ductus_auth', format(
    'SELECT outcome || CASE WHEN institution_id IS NULL THEN '' -'' ELSE '' +'' END
       FROM identity.provision_institution(%L, %L, %L, %L, %s, %s, %s, %s)',
    p_slug, p_name, p_org, p_issuer, p_student, p_teacher, p_engineer, p_admin))
$$;

-- 1. Matrix of identity.institution_seat: RLS forced, only the owner's
--    policy, and no role but the owner holds any right on it.
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
            WHERE oid = 'identity.institution_seat'::regclass),
          'institution_seat has RLS enabled and forced');
SELECT is((SELECT array_agg(polname::text || ':' || array_to_string(polroles::regrole[], ','))
             FROM pg_policy WHERE polrelid = 'identity.institution_seat'::regclass),
          ARRAY['institution_seat_owner:ductus_identity'],
          'institution_seat has only the owner policy');
SELECT is_empty(
  $$ SELECT r.rolname || ' ' || p FROM (SELECT rolname::text FROM pg_roles
                                        WHERE rolname LIKE 'ductus\_%' AND rolname <> 'ductus_identity'
                                        UNION ALL SELECT 'public') AS r (rolname)
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
     WHERE has_table_privilege(r.rolname, 'identity.institution_seat', p) $$,
  'no role but the owner, nor PUBLIC, holds any privilege on institution_seat'
);
SELECT matches(pg_temp.as_role(r, 'SELECT count(*)::text FROM identity.institution_seat'),
          '^42501: permission denied for (table institution_seat|schema identity)$',
          r || ' cannot read institution_seat')
  FROM unnest(ARRAY['ductus_app', 'ductus_auth', 'ductus_worker']) AS r;

-- 2. Who may call: provision and read only ductus_auth, my_account only
--    ductus_app; every one SECURITY DEFINER of ductus_identity, empty path.
SELECT t FROM unnest(ARRAY[
  'identity.provision_institution(text, text, text, text, integer, integer, integer, integer)',
  'identity.provisioned_institution(text)',
  'app.my_account()']) AS f
JOIN pg_proc p ON p.oid = f::regprocedure
CROSS JOIN LATERAL (VALUES
  (ok(p.prosecdef, f || ' is SECURITY DEFINER')),
  (is(pg_get_userbyid(p.proowner)::text, 'ductus_identity', f || ' belongs to ductus_identity')),
  (is(p.proconfig, ARRAY['search_path=""'], f || ' runs with an empty search_path'))
) AS v (t);
SELECT is(
  (SELECT array_agg(r.rolname::text ORDER BY r.rolname) FROM pg_roles r
    WHERE r.rolname LIKE 'ductus\_%' AND r.rolname NOT LIKE '%\_local' AND r.rolname <> 'ductus_identity'
      AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE')),
  ARRAY[g], f || ' is executable by ' || g || ' alone')
FROM (VALUES
  ('identity.provision_institution(text, text, text, text, integer, integer, integer, integer)', 'ductus_auth'),
  ('identity.provisioned_institution(text)', 'ductus_auth'),
  ('app.my_account()', 'ductus_app')) AS x (f, g);
SELECT is(pg_temp.as_role('ductus_app',
  $$ SELECT outcome FROM identity.provision_institution('pr-x', 'X (test)', 'x.prov.test', 'http://localhost:8090', 1, 1, 1, 1) $$),
  '42501: permission denied for function provision_institution',
  'the web process login cannot provision');

-- 3. Outcomes.
SELECT is(pg_temp.provision('pr-a', 'Fakultet A (test)', 'a.prov.test', 'http://localhost:8090', 200, 50, 3, 1),
          'created +', 'a new institution is created');
SELECT is(pg_temp.provision('pr-a', 'Fakultet A (test)', 'a.prov.test', 'http://localhost:8090', 200, 50, 3, 1),
          'existing +', 'the same data again is idempotent');
SELECT is(pg_temp.provision('pr-a', 'Fakultet A2 (test)', 'a.prov.test', 'http://localhost:8090', 200, 50, 3, 1),
          'slug_taken -', 'another display name on the slug is slug_taken');
SELECT is(pg_temp.provision('pr-a', 'Fakultet A (test)', 'a.prov.test', 'http://localhost:8090', 200, 50, 3, 2),
          'slug_taken -', 'other seats on the slug are slug_taken');
SELECT is(pg_temp.provision('pr-a', 'Fakultet A (test)', 'a.prov.test', 'https://idp.prov.test', 200, 50, 3, 1),
          'slug_taken -', 'another issuer on the slug is slug_taken');
SELECT is(pg_temp.provision('pr-a', 'Fakultet A (test)', 'a2.prov.test', 'http://localhost:8090', 200, 50, 3, 1),
          'slug_taken -', 'another home organisation on the slug is slug_taken');
SELECT is(pg_temp.provision('pr-b', 'Fakultet B (test)', 'a.prov.test', 'http://localhost:8090', 1, 1, 1, 1),
          'domain_taken -', 'a free slug with a taken home organisation is domain_taken');
INSERT INTO identity.institution (slug) VALUES ('pr-seeded');
SELECT is(pg_temp.provision('pr-seeded', 'Seeded (test)', 's.prov.test', 'http://localhost:8090', 1, 1, 1, 1),
          'slug_taken -', 'a slug that exists without provisioning is slug_taken');
SELECT is(pg_temp.provision('PR-A', 'X (test)', 'x.prov.test', 'http://localhost:8090', 1, 1, 1, 1),
          'ZD422: invalid input', 'an upper-case slug is refused');
SELECT is(pg_temp.provision('pr-c', E'Bad‮name', 'c.prov.test', 'http://localhost:8090', 1, 1, 1, 1),
          'ZD422: invalid input', 'a display name with a bidirectional control is refused');
SELECT is(pg_temp.provision('pr-c', 'C (test)', 'C.prov.test', 'http://localhost:8090', 1, 1, 1, 1),
          'ZD422: invalid input', 'an upper-case home organisation is refused');
SELECT is(pg_temp.provision('pr-c', 'C (test)', 'c.prov.test', 'ftp://idp.prov.test', 1, 1, 1, 1),
          'ZD422: invalid input', 'an issuer that is not http(s) is refused');
SELECT is(pg_temp.provision('pr-c', 'C (test)', 'c.prov.test', 'http://localhost:8090', -1, 1, 1, 1),
          'ZD422: invalid input', 'negative seats are refused');
SELECT is(pg_temp.provision('pr-c', 'C (test)', 'c.prov.test', 'http://localhost:8090', 1, 1, 1, 1000001),
          'ZD422: invalid input', 'seats over the limit are refused');
SELECT is((SELECT count(*)::int FROM identity.institution WHERE slug IN ('pr-b', 'pr-c', 'pr-x')), 0,
          'no refused or conflicting call left an institution');

-- 4. What was written, as the read gives it.
SELECT is(pg_temp.as_role('ductus_auth',
  $$ SELECT concat_ws('|', slug, display_name, aai_home_org, oidc_issuer, student, teacher, network_engineer, institution_admin)
       FROM identity.provisioned_institution('pr-a') $$),
  'pr-a|Fakultet A (test)|a.prov.test|http://localhost:8090|200|50|3|1',
  'the read returns every field as provisioned');
SELECT is(pg_temp.as_role('ductus_auth', $$ SELECT count(*)::text FROM identity.provisioned_institution('pr-seeded') $$),
          '0', 'an institution that takes no logins is not returned');
SELECT is(pg_temp.as_role('ductus_auth', $$ SELECT count(*)::text FROM identity.provisioned_institution('pr-none') $$),
          '0', 'an unknown slug returns no row');

-- 5. The new institution takes a login at once (open_session reads the rows).
SELECT is(pg_temp.as_role('ductus_auth',
  $$ SELECT (identity.open_session('http://localhost:8090', 'sub-pr-ana', 'ana@a.prov.test', 'a.prov.test',
             sha256(convert_to('prprprprprprprprprprprprprprprprprprprprpr1', 'UTF8')), 'Ana', 'Primjer', false, NULL) > now())::text $$),
  'true', 'an account of the provisioned home organisation signs in');

-- 6. my_account.
SELECT is(pg_temp.as_role('ductus_app', 'SELECT institution_slug FROM app.my_account()'),
          'ZD401: not authenticated', 'without a session my_account is ZD401');
SELECT is(pg_temp.as_role('ductus_app',
  'SELECT concat_ws(''|'', institution_slug, institution_display_name, display_name, array_to_string(roles, '',''))
     FROM app.my_account()', 'prprprprprprprprprprprprprprprprprprprprpr1'),
  'pr-a|Fakultet A (test)|Ana Primjer|student', 'a fresh account reads its institution, name and the student role');
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
SELECT u.institution_id, u.id, 'teacher', u.id, now() FROM identity.user_account u WHERE u.oidc_subject = 'sub-pr-ana';
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at, revoked_at)
SELECT u.institution_id, u.id, 'admin', u.id, now(), now() FROM identity.user_account u WHERE u.oidc_subject = 'sub-pr-ana';
SELECT is(pg_temp.as_role('ductus_app', 'SELECT array_to_string(roles, '','') FROM app.my_account()',
                          'prprprprprprprprprprprprprprprprprprprprpr1'),
          'teacher', 'a confirmed teacher reads teacher alone; a revoked admin role does not count');
INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by)
SELECT u.institution_id, u.id, u.id FROM identity.user_account u WHERE u.oidc_subject = 'sub-pr-ana';
INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
SELECT u.institution_id, u.id, 'admin', u.id, now() FROM identity.user_account u WHERE u.oidc_subject = 'sub-pr-ana';
SELECT is(pg_temp.as_role('ductus_app', 'SELECT array_to_string(roles, '','') FROM app.my_account()',
                          'prprprprprprprprprprprprprprprprprprprprpr1'),
          'institution_admin,network_engineer,teacher', 'every role in force is read, in name order');
SELECT is(pg_temp.as_role('ductus_auth', 'SELECT institution_slug FROM app.my_account()',
                          'prprprprprprprprprprprprprprprprprprprprpr1'),
          '42501: permission denied for schema app', 'the login callback cannot read my_account');

SELECT * FROM finish();
ROLLBACK;
