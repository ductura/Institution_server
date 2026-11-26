-- SRV-ASIST-BROJAC (Ductus#2055 T2, decision A): the daily number of assistant
-- requests per student and assignment (20261219450000). The limit is an
-- optional value of the institution's cost configuration, set by the operator;
-- NULL is no limit. begin_request refuses a request over it with the existing
-- budget_exceeded; a refused request does not count. A student of the
-- assignment reads {limit, used}; anyone else gets not_found. Every other
-- writer of a configuration version keeps the limit. All people are the
-- invented ones of the shared fixture.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.key(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-000000256' || lpad(p_n::text, 3, '0'))::uuid
$$;
-- What begin_request answers p_actor on Z1: the state, or the reason of a refusal.
CREATE FUNCTION pg_temp.begin(p_n integer, p_actor text DEFAULT 'ana') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT coalesce(reason, state) FROM assistant.begin_request(%L, {z1}, NULL, 1, 'proofreading',
        'Izmišljeni odlomak.', 'provider-test-a', 'model-test-1', 'test-1') $q$, pg_temp.key(p_n)))
$$;
-- What p_actor reads: "outcome/limit/used".
CREATE FUNCTION pg_temp.requests(p_actor text DEFAULT 'ana', p_assignment text DEFAULT '{z1}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT outcome || '/' || coalesce(request_limit::text, '-') || '/' || coalesce(used::text, '-')
                                          FROM app.my_assistant_requests(%s) $q$, p_assignment))
$$;
CREATE FUNCTION pg_temp.latest_requests() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((SELECT student_assignment_day_requests::text FROM assistant.cost_config_version
                    WHERE institution_id = pg_temp.id('fak_a') ORDER BY version_no DESC LIMIT 1), '-')
$$;
CREATE FUNCTION pg_temp.latest_version() RETURNS integer LANGUAGE sql AS $$
  SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a')
$$;

-- 1. Catalogue.
SELECT is((SELECT data_type || '/' || is_nullable FROM information_schema.columns
            WHERE table_schema = 'assistant' AND table_name = 'cost_config_version'
              AND column_name = 'student_assignment_day_requests'), 'integer/YES',
  'the request limit is an optional integer of the configuration');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname NOT IN ('ductus_app', 'ductus_identity')
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['app.my_assistant_requests(uuid)',
       'assistant.begin_request(uuid,uuid,uuid,integer,text,text,text,text,text,text[])']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'only the web role (and the owner) execute the reader and begin_request');
SELECT is_empty(
  $$ SELECT r.rolname || ' may execute ' || f
     FROM (SELECT rolname::text FROM pg_roles
           WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin AND rolname <> 'ductus_identity'
           UNION ALL SELECT 'public') AS r
     CROSS JOIN unnest(ARRAY['assistant.publish_request_limit(uuid,integer,integer,text)',
       'assistant.requests_today(uuid,uuid)',
       'assistant.write_config_version_requests(uuid,integer,bigint,text,bigint,bigint,bigint,integer,uuid,text)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE') $$,
  'the operator procedure and the workers belong to no role but the owner');
SELECT ok(NOT has_schema_privilege('ductus_identity', 'app', 'CREATE')
    AND NOT has_schema_privilege('ductus_identity', 'assistant', 'CREATE'),
  'after the migration ductus_identity keeps no CREATE it was lent');

-- 2. Who reads {limit, used} of Z1: its students only.
SELECT is(pg_temp.requests(a.name), 'not_found/-/-', a.name || ' reads no request count of Z1')
FROM (VALUES ('vesna'), ('marko'), ('boris'), ('iva'), ('nina'), ('lea'), ('petra'), ('tomo')) AS a (name);
SELECT is(pg_temp.requests('ana', '''00000000-0000-4000-8000-00000000dead'''), 'not_found/-/-', 'an unknown assignment: not_found');
SELECT is(pg_temp.requests('ana', 'NULL'), 'not_found/-/-', 'no assignment: not_found');
SELECT is(pg_temp.requests('ana', '{z2}'), 'not_found/-/-', 'Ana reads no request count of Z2 in K2');
SELECT matches(pg_temp.ask(t.name, format($$ SELECT outcome FROM app.my_assistant_requests(%L) $$, pg_temp.id('z1'))), '^ZD401',
  'session ' || t.name || ' reads no request count')
FROM (VALUES ('anon'), ('expired'), ('closed'), ('unknown')) AS t (name);
SELECT is(pg_temp.requests(), 'found/-/0', 'nothing published: no limit, nothing used');

-- 3. The configuration: limits in amounts high enough to stay out of the way.
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 1000, 1000, 1) $$),
  'published:1', 'the administrator publishes the student limits and the reservation');
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 1, 100000, 'day', 'Zahtjev 1/2026'), 2, 'the operator publishes the cap of the institution');
SELECT ok(assistant.publish_cost_cap(NULL, (SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id IS NULL),
  1000000, 'month', 'Zahtjev 2/2026') > 0, 'the operator publishes the cap of the service');

