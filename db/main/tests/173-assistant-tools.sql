-- SRV-1207 (M9.0-S3, Ductus#2052): the tools of the assistant in the database
-- (20261130100100), step 3 of Ductus docs/contracts/ai-tools-v1.md; plan of
-- attack Ductus#1664 S3-D1, S3-D3, S3-D5, S3-U5, S3-I2, S3-Z1. One
-- transaction, so one call after another; the races of "Istodobnost" are in
-- tests/db/assistant-tools.integration.test.ts.
--
--   1. the access matrix: no runtime role reads or writes the three tables or
--      the trail directly; four RPCs for the web role, none for the worker;
--   2. set_assignment_tools: only a teacher of the course, a closed tool list,
--      expected_version, the trail row (#1662 M6); foreign and missing alike;
--   3. read_assignment_tools: a teacher and a student of the course only;
--   4. begin_request: the loop reserved only for a non-empty allowed set,
--      reserve × (1 + TOOL_STEP_MAX) in the same ledger row;
--   5. begin_tool_step and finish_tool_step: step order, the bound, the order
--      of outcomes when several conditions hold, args_valid = false takes a
--      step_no; revocation by the teacher, the server and the policy;
--   6. fail_request with the three new reasons; triggers and checks.
--
-- Every person, text, provider and model is invented (provider-test-a,
-- model-test-1). The operator is the superuser running this file.
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.key(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-000000173' || lpad(p_n::text, 3, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.rid(p_n integer, p_student text DEFAULT 'ana') RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM assistant.request WHERE idempotency_key = pg_temp.key(p_n) AND student_id = pg_temp.id(p_student)
$$;
-- begin_request with the tools the server permits: "state|reason|tools".
CREATE FUNCTION pg_temp.begin(p_actor text, p_n integer, p_offered text, p_text text DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT state || '|' || coalesce(reason, '-') || '|' || tools::text FROM assistant.begin_request(%L, {z1}, NULL, 1,
        'proofreading', %L, 'provider-test-a', 'model-test-1', 'test-1', %L::text[]) $q$,
    pg_temp.key(p_n), coalesce(p_text, 'Izmišljeni odlomak broj ' || p_n || '.'), p_offered))
$$;
CREATE FUNCTION pg_temp.sha(p_text text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$;
-- begin_tool_step as p_actor on request n: "outcome|tools" or the error.
CREATE FUNCTION pg_temp.step(p_actor text, p_request uuid, p_step integer, p_tool text, p_valid boolean,
                             p_offered text DEFAULT '{web_search}') RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT outcome || '|' || tools::text FROM assistant.begin_tool_step(%L, %s, %L, %L, %L, %L, %L::text[]) $q$,
    coalesce(p_request, pg_temp.id('nobody')), p_step, p_tool, pg_temp.sha(coalesce(p_tool, 'Web_search')),
    pg_temp.sha('{"query":"upit"}'), p_valid, p_offered))
$$;
CREATE FUNCTION pg_temp.finish(p_actor text, p_request uuid, p_step integer, p_outcome text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT assistant.finish_tool_step(%L, %s, %L, %L, 12, false) $q$,
    p_request, p_step, p_outcome, pg_temp.sha('Izmišljeni rezultat.')))
$$;
CREATE FUNCTION pg_temp.drift() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM assistant.budget_counter b
   WHERE b.used_micro <> coalesce((
     SELECT sum(coalesce(l.actual_micro, l.reserved_micro)) FROM assistant.cost_ledger l
      WHERE l.state IN ('reserved', 'settled') AND CASE b.scope
        WHEN 'service_cap' THEN l.service_cap_period_start = b.period_start
        WHEN 'institution_cap' THEN l.institution_id::text = b.scope_key AND l.institution_cap_period_start = b.period_start
        WHEN 'student_day' THEN l.institution_id || ':' || l.student_id = b.scope_key AND l.budget_day = b.period_start
        ELSE l.institution_id || ':' || l.student_id || ':' || l.assignment_id = b.scope_key AND l.budget_day = b.period_start
      END), 0)
$$;

-- 1. The access matrix (contract, "Matrica pristupa").
SELECT is(assistant.code_tools()::text || ' ' || assistant.tool_step_max(), '{web_search} 3',
  'CODE_TOOLS and TOOL_STEP_MAX are named constants, as server/domain/assistant');
