-- SRV-ASIST-LIMIT-ADMIN (Ductus#2055): the administrator of an institution
-- reads and sets the daily request limit of the own institution
-- (20261220100000), the same value as assistant.publish_request_limit. Only a
-- confirmed administrator; everyone else ZD403, no session ZD401. Every change
-- is a configuration version with its trail row. All people are the invented
-- ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

-- What p_actor reads: "version/limit".
CREATE FUNCTION pg_temp.read(p_actor text DEFAULT 'iva') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, $q$ SELECT version_no || '/' || coalesce(request_limit::text, '-') FROM assistant.read_request_limit() $q$)
$$;
CREATE FUNCTION pg_temp.set(p_expected integer, p_requests text, p_actor text DEFAULT 'iva') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT assistant.set_request_limit(%s, %s)::text $q$, coalesce(p_expected::text, 'NULL'), p_requests))
$$;

-- 1. Catalogue.
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['assistant.read_request_limit()', 'assistant.set_request_limit(integer,integer)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the two functions');
SELECT ok((SELECT bool_and(p.prosecdef) FROM pg_proc p
            WHERE p.oid IN ('assistant.read_request_limit()'::regprocedure,
                            'assistant.set_request_limit(integer,integer)'::regprocedure)),
  'both are SECURITY DEFINER');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'assistant', 'CREATE'),
  'after the migration ductus_identity keeps no CREATE it was lent');

-- 2. Who: the administrator only; a student, a teacher, an unconfirmed teacher are refused.
SELECT matches(pg_temp.read(a.name), '^ZD403', a.name || ' reads no request limit')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('vesna'), ('marko'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.set(0, '5', a.name), '^ZD403', a.name || ' sets no request limit')
FROM (VALUES ('ana'), ('dora'), ('boris'), ('vesna'), ('marko'), ('nina'), ('petra'), ('tomo')) AS a (name);
SELECT matches(pg_temp.read(t.name), '^ZD401', 'session ' || t.name || ' reads no request limit')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT matches(pg_temp.set(0, '5', t.name), '^ZD401', 'session ' || t.name || ' sets no request limit')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is((SELECT count(*) FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a')), 0::bigint,
  'a refused call writes nothing');

-- 3. Nothing published: version 0, no limit.
SELECT is(pg_temp.read(), '0/-', 'Iva reads version 0 and no limit');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 1000, 1000, 1) $$),
  'published:1', 'Iva publishes the student limits');
SELECT is(pg_temp.read(), '1/-', 'Iva reads version 1 and still no limit');

-- 4. Invalid input and a stale version.
SELECT matches(pg_temp.set(1, '0'), '^ZD422', 'a limit of 0: ZD422');
SELECT matches(pg_temp.set(1, '-3'), '^ZD422', 'a negative limit: ZD422');
SELECT matches(pg_temp.set(-1, '5'), '^ZD422', 'a negative version: ZD422');
SELECT matches(pg_temp.set(NULL, '5'), '^ZD422', 'no version: ZD422');
SELECT matches(pg_temp.set(0, '5'), '^ZD409', 'an older version: ZD409');
SELECT matches(pg_temp.set(2, '5'), '^ZD409', 'a version not yet published: ZD409');

-- 5. Iva sets 5: a version with its trail row; the other values stay.
SELECT is(pg_temp.set(1, '5'), '2', 'Iva sets a limit of 5 requests');
SELECT is(pg_temp.read(), '2/5', 'and reads it');
SELECT is((SELECT student_day_micro || '/' || student_assignment_day_micro || '/' || reserve_micro || '/' || student_assignment_day_requests
             FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a') AND version_no = 2),
  '1000/1000/1/5', 'every other value of the configuration stays');
SELECT is((SELECT kind || '/' || (actor_id = pg_temp.id('iva')) || '/' || coalesce(request_ref, '-') FROM audit.assistant_cost_config_event
            WHERE institution_id = pg_temp.id('fak_a') AND version_no = 2), 'published/true/-',
  'the new version has its trail row with Iva as the actor');
SELECT is(pg_temp.ask('ana', format($$ SELECT outcome || '/' || request_limit FROM app.my_assistant_requests(%L) $$, pg_temp.id('z1'))),
  'found/5', 'Ana, a student of Z1, reads the limit Iva set');

-- 6. A retry returns the same version and writes nothing; a different one conflicts.
SELECT is(pg_temp.set(1, '5'), '2', 'the same change again returns version 2');
SELECT is((SELECT count(*) FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a')), 2::bigint,
  'and writes no version');
SELECT matches(pg_temp.set(1, '6'), '^ZD409', 'another limit on the old version: ZD409');

-- 7. The operator's version is not Iva's to retry; NULL removes the limit.
SELECT is(assistant.publish_request_limit(pg_temp.id('fak_a'), 2, 7, 'Zahtjev 7/2026'), 3, 'the operator sets 7');
SELECT matches(pg_temp.set(2, '7'), '^ZD409', 'Iva retrying the operator''s change on the old version: ZD409');
SELECT is(pg_temp.read(), '3/7', 'Iva reads the operator''s limit');
SELECT is(pg_temp.set(3, 'NULL'), '4', 'Iva removes the limit');
SELECT is(pg_temp.read(), '4/-', 'and reads no limit');

-- 8. One institution: Lea of fak-b sees and sets only hers.
SELECT is(pg_temp.read('lea'), '0/-', 'Lea reads nothing of fak-a');
SELECT is(pg_temp.set(0, '3', 'lea'), '1', 'Lea sets a limit for fak-b');
SELECT is(pg_temp.read('lea'), '1/3', 'and reads hers');
SELECT is(pg_temp.read(), '4/-', 'Iva''s institution is untouched');

-- 9. The web role writes no configuration directly.
SELECT matches(pg_temp.ask('iva', format($$ INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_period,
    student_assignment_day_requests, published_by) VALUES (%L, 9, 'day', 99, %L) RETURNING 'written' $$,
    pg_temp.id('fak_a'), pg_temp.id('iva'))), '^42501', 'the web role writes no configuration version directly');

SELECT * FROM finish();
ROLLBACK;
