-- app.institution_config, app.publish_institution_config,
-- app.assignment_institution_config and the version an assignment keeps
-- (SRV-1405, M2.12, M2.17; D-117, D-175, D-199). Acceptance of the task:
-- (1) an UPDATE of a stored version fails and an administrator of another
-- institution sees no row; (3) an assignment created before a new version
-- still reads the older one. Synthetic fixtures only (fixtures/institution.inc):
-- every institution, person, course and rule below is invented.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';

SELECT plan(47);

-- Rules as the server sends them after its schema check (ductura-faculty-rules-v1).
INSERT INTO ref VALUES
  ('rules_v1', '{"citationStyle": "fpzg", "workLanguages": ["hr", "en"], "defaultWorkLanguage": "hr"}'),
  ('rules_v2', '{"citationStyle": "fpzg", "workLanguages": ["hr"], "defaultWorkLanguage": "hr"}'),
  ('rules_b', '{"citationStyle": "fpzg", "workLanguages": ["en", "hr"], "defaultWorkLanguage": "en"}');

-- Create an assignment in K1 as Vesna through the real RPC; returns its id.
CREATE FUNCTION pg_temp.new_assignment(p_title text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format(
    $q$SELECT institution.create_assignment({k1}, %L, 'Upute za izmišljeni zadatak.', 'essay', now(),
         now() + interval '30 days', 'prohibited', '{}'::text[], 'basic', false, NULL, NULL)::text$q$, p_title))
$$;

-- 1. The table: forced RLS, the identity owner, app reads and never writes.
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole,
  'institution_config has forced RLS and the identity owner')
  FROM pg_class c WHERE c.oid = 'app.institution_config'::regclass;
SELECT ok(has_table_privilege('ductus_app', 'app.institution_config', 'SELECT')
    AND NOT has_table_privilege('ductus_app', 'app.institution_config', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('public', 'app.institution_config', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('ductus_worker', 'app.institution_config', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'the application only reads institution_config; PUBLIC and the worker hold nothing');
SELECT results_eq(
  $$ SELECT policyname::text COLLATE "default", cmd::text COLLATE "default", roles::text[] COLLATE "default"
       FROM pg_policies WHERE schemaname = 'app' AND tablename = 'institution_config' ORDER BY policyname $$,
  $$ VALUES ('institution_config_owner'::text, 'ALL'::text, ARRAY['ductus_identity']),
            ('institution_config_read', 'SELECT', ARRAY['ductus_app']) $$,
  'institution_config has the owner policy and one read policy for the application');
SELECT ok(p.prosecdef AND 'search_path=""' = ANY (p.proconfig)
    AND p.proowner = 'ductus_identity'::regrole
    AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'),
  f.signature || ': definer RPC with an empty path, only for the application')
  FROM (VALUES ('app.publish_institution_config(integer,jsonb)'),
               ('app.assignment_institution_config(uuid)')) f (signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
SELECT ok(NOT p.prosecdef AND 'search_path=""' = ANY (p.proconfig)
    AND NOT has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE'),
  f.signature || ': trigger function, executable by nobody else')
  FROM (VALUES ('app.refuse_institution_config_change()')) f (signature)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature);
SELECT ok(p.prosecdef AND 'search_path=""' = ANY (p.proconfig) AND p.proowner = 'ductus_identity'::regrole
    AND NOT has_function_privilege('ductus_app', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE'),
  'institution.pin_assignment_config(): definer trigger of the owner, executable by nobody else')
  FROM pg_proc p WHERE p.oid = 'institution.pin_assignment_config()'::regprocedure;

-- 2. Nobody but an administrator of the own institution publishes.
SELECT is(pg_temp.ask('anon', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  'ZD401: not authenticated', 'without a session nothing is published');
SELECT is(pg_temp.ask('vesna', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  'ZD403: forbidden', 'a teacher does not publish the rules of the faculty');
SELECT is(pg_temp.ask('ana', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  'ZD403: forbidden', 'a student does not publish the rules of the faculty');
SELECT is(pg_temp.ask('nina', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  'ZD403: forbidden', 'an unconfirmed role publishes nothing');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(0, '[]'::jsonb)::text $$),
  'ZD422: invalid input', 'rules that are not an object are refused');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(0, NULL)::text $$),
  'ZD422: invalid input', 'missing rules are refused');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(-1, {rules_v1}::jsonb)::text $$),
  'ZD422: invalid input', 'a negative expected version is refused');
SELECT is(pg_temp.ask('iva', format($$ SELECT app.publish_institution_config(0, jsonb_build_object('x', %L))::text $$,
    repeat('a', 16400))),
  'ZD422: invalid input', 'rules larger than 16 KiB are refused');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(1, {rules_v1}::jsonb)::text $$),
  'ZD409: conflict', 'an expected version that does not exist yet is a conflict');
SELECT is((SELECT count(*)::integer FROM app.institution_config), 0, 'no refused call left a row');

-- Criterion 3, before: Z1 of the fixture and A1 are created while fak-a has no version.
SELECT ok(pg_temp.new_assignment('Prije pravila') ~ '^[0-9a-f-]{36}$', 'a teacher creates A0 before any version');
INSERT INTO ref SELECT 'a0', a.id::text FROM institution.assignment a
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1 WHERE v.title = 'Prije pravila';

SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  '1', 'the administrator of fak-a publishes version 1');
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(0, {rules_v1}::jsonb)::text $$),
  'ZD409: conflict', 'publishing over a stale latest version is a conflict');
SELECT is(pg_temp.ask('lea', $$ SELECT app.publish_institution_config(0, {rules_b}::jsonb)::text $$),
  '1', 'the administrator of fak-b numbers the own versions from 1');