SELECT is_empty(
  $$ SELECT r || ' ' || p.privilege || ' ' || c.oid::regclass
       FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth', 'ductus_evidence', 'public']) AS r
      CROSS JOIN (SELECT oid FROM pg_class WHERE oid IN ('assistant.assignment_tool_setting'::regclass,
                    'assistant.tool_step'::regclass, 'assistant.tool_loop_reservation'::regclass,
                    'audit.assistant_tool_setting_event'::regclass)) AS c
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
      WHERE has_table_privilege(r, c.oid, p.privilege) $$,
  'no runtime role and not PUBLIC reads or writes the setting, the steps, the loop or the trail directly (S3-U5)');
SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c WHERE c.oid IN ('assistant.assignment_tool_setting'::regclass,
       'assistant.tool_step'::regclass, 'assistant.tool_loop_reservation'::regclass,
       'audit.assistant_tool_setting_event'::regclass)
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = 'ductus_identity'::regrole) $$,
  'each new table has ENABLE and FORCE ROW LEVEL SECURITY and belongs to ductus_identity');
SELECT bag_eq(
  $$ SELECT p.proname::text FROM pg_proc p WHERE p.pronamespace = 'assistant'::regnamespace
      AND p.proname IN ('set_assignment_tools', 'read_assignment_tools', 'begin_tool_step', 'finish_tool_step', 'begin_request')
      AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'] $$,
  $$ VALUES ('set_assignment_tools'), ('read_assignment_tools'), ('begin_tool_step'), ('finish_tool_step'), ('begin_request') $$,
  'the RPCs of the tools are SECURITY DEFINER with an empty search_path');
SELECT ok(NOT has_function_privilege('ductus_worker', p.oid, 'EXECUTE'), 'the worker does not run ' || p.oid::regprocedure)
  FROM pg_proc p WHERE p.pronamespace = 'assistant'::regnamespace
   AND p.proname IN ('set_assignment_tools', 'read_assignment_tools', 'begin_tool_step', 'finish_tool_step');
SELECT is(left(pg_temp.ask(a.actor, format('SELECT count(*)::text FROM %s', a.tbl)), 5), '42501',
  a.actor || ' cannot read ' || a.tbl)
  FROM (VALUES ('ana'), ('vesna'), ('iva')) AS p (actor)
  CROSS JOIN (VALUES ('assistant.assignment_tool_setting'), ('assistant.tool_step'), ('assistant.tool_loop_reservation'),
                     ('audit.assistant_tool_setting_event')) AS t (tbl)
  CROSS JOIN LATERAL (SELECT p.actor, t.tbl) AS a;
SELECT is(pg_temp.ask('vesna', format($$ INSERT INTO assistant.assignment_tool_setting (assignment_id, institution_id, version_no, tools, set_by)
            VALUES (%L, %L, 1, '{web_search}', %L) RETURNING 'written' $$, pg_temp.id('z1'), pg_temp.id('fak_a'), pg_temp.id('vesna'))),
  '42501: permission denied for table assignment_tool_setting', 'the teacher writes the setting only through the RPC');
SELECT is(pg_temp.ask_as('ductus_worker', 'ana', 'SELECT count(*)::text FROM assistant.tool_step'),
  '42501: permission denied for table tool_step', 'the worker reads no step');

-- 2. set_assignment_tools.
SELECT is(pg_temp.ask('ana', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{web_search}')::text $$), 'ZD403: forbidden',
  'a student of the course sets no tools');
SELECT is(pg_temp.ask('marko', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{web_search}')::text $$), 'ZD403: forbidden',
  'a teacher of another course sets no tools');
SELECT is(pg_temp.ask('iva', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{web_search}')::text $$), 'ZD403: forbidden',
  'the administrator of the institution sets no tools');
SELECT is(pg_temp.ask('petra', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{web_search}')::text $$),
          pg_temp.ask('petra', $$ SELECT assistant.set_assignment_tools({nobody}, 0, '{web_search}')::text $$),
  'a foreign and a missing assignment give the same outcome');
SELECT is(pg_temp.ask('vesna', format($$ SELECT assistant.set_assignment_tools({z1}, 0, %L)::text $$, t.tools)), 'ZD422: invalid input',
  'a tool list ' || t.why || ' is invalid_request')
  FROM (VALUES ('{Web_search}', 'with a name differing in case'), ('{" web_search"}', 'with a leading space'),
               ('{web_search,web_search}', 'with a duplicate'), ('{code_interpreter}', 'outside the code set'),
               ('{NULL}', 'with NULL'), ('{{web_search}}', 'of two dimensions')) AS t (tools, why);
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, -1, '{}')::text $$), 'ZD422: invalid input',
  'a negative expected version is invalid');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{web_search}')::text $$), '1',
  'the teacher of the course turns web_search on: version 1');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 0, '{}')::text $$), 'ZD409: version_conflict',
  'a write from an old version is version_conflict');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 1, '{}')::text $$), '2',
  'turning it off is a new version');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 2, '{web_search}')::text $$), '3',
  'and on again');