-- 4. NULL: no limit.
SELECT is(pg_temp.begin(n), 'reserved', 'no limit: request ' || n || ' is reserved') FROM generate_series(1, 3) AS n;
SELECT is(pg_temp.requests(), 'found/-/3', 'Ana reads no limit and three requests used');

-- 5. The operator sets a limit of 5; below, exactly at and over it.
SELECT throws_ok($$ SELECT assistant.publish_request_limit(pg_temp.id('fak_a'), 2, 0, 'Zahtjev 3/2026') $$, 'ZD422', NULL, 'a limit of 0: ZD422');
SELECT throws_ok($$ SELECT assistant.publish_request_limit(NULL, 0, 5, 'Zahtjev 3/2026') $$, 'ZD422', NULL, 'no institution: ZD422');
SELECT throws_ok($$ SELECT assistant.publish_request_limit(pg_temp.id('fak_a'), 2, 5, ' Zahtjev 3/2026') $$, 'ZD422', NULL, 'a request reference with spaces around: ZD422');
SELECT throws_ok($$ SELECT assistant.publish_request_limit(pg_temp.id('fak_a'), 1, 5, 'Zahtjev 3/2026') $$, 'ZD409', NULL, 'an older version: ZD409');
SELECT matches(pg_temp.ask('iva', format($$ SELECT assistant.publish_request_limit(%L, 2, 5, 'Zahtjev 3/2026')::text $$, pg_temp.id('fak_a'))), '^42501',
  'the web role, even as the administrator, does not set the limit');
SELECT throws_ok(format($$ SELECT assistant.write_config_version_requests(NULL, %s, 1, 'day', NULL, NULL, NULL, 5, NULL, 'Zahtjev 9/2026') $$,
    (SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id IS NULL)),
  '23514', NULL, 'the scope of the service holds no request limit');
SELECT is(assistant.publish_request_limit(pg_temp.id('fak_a'), 2, 5, 'Zahtjev 3/2026'), 3, 'the operator sets a limit of 5 requests');
SELECT is((SELECT cap_micro::text || '/' || student_day_micro || '/' || student_assignment_day_micro || '/' || reserve_micro
             FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a') AND version_no = 3),
  '100000/1000/1000/1', 'and every other value of the configuration stays');
SELECT is((SELECT kind || '/' || request_ref FROM audit.assistant_cost_config_event
            WHERE institution_id = pg_temp.id('fak_a') AND version_no = 3), 'published/Zahtjev 3/2026',
  'the new version has its trail row');
SELECT is(pg_temp.requests(), 'found/5/3', 'Ana reads the limit 5 and three used');
SELECT is(pg_temp.begin(4), 'reserved', 'below the limit: the fourth request is reserved');
SELECT is(pg_temp.begin(5), 'reserved', 'reaching the limit: the fifth request is reserved');
SELECT is(pg_temp.requests(), 'found/5/5', 'Ana reads five of five');
SELECT is(pg_temp.begin(6), 'budget_exceeded', 'at the limit: the sixth request is refused with budget_exceeded');
SELECT is(pg_temp.begin(7), 'budget_exceeded', 'and so is the next one');
SELECT is(pg_temp.requests(), 'found/5/5', 'a refused request does not count');
SELECT is((SELECT count(*) FROM assistant.request WHERE student_id = pg_temp.id('ana') AND state = 'rejected'
             AND reason = 'budget_exceeded'), 2::bigint, 'both refusals are kept as rejected rows');
SELECT is(pg_temp.begin(5), 'reserved', 'the same key again replays the fifth request, not a new one');
SELECT is(pg_temp.requests('dora'), 'found/5/0', 'Dora, also a student of Z1, has her own count');
SELECT is(pg_temp.begin(11, 'dora'), 'reserved', 'and her request is reserved');

-- 6. Every other writer keeps the limit; NULL removes it.
SELECT is(pg_temp.ask('iva', format($$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(%s, 1000, 1000, 1) $$,
  pg_temp.latest_version())), 'published:4', 'the administrator publishes the student limits again');
SELECT is(pg_temp.latest_requests(), '5', 'and the request limit stays');
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 4, 200000, 'day', 'Zahtjev 4/2026'), 5, 'the operator changes the cap');
SELECT is(pg_temp.latest_requests(), '5', 'and the request limit stays');
SELECT is(pg_temp.begin(8), 'budget_exceeded', 'Ana is still at the limit');
SELECT is(assistant.publish_request_limit(pg_temp.id('fak_a'), 5, NULL, 'Zahtjev 5/2026'), 6, 'the operator removes the limit');
SELECT is(pg_temp.requests(), 'found/-/5', 'Ana reads no limit');
SELECT is(pg_temp.begin(9), 'reserved', 'and her next request is reserved');

-- 7. The web role writes no configuration directly.
SELECT matches(pg_temp.ask('iva', format($$ INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_period,
    student_assignment_day_requests, published_by) VALUES (%L, 7, 'day', 99, %L) RETURNING 'written' $$,
    pg_temp.id('fak_a'), pg_temp.id('iva'))), '^42501', 'the web role writes no configuration version directly');

SELECT * FROM finish();
ROLLBACK;