SELECT is((SELECT created_by FROM app.institution_config WHERE institution_id = pg_temp.id('fak_a') AND version = 1),
  pg_temp.id('iva'), 'a version records the administrator who published it');

-- 3. Reading: the administrator of the institution only (criterion 1, second half).
SELECT is(pg_temp.ask('iva', $$ SELECT string_agg(institution_id::text || ':' || version, ',') FROM app.institution_config $$),
  pg_temp.id('fak_a')::text || ':1', 'the administrator of fak-a sees only the version of fak-a');
SELECT is(pg_temp.ask('lea', $$ SELECT count(*)::text FROM app.institution_config WHERE institution_id = {fak_a} $$),
  '0', 'the administrator of another institution sees no row of fak-a');
SELECT is(pg_temp.ask('lea', $$ SELECT string_agg(institution_id::text || ':' || version, ',') FROM app.institution_config $$),
  pg_temp.id('fak_b')::text || ':1', 'the administrator of fak-b sees only the version of fak-b');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*)::text FROM app.institution_config $$),
  '0', 'a teacher reads no version directly');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM app.institution_config $$),
  '0', 'a student reads no version directly');
SELECT is(pg_temp.ask('anon', $$ SELECT count(*)::text FROM app.institution_config $$),
  '0', 'without a session no version is visible');

-- 4. A stored version never changes (criterion 1, first half).
SELECT is(pg_temp.ask('iva', $$ UPDATE app.institution_config SET rules = {rules_v2}::jsonb RETURNING version::text $$),
  '42501: permission denied for table institution_config', 'the application cannot UPDATE a version');
SELECT is(pg_temp.ask('iva', $$ DELETE FROM app.institution_config RETURNING version::text $$),
  '42501: permission denied for table institution_config', 'the application cannot DELETE a version');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
    $$ UPDATE app.institution_config SET rules = {rules_v2}::jsonb WHERE institution_id = {fak_a} RETURNING version::text $$),
  'ZD409: institution config version is immutable', 'even the owner cannot UPDATE a stored version');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
    $$ DELETE FROM app.institution_config WHERE institution_id = {fak_a} RETURNING version::text $$),
  'ZD409: institution config version is immutable', 'even the owner cannot DELETE a stored version');
-- A plain TRUNCATE already fails on the assignments' foreign key; the
-- statement trigger refuses it also once nothing refers to a version.
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'app.institution_config'::regclass
    AND t.tgname = 'institution_config_no_truncate' AND t.tgenabled = 'O' AND (t.tgtype & 32) <> 0
    AND t.tgfoid = 'app.refuse_institution_config_change()'::regprocedure),
  'a statement trigger refuses TRUNCATE of the versions');
SELECT is((SELECT rules FROM app.institution_config WHERE institution_id = pg_temp.id('fak_a') AND version = 1),
  (SELECT val::jsonb FROM ref WHERE name = 'rules_v1'), 'version 1 of fak-a is unchanged');

-- 5. Criterion 3: an assignment keeps the version it was created under.
SELECT ok(pg_temp.new_assignment('Pod verzijom 1') ~ '^[0-9a-f-]{36}$', 'a teacher creates A1 under version 1');
INSERT INTO ref SELECT 'a1', a.id::text FROM institution.assignment a
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1 WHERE v.title = 'Pod verzijom 1';
SELECT is(pg_temp.ask('iva', $$ SELECT app.publish_institution_config(1, {rules_v2}::jsonb)::text $$),
  '2', 'the administrator publishes version 2');
SELECT ok(pg_temp.new_assignment('Pod verzijom 2') ~ '^[0-9a-f-]{36}$', 'a teacher creates A2 under version 2');
INSERT INTO ref SELECT 'a2', a.id::text FROM institution.assignment a
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = 1 WHERE v.title = 'Pod verzijom 2';

SELECT is(pg_temp.ask('ana', $$ SELECT version || ' ' || (rules = {rules_v1}::jsonb)::text
                                 FROM app.assignment_institution_config({a1}) $$),
  '1 true', 'A1, created before version 2, still reads version 1 with its rules');
SELECT is(pg_temp.ask('vesna', $$ SELECT version || ' ' || (rules = {rules_v2}::jsonb)::text
                                   FROM app.assignment_institution_config({a2}) $$),
  '2 true', 'A2 reads version 2');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM app.assignment_institution_config({a0}) $$),
  '0', 'A0, created before any version, has no version');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM app.assignment_institution_config({z1}) $$),
  '0', 'an assignment from before the migration has no version');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
    $$ UPDATE institution.assignment SET config_version = 2 WHERE id = {a1} RETURNING config_version::text $$),
  'ZD409: config version is immutable', 'the version of an assignment never changes, not even for the owner');
SELECT is((SELECT config_version FROM institution.assignment WHERE id = pg_temp.id('a1')), 1,
  'A1 is still pinned to version 1');

-- 6. Reading an assignment's version follows the assignment, never the role.
SELECT is(pg_temp.ask('anon', $$ SELECT count(*)::text FROM app.assignment_institution_config({a1}) $$),
  'ZD401: not authenticated', 'without a session no version is read');
SELECT is(pg_temp.ask('lea', $$ SELECT count(*)::text FROM app.assignment_institution_config({a1}) $$),
  'ZD403: forbidden', 'the administrator of another institution reads no version of A1');
SELECT is(pg_temp.ask('boris', $$ SELECT count(*)::text FROM app.assignment_institution_config({a1}) $$),
  'ZD403: forbidden', 'a student outside the course reads no version of A1');
SELECT is(pg_temp.ask('ana', $$ SELECT count(*)::text FROM app.assignment_institution_config({nobody}) $$),
  'ZD403: forbidden', 'an assignment that does not exist reads as forbidden');

SELECT * FROM finish();
ROLLBACK;