SELECT is((SELECT string_agg(e.version_no || ':' || e.tools::text || ':' || (e.actor_id = pg_temp.id('vesna')), ',' ORDER BY e.version_no)
             FROM audit.assistant_tool_setting_event e WHERE e.assignment_id = pg_temp.id('z1')),
  '1:{web_search}:true,2:{}:true,3:{web_search}:true', 'every version has its trail row naming the teacher (#1662 M6)');
CREATE FUNCTION pg_temp.untrailed() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO assistant.assignment_tool_setting (assignment_id, institution_id, version_no, tools, set_by)
  VALUES (pg_temp.id('z2'), pg_temp.id('fak_a'), 1, '{}', pg_temp.id('marko'));
  SET CONSTRAINTS assistant.assignment_tool_setting_has_event IMMEDIATE;
  RETURN 'committed';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END
$$;
SELECT is(pg_temp.untrailed(), 'ZD409', 'a setting written without its trail row cannot commit (M6)');
SET CONSTRAINTS assistant.assignment_tool_setting_has_event DEFERRED;
SELECT throws_ok(format($$ INSERT INTO assistant.assignment_tool_setting (assignment_id, institution_id, version_no, tools, set_by)
                          VALUES (%L, %L, 5, '{}', %L) $$, pg_temp.id('z1'), pg_temp.id('fak_a'), pg_temp.id('vesna')),
  'ZD409', NULL, 'a version that is not the next one is refused');

-- 3. read_assignment_tools.
SELECT is(pg_temp.ask(r.actor, $$ SELECT version_no || ':' || tools::text FROM assistant.read_assignment_tools({z1}) $$), r.expected,
  r.actor || ' ' || r.why)
  FROM (VALUES ('vesna', '3:{web_search}', 'the teacher of the course reads the version in force'),
               ('ana', '3:{web_search}', 'a student of the course reads it (PRODUCT §8)'),
               ('dora', '3:{web_search}', 'another student of the course reads it'),
               ('boris', 'ZD403: forbidden', 'a student of no course reads nothing'),
               ('marko', 'ZD403: forbidden', 'a teacher of another course reads nothing'),
               ('iva', 'ZD403: forbidden', 'the administrator reads nothing'),
               ('tomo', 'ZD403: forbidden', 'a student of another institution reads nothing')) AS r (actor, expected, why);
SELECT is(pg_temp.ask('marko', $$ SELECT version_no || ':' || tools::text FROM assistant.read_assignment_tools({z2}) $$), '0:{}',
  'an assignment never set reads version 0 with no tool');
SELECT is(pg_temp.ask('tomo', $$ SELECT version_no::text FROM assistant.read_assignment_tools({nobody}) $$),
          pg_temp.ask('tomo', $$ SELECT version_no::text FROM assistant.read_assignment_tools({z1}) $$),
  'a foreign and a missing assignment read the same');

-- 4. begin_request with the tools the server permits. The configuration as
-- in 171: reservation 7, student limits 30, caps from the operator.
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 500, 500, 7) $$),
  'published:1', 'the administrator publishes the limits');
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 1, 1000, 'day', 'Zahtjev 1/2026'), 2, 'the cap of the institution');
SELECT ok(assistant.publish_cost_cap(NULL, (SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id IS NULL),
                                     1000000, 'month', 'Zahtjev 2/2026') >= 1, 'the cap of the service');
SELECT is(pg_temp.begin('ana', 1, '{}'), 'reserved|-|{}', 'the pilot: the server permits nothing, so no tool and no loop');
SELECT is((SELECT reserved_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(1)), 7::bigint,
  'without tools the reservation is that of ai-request-v1');
