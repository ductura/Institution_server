-- SRV-ZAD-POSTAVKE: all fixtures are invented. The rules on outside tools and
-- "samo sažimanje" are fixed on creation, like practice (204).
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT plan(13);

SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', external_tools_allowed, ai_summary_only)
                                    FROM institution.assignment WHERE id = {z1} $$),
  'false|false', 'assignments created before the rules have neither');

CREATE FUNCTION pg_temp.create_with(p_key text, p_policy text, p_purposes text, p_tools boolean, p_summary boolean)
RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask('vesna', format($q$
    SELECT institution.create_assignment({k1}, %L::uuid,
      'Izmišljeni esej', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      %L, %L::text[], 'basic', false, NULL, NULL, 1, false, %L::boolean, %L::boolean)
  $q$, p_key, p_policy, p_purposes, p_tools, p_summary))
$$;

INSERT INTO ref SELECT 'rules', pg_temp.create_with('00000000-0000-4000-8000-00000000a501', 'partially_allowed', '{}', true, true);
SELECT matches((SELECT val FROM ref WHERE name = 'rules'), '^[0-9a-f-]{36}$', 'a teacher creates an assignment with both rules');
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', external_tools_allowed, ai_summary_only)
                                    FROM institution.assignment WHERE id = {rules} $$),
  'true|true', 'both rules are stored');
SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a501', 'partially_allowed', '{}', true, true),
  (SELECT val FROM ref WHERE name = 'rules'), 'the same key and rules are idempotent');
SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a501', 'partially_allowed', '{}', false, true),
  'ZD409: conflict', 'changed outside tools cannot reuse the key');
SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a501', 'partially_allowed', '{}', true, false),
  'ZD409: conflict', 'a changed summary rule cannot reuse the key');

SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a502', 'prohibited', '{}', false, true),
  'ZD422: invalid input', 'summary only under a prohibited policy is refused');
SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a503', 'partially_allowed', '{proofreading}', false, true),
  'ZD422: invalid input', 'summary only with an AI purpose is refused');
SELECT is(pg_temp.create_with('00000000-0000-4000-8000-00000000a504', 'partially_allowed', '{}', NULL, false),
  'ZD422: invalid input', 'a missing outside tools rule is refused');
SELECT is((SELECT count(*) FROM institution.assignment WHERE request_id IN (
           '00000000-0000-4000-8000-00000000a502', '00000000-0000-4000-8000-00000000a503',
           '00000000-0000-4000-8000-00000000a504')),
  0::bigint, 'a refused creation writes nothing');

SELECT is(pg_temp.ask('ana', $$ SELECT institution.create_assignment({k1}, '00000000-0000-4000-8000-00000000a505'::uuid,
      'Izmišljeni esej', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
      'partially_allowed', '{}', 'basic', false, NULL, NULL, 1, false, true, false)::text $$),
  'ZD403: forbidden', 'a student of the course cannot create an assignment with the rules');

-- The earlier signature keeps its meaning: neither rule.
INSERT INTO ref SELECT 'legacy', pg_temp.ask('vesna', $$
  SELECT institution.create_assignment({k1}, '00000000-0000-4000-8000-00000000a506'::uuid,
    'Izmišljeni esej', 'Izmišljene upute', 'essay', now(), now() + interval '1 day',
    'partially_allowed', '{}', 'basic', false, NULL, NULL, 1, false)::text $$);
SELECT is(pg_temp.ask('vesna', $$ SELECT format('%s|%s', external_tools_allowed, ai_summary_only)
                                    FROM institution.assignment WHERE id = {legacy} $$),
  'false|false', 'the earlier signature stores neither rule');

SELECT throws_ok($$ UPDATE institution.assignment SET ai_summary_only = false WHERE id = pg_temp.id('rules') $$,
  'ZD409', 'assignment setup is immutable', 'the rules cannot change after creation');

SELECT * FROM finish();
ROLLBACK;
