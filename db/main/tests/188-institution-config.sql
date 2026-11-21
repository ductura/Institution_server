-- SRV-1405: publication, tenant scope and the pin on ordinary assignment creation.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

SELECT bag_eq(
  $$ SELECT r || ' ' || p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
     CROSS JOIN unnest(ARRAY['ductus_app', 'ductus_auth', 'ductus_worker', 'ductus_evidence',
                             'ductus_retention', 'ductus_migrator', 'public']) AS r
     WHERE has_table_privilege(r, 'app.institution_config', p) $$,
  ARRAY['ductus_app SELECT'], 'only ductus_app has direct access among non-owner roles'
);
SELECT bag_eq(
  $$ SELECT r || ' ' || f
     FROM unnest(ARRAY['ductus_identity', 'ductus_app', 'ductus_auth', 'ductus_worker',
                        'ductus_evidence', 'ductus_retention', 'ductus_migrator', 'public']) AS r
     CROSS JOIN unnest(ARRAY['app.publish_institution_config(text,integer,jsonb)',
                             'app.assignment_institution_config(uuid)']) AS f
     WHERE has_function_privilege(r, f, 'EXECUTE') $$,
  ARRAY['ductus_identity app.publish_institution_config(text,integer,jsonb)',
        'ductus_identity app.assignment_institution_config(uuid)',
        'ductus_app app.assignment_institution_config(uuid)'],
  'only the identity owner can publish; the application can read through the assignment RPC'
);

SET LOCAL ROLE ductus_identity;
DO $$
BEGIN
  PERFORM app.publish_institution_config('fak-a', 1, '{"evidenceProfile":"basic","importAllowed":false}');
  PERFORM app.publish_institution_config('fak-b', 9, '{"evidenceProfile":"basic","importAllowed":false}');
END
$$;
RESET ROLE;

CREATE FUNCTION pg_temp.create_config_assignment(p_title text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format(
    'SELECT institution.create_assignment({k1}, %L, ''Upute'', ''essay'', now(), now() + interval ''1 day'',
      ''prohibited'', ARRAY[]::text[], ''basic'', false, NULL::integer, NULL::integer)',
    p_title
  ))
$$;

INSERT INTO ref VALUES ('old_cfg', pg_temp.create_config_assignment('Izmisljeni zadatak A'));
SELECT is(pg_temp.ask('vesna', $$ SELECT version_no FROM app.assignment_institution_config({old_cfg}) $$),
          '1', 'normal creation picks the latest version of its own institution');

SELECT lives_ok(
  $$ SELECT app.publish_institution_config('fak-a', 2, '{"evidenceProfile":"extended","importAllowed":true}') $$,
  'publish the next version'
);
SELECT lives_ok(
  $$ SELECT app.publish_institution_config('fak-a', 2, '{"evidenceProfile":"extended","importAllowed":true}') $$,
  'the same publication can be replayed'
);
SELECT throws_ok(
  $$ SELECT app.publish_institution_config('fak-a', 2, '{"evidenceProfile":"basic","importAllowed":false}') $$,
  'ZD409', 'institution configuration version must increase', 'a published version cannot be replaced'
);
SELECT throws_ok(
  $$ SELECT app.publish_institution_config('fak-a', 3, '{"evidenceProfile":"extended","importAllowed":"true"}') $$,
  '23514', NULL, 'the database rejects rules that do not have the expected shape'
);
INSERT INTO ref VALUES ('new_cfg', pg_temp.create_config_assignment('Izmisljeni zadatak B'));

SELECT is(pg_temp.ask('iva', $$ SELECT count(*) FROM app.institution_config $$),
          '2', 'the admin reads both versions of their own institution');
SELECT is(pg_temp.ask('lea', $$ SELECT version_no FROM app.institution_config $$),
          '9', 'the other admin sees only the version of their own institution');
SELECT is(pg_temp.ask('lea', $$ SELECT count(*) FROM app.institution_config WHERE institution_id = {fak_a} $$),
          '0', 'the other admin cannot find rows by institution id');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.institution_config $$),
          '0', 'a teacher cannot list the institution configuration');

SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
            $$ UPDATE app.institution_config SET rules = rules WHERE institution_id = {fak_a} AND version_no = 1 $$),
          'ZD403: institution configuration is immutable', 'the owner role cannot update a published version');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
            $$ DELETE FROM app.institution_config WHERE institution_id = {fak_a} AND version_no = 1 $$),
          'ZD403: institution configuration is immutable', 'the owner role cannot delete a published version');
SELECT throws_ok('TRUNCATE app.institution_config CASCADE',
                 'ZD403', 'institution configuration is immutable', 'the versions cannot be truncated');
SELECT is(pg_temp.ask_as('ductus_identity', 'anon',
            $$ UPDATE institution.assignment SET institution_config_version = 2 WHERE id = {old_cfg} $$),
          'ZD403: institution configuration is immutable', 'even the owner cannot repin an assignment');

SELECT is(pg_temp.ask('ana', $$ SELECT format('%s:%s', version_no, rules ->> 'evidenceProfile')
                               FROM app.assignment_institution_config({old_cfg}) $$),
          '1:basic', 'a student reads the rules pinned before publication');
SELECT is(pg_temp.ask('ana', $$ SELECT format('%s:%s', version_no, rules ->> 'evidenceProfile')
                               FROM app.assignment_institution_config({new_cfg}) $$),
          '2:extended', 'a new assignment reads the newly published rules');
SELECT is(pg_temp.ask('vesna', $$ SELECT count(*) FROM app.assignment_institution_config({z1}) $$),
          '0', 'publication does not backfill existing assignments');
SELECT is(pg_temp.ask('lea', $$ SELECT count(*) FROM app.assignment_institution_config({old_cfg}) $$),
          '0', 'the other admin cannot read the pin through the assignment RPC');
SELECT is(pg_temp.ask('boris', $$ SELECT count(*) FROM app.assignment_institution_config({old_cfg}) $$),
          '0', 'a student from the same institution without a relationship cannot read the pin');

SELECT * FROM finish();
ROLLBACK;