SELECT ok(NOT EXISTS (SELECT 1 FROM assistant.tool_loop_reservation WHERE request_id = pg_temp.rid(1)), 'and no loop row');
SELECT is(pg_temp.begin('ana', 2, '{web_search}'), 'reserved|-|{web_search}',
  'when the server and the teacher permit web_search, the request has a loop');
SELECT is((SELECT reserved_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(2)), 28::bigint,
  'the loop is reserved as reserve × (1 + TOOL_STEP_MAX) in the same ledger row');
SELECT is((SELECT steps_reserved || ':' || tools_reserved::text FROM assistant.tool_loop_reservation WHERE request_id = pg_temp.rid(2)),
  '3:{web_search}', 'the loop row names TOOL_STEP_MAX and the allowed set at the start');
SELECT is(pg_temp.begin('ana', 2, '{web_search}'), 'reserved|-|{web_search}', 'a replay returns the same set');
SELECT is(pg_temp.begin('ana', 3, '{Web_search}'), 'ZD422: invalid input', 'a permitted list outside the code set is invalid');
SELECT is(pg_temp.begin('ana', 4, NULL), 'ZD422: invalid input', 'a NULL permitted list is invalid');
SELECT is(pg_temp.ask('ana', format($$ SELECT state || '|' || tools::text FROM assistant.begin_request(%L, {z1}, NULL, 1, 'proofreading',
            'Izmišljeni odlomak bez popisa.', 'provider-test-a', 'model-test-1', 'test-1') $$, pg_temp.key(5))), 'reserved|{}',
  'the call of ai-request-v1 without the list still works and offers nothing');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger');

-- 5. The steps.
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 1, 'web_search', true), 'ZD409: conflict', 'no step before the request is sent');
SELECT is(pg_temp.ask('ana', format('SELECT state FROM assistant.mark_sent(%L)', pg_temp.rid(2))), 'sent', 'the request is sent');
SELECT is(pg_temp.step('dora', pg_temp.rid(2), 1, 'web_search', true), 'ZD403: forbidden', 'another student takes no step');
SELECT is(pg_temp.step('dora', NULL, 1, 'web_search', true), 'ZD403: forbidden', 'a missing request is the same');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 2, 'web_search', true), 'ZD409: conflict', 'step 2 before step 1 is refused');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 1, 'Web_search', true), 'ZD422: invalid input',
  'a name that is not exactly a code tool never reaches the table as text (S3-D3)');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 1, 'web_search', true), 'allowed|{web_search}',
  'step 1: web_search with valid arguments is allowed and the next set returned');
SELECT is(pg_temp.finish('ana', pg_temp.rid(2), 1, 'running'), 'ZD422: invalid input', 'a step ends only done or failed');
SELECT is(pg_temp.finish('ana', pg_temp.rid(2), 1, 'done'), 'done', 'allowed -> done with the hash and size of the result');
SELECT is(pg_temp.finish('ana', pg_temp.rid(2), 1, 'failed'), 'ZD409: conflict', 'a finished step does not finish again');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 2, NULL, false), 'denied_not_in_set|{web_search}',
  'step 2: a name outside the code set (NULL) is denied_not_in_set, and it takes a step_no');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 3, 'web_search', false), 'denied_schema|{web_search}',
  'step 3: arguments outside the schema are denied_schema and take a step_no');
SELECT is(pg_temp.finish('ana', pg_temp.rid(2), 2, 'done'), 'ZD409: conflict', 'a denied step never runs');
SELECT is(pg_temp.step('ana', pg_temp.rid(2), 4, 'web_search', true), 'ZD409: conflict',
  'step 4 is past steps_reserved: the loop is bounded (S3-I2)');
SELECT is((SELECT string_agg(step_no || ':' || coalesce(tool_name, '-') || ':' || outcome || ':' || coalesce(result_bytes::text, '-'), ',' ORDER BY step_no)
             FROM assistant.tool_step WHERE request_id = pg_temp.rid(2)),
  '1:web_search:done:12,2:-:denied_not_in_set:-,3:web_search:denied_schema:-', 'the rows hold names from the code set and hashes only');
SELECT is((SELECT requested_name_sha256 FROM assistant.tool_step WHERE request_id = pg_temp.rid(2) AND step_no = 2), pg_temp.sha('Web_search'),
  'for a name outside the set only its SHA-256 is kept (OC-5)');
SELECT is(pg_temp.ask('ana', format($$ SELECT state || ':' || accepted FROM assistant.fail_request(%L, 'tool_step_limit', 14) $$, pg_temp.rid(2))),
  'provider_failed:true', 'a loop at its bound ends with tool_step_limit (S3-I2)');
SELECT is((SELECT state || ':' || reason FROM assistant.request WHERE id = pg_temp.rid(2)), 'provider_failed:tool_step_limit',
  'the reason is kept on the request');
SELECT is((SELECT state || ':' || actual_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(2)), 'settled:14',
  'the settlement is the sum of the calls made');
SELECT is(pg_temp.step('ana', pg_temp.rid(1), 1, 'web_search', true), 'ZD409: conflict',
  'a request without a loop takes no step');
SELECT is(pg_temp.ask('ana', format('SELECT state FROM assistant.mark_sent(%L)', pg_temp.rid(1))), 'sent', 'request 1 is sent');
SELECT is(pg_temp.step('ana', pg_temp.rid(1), 1, 'web_search', true), 'ZD409: conflict',
  'still none once sent: a tool turned on mid-request counts from the next request');
SELECT is(pg_temp.ask('ana', format($$ SELECT state || ':' || accepted FROM assistant.fail_request(%L, 'response_too_large', 7) $$, pg_temp.rid(1))),
  'provider_failed:true', 'an answer above the bound ends with response_too_large (S3-I3)');
SELECT is(pg_temp.ask('ana', format($$ SELECT state FROM assistant.fail_request(%L, 'model_said_so', 7) $$, pg_temp.rid(5))),
  'ZD422: invalid input', 'any other reason is invalid');

-- Revocation by the teacher (S3-Z1): the order of outcomes puts it first,
-- whatever the model asks.
SELECT is(pg_temp.begin('ana', 10, '{web_search}'), 'reserved|-|{web_search}', 'request 10 has a loop');
SELECT is(pg_temp.ask('ana', format('SELECT state FROM assistant.mark_sent(%L)', pg_temp.rid(10))), 'sent', 'and is sent');
SELECT is(pg_temp.step('ana', pg_temp.rid(10), 1, 'web_search', true), 'allowed|{web_search}', 'step 1 is allowed');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 3, '{}')::text $$), '4', 'the teacher turns web_search off');
SELECT is(pg_temp.step('ana', pg_temp.rid(10), 2, NULL, false), 'denied_revoked|{}',
  'after the revocation a name outside the set and bad arguments are still denied_revoked');
SELECT is(pg_temp.ask('ana', format($$ SELECT state FROM assistant.fail_request(%L, 'request_revoked', 7) $$, pg_temp.rid(10))),
  'provider_failed', 'the route closes the request with request_revoked');
SELECT is((SELECT reason FROM assistant.request WHERE id = pg_temp.rid(10)), 'request_revoked', 'request_revoked is kept');
SELECT is(pg_temp.ask('vesna', $$ SELECT assistant.set_assignment_tools({z1}, 4, '{web_search}')::text $$), '5', 'on again');
-- Revocation by the server: the switch or the destinations went away.
SELECT is(pg_temp.begin('ana', 11, '{web_search}'), 'reserved|-|{web_search}', 'request 11 has a loop');
SELECT is(pg_temp.ask('ana', format('SELECT state FROM assistant.mark_sent(%L)', pg_temp.rid(11))), 'sent', 'and is sent');
SELECT is(pg_temp.step('ana', pg_temp.rid(11), 1, 'web_search', true, '{}'), 'denied_revoked|{}',
  'when the server no longer permits the tool the step is denied_revoked');
-- Revocation by the policy: the course rule becomes prohibited between steps.
SELECT is(pg_temp.begin('ana', 12, '{web_search}'), 'reserved|-|{web_search}', 'request 12 has a loop');
SELECT is(pg_temp.ask('ana', format('SELECT state FROM assistant.mark_sent(%L)', pg_temp.rid(12))), 'sent', 'and is sent');
UPDATE institution.course SET ai_policy = 'prohibited' WHERE id = pg_temp.id('k1');
SELECT is(pg_temp.step('ana', pg_temp.rid(12), 1, 'web_search', true), 'denied_revoked|{}',
  'a course rule changed to prohibited revokes the loop (#1662 I3, D-268 O4)');
UPDATE institution.course SET ai_policy = 'partially_allowed' WHERE id = pg_temp.id('k1');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters still equal the ledger');

-- 6. Triggers and checks: append-only, frozen, finished once.
SELECT throws_ok(format($$ UPDATE assistant.assignment_tool_setting SET tools = '{}' WHERE assignment_id = %L $$, pg_temp.id('z1')),
  'ZD409', NULL, 'a setting version never changes');
SELECT throws_ok(format($$ DELETE FROM assistant.assignment_tool_setting WHERE assignment_id = %L $$, pg_temp.id('z1')),
  'ZD409', NULL, 'nor is it deleted');
SET CONSTRAINTS assistant.assignment_tool_setting_has_event IMMEDIATE;
SELECT throws_ok('TRUNCATE assistant.assignment_tool_setting CASCADE', 'ZD409', NULL, 'nor truncated');
SELECT throws_ok(format($$ UPDATE assistant.tool_loop_reservation SET steps_reserved = 9 WHERE request_id = %L $$, pg_temp.rid(2)),
  'ZD409', NULL, 'a loop reservation never changes');
SELECT throws_ok(format($$ DELETE FROM assistant.tool_loop_reservation WHERE request_id = %L $$, pg_temp.rid(2)),
  'ZD409', NULL, 'nor is it deleted');
SELECT throws_ok('TRUNCATE assistant.tool_loop_reservation', 'ZD409', NULL, 'nor truncated');
SELECT throws_ok(format($$ UPDATE assistant.tool_step SET outcome = 'failed', result_sha256 = NULL, result_bytes = NULL, truncated = NULL
                          WHERE request_id = %L AND step_no = 1 $$, pg_temp.rid(2)),
  'ZD409', NULL, 'a done step does not move again');
SELECT throws_ok(format($$ UPDATE assistant.tool_step SET args_sha256 = %L WHERE request_id = %L AND step_no = 1 $$,
                        repeat('0', 64), pg_temp.rid(10)),
  'ZD409', NULL, 'nothing but the end of an allowed step changes');
SELECT throws_ok(format($$ DELETE FROM assistant.tool_step WHERE request_id = %L $$, pg_temp.rid(2)), 'ZD409', NULL,
  'a step is never deleted');
SELECT throws_ok('TRUNCATE assistant.tool_step', 'ZD409', NULL, 'nor truncated');
SELECT throws_ok(format($$ INSERT INTO assistant.tool_step (request_id, institution_id, step_no, tool_name, requested_name_sha256, outcome, args_sha256, finished_at)
                          VALUES (%L, %L, 1, 'Web_search', %L, 'denied_not_in_set', %L, now()) $$,
                        pg_temp.rid(12), pg_temp.id('fak_a'), repeat('a', 64), repeat('b', 64)),
  '23514', NULL, 'the table holds only names from the code set');
SELECT throws_ok(format($$ INSERT INTO assistant.tool_step (request_id, institution_id, step_no, tool_name, requested_name_sha256, outcome, args_sha256, finished_at)
                          VALUES (%L, %L, 1, NULL, 'web_search', 'denied_not_in_set', %L, now()) $$,
                        pg_temp.rid(12), pg_temp.id('fak_a'), repeat('b', 64)),
  '23514', NULL, 'the requested name is kept only as SHA-256');
SELECT throws_ok(format($$ INSERT INTO assistant.tool_step (request_id, institution_id, step_no, tool_name, requested_name_sha256, outcome, args_sha256)
                          VALUES (%L, %L, 4, 'web_search', %L, 'allowed', %L) $$,
                        pg_temp.rid(12), pg_temp.id('fak_a'), repeat('a', 64), repeat('b', 64)),
  '23514', NULL, 'no step_no above TOOL_STEP_MAX');
SELECT throws_ok(format($$ INSERT INTO assistant.tool_loop_reservation (request_id, institution_id, steps_reserved, tools_reserved)
                          VALUES (%L, %L, 3, '{}') $$, pg_temp.rid(1), pg_temp.id('fak_a')),
  '23514', NULL, 'a loop has a non-empty set of code tools');
SELECT throws_ok($$ UPDATE audit.assistant_tool_setting_event SET tools = '{}' $$, 'ZD403', NULL, 'the trail is append-only');

SELECT * FROM finish();
ROLLBACK;
