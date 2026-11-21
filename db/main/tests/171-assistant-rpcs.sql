-- SRV-1203 (Val 12 / M9.0-S2, Ductus#2052): the RPCs of the schema assistant
-- (20261122110000), step 3 of Ductus docs/contracts/ai-request-v1.md; plan of
-- attack Ductus#1662. One transaction, so one call after another; the races
-- (I1 to I6, R6) are in tests/db/assistant-*.integration.test.ts.
--
--   1. catalogue: no parameter names a student, an amount or a limit; the
--      operator procedure belongs to no application role;
--   2. pure parts: the budget day in Europe/Zagreb, the request hash (JCS);
--   3. the cost configuration: empty is off (P1), limit_above_cap (T2), the
--      trail row in the same statement (M6);
--   4. begin_request: shape, ownership, policy, reservation, idempotency (R3
--      to R5), counters equal to the ledger;
--   5. the transitions: mark_sent (I3), complete_request, fail_request,
--      mark_outcome_unknown, the late response dropped (R7), the sweep;
--   6. direct writes refused, and forbidden the same for another's id and an
--      id that does not exist (M1, M4, M5).
--
-- The operator is the superuser running this file (no application role may
-- run publish_cost_cap). Every person, text, provider and model is invented;
-- the providers and models are provider-test-a and model-test-1 (S4).
BEGIN;
SET LOCAL lc_messages TO 'C';
\ir fixtures/institution.inc
SELECT no_plan();

CREATE FUNCTION pg_temp.key(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-000000171' || lpad(p_n::text, 3, '0'))::uuid
$$;
-- The request of a key, read as the test's own role.
CREATE FUNCTION pg_temp.rid(p_n integer, p_student text DEFAULT 'ana') RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM assistant.request WHERE idempotency_key = pg_temp.key(p_n) AND student_id = pg_temp.id(p_student)
$$;
-- begin_request as the web role with p_actor's session: "state|reason|replayed".
CREATE FUNCTION pg_temp.begin(p_actor text, p_n integer, p_assignment text, p_purpose text, p_text text,
                              p_conversation text DEFAULT 'NULL', p_catalog integer DEFAULT 1) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format(
    $q$ SELECT state || '|' || coalesce(reason, '-') || '|' || replayed FROM assistant.begin_request(%L, %s, %s, %s, %L, %L,
        'provider-test-a', 'model-test-1', 'test-1') $q$,
    pg_temp.key(p_n), p_assignment, p_conversation, p_catalog, p_purpose, p_text))
$$;
-- A call of one RPC on one request as p_role (the web role by default).
CREATE FUNCTION pg_temp.on_request(p_actor text, p_sql text, p_request uuid, p_role text DEFAULT 'ductus_app') RETURNS text
LANGUAGE sql AS $$
  SELECT left(pg_temp.ask_as(p_role, p_actor, replace(p_sql, '$R', quote_literal(coalesce(p_request::text, pg_temp.id('nobody')::text)))), 5)
$$;
-- Counters equal to the ledger: every counter of fak-a and the service is the
-- sum of coalesce(actual, reserved) of its reserved and settled rows.
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
CREATE FUNCTION pg_temp.used(p_scope text, p_key text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(used_micro), 0)::bigint FROM assistant.budget_counter WHERE scope = p_scope AND scope_key = p_key
$$;
CREATE FUNCTION pg_temp.versions(p_institution uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce(max(version_no), 0) FROM assistant.cost_config_version WHERE institution_id IS NOT DISTINCT FROM p_institution
$$;

-- 1. Catalogue.
SELECT is_empty(
  $$ SELECT p.proname || '(' || a.name || ')' FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a (name, n)
      WHERE p.pronamespace = 'assistant'::regnamespace AND has_function_privilege('ductus_app', p.oid, 'EXECUTE')
        AND p.proname <> 'publish_cost_config' AND coalesce(p.proargmodes[a.n], 'i') IN ('i', 'b', 'v')
        AND a.name ~ '(student|user|institution|_cap|limit|reserve|price)' $$,
  'no RPC of the request path takes a student, an institution, a cap, a limit or a reservation (T3, M5, Z4)');
SELECT is(pg_get_function_identity_arguments('assistant.publish_cost_config(integer,bigint,bigint,bigint)'::regprocedure),
  'p_expected_version integer, p_student_day_micro bigint, p_student_assignment_day_micro bigint, p_reserve_micro bigint',
  'the administrator''s publication takes no institution and no cap: the institution is the session''s, the cap the operator''s');
SELECT bag_eq(
  $$ SELECT p.proname::text FROM pg_proc p WHERE p.pronamespace = 'assistant'::regnamespace
      AND p.proname IN ('begin_request', 'mark_sent', 'complete_request', 'fail_request', 'mark_outcome_unknown',
                        'sweep_and_settle', 'read_conversation', 'publish_cost_config')
      AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'] $$,
  $$ VALUES ('begin_request'), ('mark_sent'), ('complete_request'), ('fail_request'), ('mark_outcome_unknown'),
            ('sweep_and_settle'), ('read_conversation'), ('publish_cost_config') $$,
  'the eight RPCs of the contract are SECURITY DEFINER with an empty search_path');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['ductus_app', 'ductus_worker', 'ductus_retention', 'ductus_auth',
                                                 'ductus_evidence', 'public']) AS r
                       WHERE has_function_privilege(r, 'assistant.publish_cost_cap(uuid,integer,bigint,text,text)', 'EXECUTE')),
  'the operator procedure runs for no runtime role and not for PUBLIC');
SELECT is(assistant.stale_reserved_after() || ' ' || assistant.stale_sent_after() || ' ' || assistant.max_paragraph_code_points(),
  '00:05:00 00:10:00 5000', 'the sweep deadlines and the paragraph bound are named constants');

-- 2. Pure parts.
SELECT is(assistant.budget_day(t::timestamptz), d::date, 'the budget day of ' || t || ' is ' || d)
FROM (VALUES ('2026-11-21 22:59:59.999+00', '2026-11-21'), ('2026-11-21 23:00:00+00', '2026-11-22'),
             ('2026-07-01 21:59:59.999+00', '2026-07-01'), ('2026-07-01 22:00:00+00', '2026-07-02'),
             ('2026-03-29 00:59:59+00', '2026-03-29'), ('2026-10-24 22:00:00+00', '2026-10-25')) AS v (t, d);
SELECT is(assistant.period_start('2026-11-22', 'day'), '2026-11-22'::date, 'a day period starts that day');
SELECT is(assistant.period_start('2026-11-22', 'month'), '2026-11-01'::date, 'a month period starts on its first');
SELECT is(assistant.request_sha256('00000000-0000-4000-8000-0000000000a1', NULL, 1, 'proofreading', 'Izmišljeni odlomak.'),
  encode(sha256(convert_to('{"assignmentId":"00000000-0000-4000-8000-0000000000a1","conversationId":null,"paragraphSha256":"'
    || encode(sha256(convert_to('Izmišljeni odlomak.', 'UTF8')), 'hex') || '","purposeCatalogVersion":1,"purposeKey":"proofreading"}', 'UTF8')), 'hex'),
  'the request hash is SHA-256 of the JCS object, keys in order, a missing conversation as null');
SELECT isnt(assistant.request_sha256(pg_temp.id('z1'), NULL, 1, 'proofreading', 'A.'),
            assistant.request_sha256(pg_temp.id('z1'), pg_temp.id('nobody'), 1, 'proofreading', 'A.'),
  'the conversation is part of the hash');

-- 3. The configuration. Nothing published for fak-a: off (P1, Z13).
SELECT is(pg_temp.begin('ana', 1, '{z1}', 'proofreading', 'Izmišljeni prvi odlomak.'), 'rejected|ai_disabled|false',
  'without a configuration of the institution every request is ai_disabled');
SELECT is((SELECT count(*) FROM assistant.conversation WHERE student_id = pg_temp.id('ana')), 0::bigint,
  'a refusal opens no conversation');
SELECT is((SELECT count(*) FROM assistant.cost_ledger l JOIN assistant.request r ON r.id = l.request_id WHERE r.idempotency_key = pg_temp.key(1)),
  0::bigint, 'a refusal reserves nothing');
SELECT is(pg_temp.ask('ana', 'SELECT outcome FROM assistant.publish_cost_config(0, 30, 30, 7)'), 'ZD403: forbidden',
  'a student publishes no configuration');
SELECT is(pg_temp.ask('vesna', 'SELECT outcome FROM assistant.publish_cost_config(0, 30, 30, 7)'), 'ZD403: forbidden',
  'a teacher publishes no configuration');
SELECT is(pg_temp.ask('iva', 'SELECT outcome FROM assistant.publish_cost_config(0, -1, 20, 7)'), 'ZD422: invalid input',
  'a negative limit is invalid');
SELECT is(pg_temp.ask('iva', 'SELECT outcome FROM assistant.publish_cost_config(0, 20, 20, 0)'), 'ZD422: invalid input',
  'a reservation of nothing is invalid');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 30, 30, 7) $$),
  'published:1', 'the administrator publishes the student limits and the reservation');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(0, 30, 30, 7) $$),
  'published:1', 'the same publication again returns its version and writes nothing');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome FROM assistant.publish_cost_config(0, 31, 30, 7) $$), 'ZD409: conflict',
  'another publication from an old version is a conflict');
SELECT is(pg_temp.begin('ana', 2, '{z1}', 'proofreading', 'Izmišljeni drugi odlomak.'), 'rejected|ai_disabled|false',
  'without a cap the institution is still off');
SELECT is(pg_temp.ask_as('ductus_app', 'iva', format($$ SELECT assistant.publish_cost_cap(%L, 1, 100, 'day', 'Zahtjev 1/2026')::text $$, pg_temp.id('fak_a'))),
  '42501: permission denied for function publish_cost_cap', 'the web role cannot run the operator procedure');
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 1, 100, 'day', 'Zahtjev 1/2026'), 2,
  'the operator publishes the cap of the institution on a written request');
SELECT throws_ok(format($$ SELECT assistant.publish_cost_cap(%L, 1, 100, 'day', 'Zahtjev 1/2026') $$, pg_temp.id('fak_a')),
  'ZD409', 'conflict', 'the operator publishes from the latest version only');
SELECT throws_ok($$ SELECT assistant.publish_cost_cap(NULL, 0, 100, 'week', 'Zahtjev 1/2026') $$, 'ZD422', 'invalid input',
  'a cap period is day or month');
SELECT throws_ok(format($$ SELECT assistant.publish_cost_cap(%L, 0, 100, 'day', 'Zahtjev 1/2026') $$, pg_temp.id('nobody')),
  'ZD422', 'invalid input', 'the operator names an institution that exists');
SELECT is(pg_temp.begin('ana', 3, '{z1}', 'proofreading', 'Izmišljeni treći odlomak.'), 'rejected|ai_disabled|false',
  'without a cap of the service it is still off');
SELECT is(assistant.publish_cost_cap(NULL, v.n, 1000000, 'month', 'Zahtjev 2/2026'), v.n + 1,
  'the operator publishes the cap of the service') FROM (SELECT pg_temp.versions(NULL) AS n) AS v;
SELECT is((SELECT student_day_micro || ':' || student_assignment_day_micro || ':' || reserve_micro || ':' || cap_micro || ':' || cap_period
             FROM assistant.cost_config_version WHERE institution_id = pg_temp.id('fak_a') AND version_no = 2),
  '30:30:7:100:day', 'the operator''s version keeps the administrator''s limits');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(2, 101, 20, 7) $$),
  'limit_above_cap:2', 'a student day limit above the cap is refused (T2)');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(2, 30, 101, 7) $$),
  'limit_above_cap:2', 'a student assignment limit above the cap is refused (T2)');
SELECT is(pg_temp.versions(pg_temp.id('fak_a')), 2, 'a refused publication writes no version');
-- The trail (M6): one row per version, the administrator by account, the
-- operator by the written request.
SELECT is((SELECT string_agg(e.version_no || ':' || coalesce(e.actor_id::text, '-') || ':' || coalesce(e.request_ref, '-'), ',' ORDER BY e.version_no)
             FROM audit.assistant_cost_config_event e WHERE e.institution_id = pg_temp.id('fak_a')),
  '1:' || pg_temp.id('iva') || ':-,2:-:Zahtjev 1/2026', 'every version of the institution has its trail row');
SELECT is((SELECT count(*) FROM assistant.cost_config_version v
            WHERE NOT EXISTS (SELECT 1 FROM audit.assistant_cost_config_event e WHERE e.config_version_id = v.id)), 0::bigint,
  'no version is without its trail row');
CREATE FUNCTION pg_temp.untrailed() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_micro, cap_period, published_by)
  VALUES (pg_temp.id('fak_b'), 1, 5, 'day', pg_temp.id('lea'));
  SET CONSTRAINTS assistant.cost_config_version_has_event IMMEDIATE;
  RETURN 'committed';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END
$$;
SELECT is(pg_temp.untrailed(), 'ZD409', 'a version written without its trail row cannot commit (M6)');
SET CONSTRAINTS assistant.cost_config_version_has_event DEFERRED;

-- 4. begin_request. Shape (the route checks it first; the RPC again).
SELECT is(pg_temp.begin('ana', 10, '{z1}', 'proofreading', p.text), 'ZD422: invalid input', 'a paragraph ' || p.why || ' is invalid')
FROM (VALUES ('', 'that is empty'), (repeat('a', 5001), 'over 5000 code points'), (E'Kafé.', 'that is not NFC'),
             (E'Red\rdrugi.', 'with a carriage return'), (E'﻿Tekst.', 'with a BOM'), (E'Tekst ‮ obrnut.', 'with a bidirectional mark'))
  AS p (text, why);
SELECT is(pg_temp.begin('ana', 10, '{z1}', 'proofreading', repeat('ž', 5000)), 'reserved|-|false',
  'a paragraph of exactly 5000 code points passes');
SELECT is(pg_temp.ask('ana', format($$ SELECT state FROM assistant.begin_request(%L, {z1}, NULL, 1, 'proofreading', 'Tekst.',
    'Provider-Test-A', 'model-test-1', 'test-1') $$, pg_temp.key(11))), 'ZD422: invalid input', 'a provider id of a wrong shape is invalid');
SELECT is(pg_temp.ask('ana', format($$ SELECT state FROM assistant.begin_request(NULL, {z1}, NULL, 1, 'proofreading', 'Tekst.',
    'provider-test-a', 'model-test-1', 'test-1') $$)), 'ZD422: invalid input', 'a request without a key is invalid');
SELECT is(pg_temp.begin('ana', 11, '{z1}', 'proofreading', 'Tekst.', 'NULL', 3), 'ZD422: invalid input',
  'a catalogue version that does not exist is invalid');
SELECT is((SELECT count(*) FROM assistant.request WHERE idempotency_key = pg_temp.key(11)), 0::bigint,
  'a request refused on its shape leaves no row, so its key stays free');
SELECT is(pg_temp.begin('anon', 12, '{z1}', 'proofreading', 'Tekst.'), 'ZD401: not authenticated', 'without a session: ZD401');

-- Ownership: one forbidden for every relation that is not the student's (Z8, Z12, M4, M5).
SELECT is(pg_temp.begin(o.actor, 12, o.assignment, 'proofreading', 'Izmišljeni odlomak.', o.conversation), 'ZD403: forbidden', o.why)
FROM (VALUES
  ('ana', '{z3}', 'NULL', 'an assignment of another institution'),
  ('ana', '{nobody}', 'NULL', 'an assignment that does not exist'),
  ('ana', '{z2}', 'NULL', 'an assignment of a course the student is not in'),
  ('vesna', '{z1}', 'NULL', 'the teacher of the course'),
  ('iva', '{z1}', 'NULL', 'the administrator'),
  ('boris', '{z1}', 'NULL', 'a student of no course'),
  ('ana', '{z1}', '{nobody}', 'a conversation that does not exist')
) AS o (actor, assignment, conversation, why);

-- The policy: z1 is at version 2 (partially allowed, proofreading only).
SELECT is(pg_temp.begin('ana', 13, '{z1}', 'formatting', 'Izmišljeni odlomak.'), 'rejected|purpose_not_allowed|false',
  'a purpose the version in force does not list is refused');
SELECT is(pg_temp.begin('ana', 14, '{z1}', 'explanation', 'Izmišljeni odlomak.', 'NULL', 2), 'rejected|purpose_not_allowed|false',
  'a catalogue version other than the assignment''s is refused, a level 2 purpose with it');
SELECT is(pg_temp.begin('ana', 15, '{z1}', 'nepostojeca', 'Izmišljeni odlomak.'), 'rejected|purpose_not_allowed|false',
  'a purpose outside the catalogue is refused');
SELECT is((SELECT count(*) FROM assistant.message m JOIN assistant.request r ON r.id = m.request_id
            WHERE r.idempotency_key IN (pg_temp.key(13), pg_temp.key(14), pg_temp.key(15))), 0::bigint,
  'a refused request keeps no paragraph');

-- A reservation: the conversation, the paragraph as seq 1, the ledger row and four counters.
SELECT is(pg_temp.begin('ana', 20, '{z1}', 'proofreading', 'Izmišljeni odlomak o mostovima.'), 'reserved|-|false',
  'a request inside every limit is reserved');
INSERT INTO ref SELECT 'conv1', conversation_id::text FROM assistant.request WHERE idempotency_key = pg_temp.key(20);
SELECT is((SELECT string_agg(m.seq || ':' || m.role, ',') FROM assistant.message m WHERE m.request_id = pg_temp.rid(20)),
  '1:student_paragraph', 'the paragraph is the first message of the new conversation');
SELECT is((SELECT state || ':' || reserved_micro || ':' || budget_day FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(20)),
  'reserved:7:' || assistant.budget_day(now()), 'the ledger row holds the reservation of the institution on today''s Zagreb day');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger');
-- Idempotency (R3, R4): the same key and request return the same row; another request conflicts.
SELECT is(pg_temp.begin('ana', 20, '{z1}', 'proofreading', 'Izmišljeni odlomak o mostovima.'), 'reserved|-|true',
  'the same key with the same request returns the existing request');
SELECT is(pg_temp.begin('ana', 20, '{z1}', 'proofreading', 'Drugi izmišljeni odlomak.'), 'ZD409: idempotency_conflict',
  'the same key with another paragraph is idempotency_conflict');
SELECT is(pg_temp.begin('ana', 20, '{z1}', 'proofreading', 'Izmišljeni odlomak o mostovima.', '{conv1}'), 'ZD409: idempotency_conflict',
  'the same key naming the conversation is another request too');
SELECT is((SELECT count(*) FROM assistant.cost_ledger WHERE student_id = pg_temp.id('ana')), 2::bigint,
  'a replay reserves nothing again');
SELECT is(pg_temp.begin('dora', 20, '{z1}', 'proofreading', 'Izmišljeni odlomak o mostovima.'), 'reserved|-|false',
  'the same key of another student is another request');
SELECT is(pg_temp.begin('dora', 21, '{z1}', 'proofreading', 'Izmišljeni odlomak.', '{conv1}'), 'ZD403: forbidden',
  'another student cannot write into the conversation');

-- 5. Transitions. 20: sent and completed.
SELECT is(pg_temp.on_request('ana', 'SELECT state FROM assistant.mark_sent($R)', pg_temp.rid(20)), 'sent', 'reserved -> sent');
SELECT is(pg_temp.on_request('ana', 'SELECT state FROM assistant.mark_sent($R)', pg_temp.rid(20)), 'ZD409', 'sent twice is refused');
SELECT is(pg_temp.begin('ana', 20, '{z1}', 'proofreading', 'Izmišljeni odlomak o mostovima.'), 'sent|-|true',
  'a replay while sent answers sent (in_progress)');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.complete_request($R, '', 5) $$, pg_temp.rid(20)), 'ZD422',
  'an empty response is invalid');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.complete_request($R, 'Odgovor.', -1) $$, pg_temp.rid(20)), 'ZD422',
  'a negative cost is invalid');
SELECT is(pg_temp.on_request('ana', $$ SELECT state || ':' || accepted FROM assistant.complete_request($R, 'Izmišljeni odgovor o mostovima.', 5) $$,
  pg_temp.rid(20)), 'compl', 'sent -> completed');
SELECT is((SELECT string_agg(seq || ':' || role, ',' ORDER BY seq) FROM assistant.message WHERE conversation_id = pg_temp.id('conv1')),
  '1:student_paragraph,2:provider_response', 'the response is the next message');
SELECT is((SELECT state || ':' || actual_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(20)), 'settled:5',
  'the cost is settled at the actual amount');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters still equal the ledger after settling below the reservation');
SELECT is(pg_temp.ask('ana', format($$ SELECT state || '|' || replayed || '|' || response FROM assistant.begin_request(%L, {z1}, NULL, 1,
    'proofreading', 'Izmišljeni odlomak o mostovima.', 'provider-test-a', 'model-test-1', 'test-1') $$, pg_temp.key(20))),
  'completed|true|Izmišljeni odgovor o mostovima.', 'a replay after completed returns the same response, no new message (R4)');
SELECT is((SELECT count(*) FROM assistant.message WHERE conversation_id = pg_temp.id('conv1')), 2::bigint, 'still two messages');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.complete_request($R, 'Opet.', 5) $$, pg_temp.rid(20)), 'ZD409',
  'a completed request takes no second response');
SELECT is(pg_temp.ask('ana', 'SELECT string_agg(seq || '':'' || role || '':'' || request_state, '','' ORDER BY seq) FROM assistant.read_conversation({conv1})'),
  '1:student_paragraph:completed,2:provider_response:completed', 'the student reads the conversation by seq with the state of each request');

-- 30: the late response after outcome_unknown is dropped (R7).
SELECT is(pg_temp.begin('ana', 30, '{z1}', 'proofreading', 'Izmišljeni odlomak o rijekama.', '{conv1}'), 'reserved|-|false',
  'a second request in the same conversation is reserved');
SELECT is((SELECT seq FROM assistant.message WHERE request_id = pg_temp.rid(30)), 3, 'its paragraph takes seq 3');
SELECT is(pg_temp.on_request('ana', 'SELECT assistant.mark_outcome_unknown($R)', pg_temp.rid(30)), 'ZD409',
  'reserved cannot become outcome_unknown');
SELECT is(pg_temp.on_request('ana', 'SELECT state FROM assistant.mark_sent($R)', pg_temp.rid(30)), 'sent', 'sent');
SELECT is(pg_temp.on_request('ana', 'SELECT assistant.mark_outcome_unknown($R)', pg_temp.rid(30)), 'outco', 'sent -> outcome_unknown');
SELECT is(pg_temp.on_request('ana', 'SELECT assistant.mark_outcome_unknown($R)', pg_temp.rid(30)), 'outco', 'asked again it answers the same');
SELECT is(pg_temp.on_request('ana', $$ SELECT state || ':' || accepted FROM assistant.complete_request($R, 'Zakašnjeli izmišljeni odgovor.', 3) $$,
  pg_temp.rid(30)), 'outco', 'a response after outcome_unknown is answered with the state');
SELECT is(pg_temp.ask('ana', format($$ SELECT accepted::text FROM assistant.complete_request(%L, 'Zakašnjeli izmišljeni odgovor.', 3) $$, pg_temp.rid(30))),
  'false', '... and not accepted');
SELECT is(pg_temp.ask('ana', format($$ SELECT accepted::text FROM assistant.fail_request(%L, 'provider_failed', 3) $$, pg_temp.rid(30))),
  'false', 'a late failure is not accepted either');
SELECT is((SELECT count(*) FROM assistant.message WHERE request_id = pg_temp.rid(30)), 1::bigint, 'the late response is not written (R7)');
SELECT is((SELECT state FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(30)), 'reserved', 'the late response changes no cost');
SELECT is(pg_temp.begin('ana', 30, '{z1}', 'proofreading', 'Izmišljeni odlomak o rijekama.', '{conv1}'), 'outcome_unknown|-|true',
  'a replay answers outcome_unknown (request_outcome_unknown); a new attempt needs a new key (R5)');
-- The worker settles it at the reservation, once.
SELECT is(pg_temp.on_request('anon', 'SELECT assistant.sweep_and_settle($R)', pg_temp.rid(30), 'ductus_worker'), 'settl',
  'the worker settles outcome_unknown');
SELECT is(pg_temp.on_request('anon', 'SELECT assistant.sweep_and_settle($R)', pg_temp.rid(30), 'ductus_worker'), 'settl',
  'a second run changes nothing');
SELECT is((SELECT state || ':' || actual_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(30)), 'settled:7',
  'settled at the reserved amount (until OA-1)');
SELECT is(pg_temp.on_request('anon', 'SELECT assistant.sweep_and_settle($R)', NULL, 'ductus_worker'), 'ZD403',
  'the worker gets forbidden for a request that does not exist');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger after the sweep');

-- 40: provider_failed with and without a reported cost.
SELECT is(pg_temp.begin('ana', 40, '{z1}', 'proofreading', 'Izmišljeni odlomak o oblacima.', '{conv1}'), 'reserved|-|false', 'reserved');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.fail_request($R, 'provider_failed', 1) $$, pg_temp.rid(40)), 'ZD409',
  'reserved cannot fail: it was never sent');
SELECT is(pg_temp.on_request('ana', 'SELECT state FROM assistant.mark_sent($R)', pg_temp.rid(40)), 'sent', 'sent');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.fail_request($R, 'timeout', 1) $$, pg_temp.rid(40)), 'ZD422',
  'a reason outside the closed set is invalid');
SELECT is(pg_temp.on_request('ana', $$ SELECT state FROM assistant.fail_request($R, 'provider_failed', NULL) $$, pg_temp.rid(40)),
  'provi', 'sent -> provider_failed');
SELECT is((SELECT state || ':' || actual_micro FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(40)), 'settled:7',
  'without a reported amount it is settled at the reservation');

-- The limit of the day: reservations of 7 against a student day limit of 30.
-- Used so far by Ana today: 7 (10) + 5 (20) + 7 (30) + 7 (40) = 26, 26 + 7 > 30, so
-- the next is over the limit; the counters do not move.
SELECT is(pg_temp.used('student_day', pg_temp.id('fak_a') || ':' || pg_temp.id('ana')), 26::bigint,
  'the student''s day counter is the sum of the ledger (a later settlement may go over the limit, R6)');
SELECT is(pg_temp.begin('ana', 50, '{z1}', 'proofreading', 'Izmišljeni odlomak o vjetru.', '{conv1}'), 'rejected|budget_exceeded|false',
  'a request over the student''s day limit is budget_exceeded');
SELECT is(pg_temp.used('student_day', pg_temp.id('fak_a') || ':' || pg_temp.id('ana')), 26::bigint, 'and no counter moved');
SELECT is(pg_temp.used('institution_cap', pg_temp.id('fak_a')::text), 33::bigint, 'the institution counter did not move either');
SELECT is((SELECT count(*) FROM assistant.message WHERE request_id = pg_temp.rid(50)), 0::bigint, 'a budget refusal keeps no paragraph');
-- T2: the operator lowers the cap of the institution under the student
-- limits; the check takes the smaller, Dora (7 so far) can no longer reserve.
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 2, 14, 'day', 'Zahtjev 3/2026'), 3, 'the operator lowers the cap below the limits');
SELECT is(pg_temp.begin('dora', 51, '{z1}', 'proofreading', 'Izmišljeni odlomak.'), 'rejected|budget_exceeded|false',
  'the smaller of the cap and the student limit applies (T2)');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger after the refusals');

-- I3 serially: the relation or the policy goes between reservation and sending.
SELECT is(assistant.publish_cost_cap(pg_temp.id('fak_a'), 3, 100, 'day', 'Zahtjev 4/2026'), 4, 'the cap is raised again');
SELECT is(pg_temp.begin('dora', 60, '{z1}', 'proofreading', 'Izmišljeni odlomak o kiši.'), 'reserved|-|false', 'Dora reserves');
UPDATE institution.course_member SET member_to = now() WHERE user_id = pg_temp.id('dora') AND course_id = pg_temp.id('k1');
SELECT is(pg_temp.ask('dora', format('SELECT state || ''|'' || reason FROM assistant.mark_sent(%L)', pg_temp.rid(60, 'dora'))),
  'rejected|forbidden', 'a student who left the course is not sent: rejected');
SELECT is((SELECT state FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(60, 'dora')), 'released', 'and the reservation is released (I3)');
SELECT is(pg_temp.begin('tomo', 61, '{z3}', 'translation', 'Izmišljeni odlomak za prijevod.'), 'rejected|ai_disabled|false',
  'fak-b has no configuration of its own');
SELECT is(pg_temp.begin('ana', 62, '{z1}', 'proofreading', 'Izmišljeni odlomak o snijegu.', '{conv1}'), 'rejected|budget_exceeded|false',
  'Ana is still over her day limit');
SELECT is(pg_temp.ask('iva', $$ SELECT outcome || ':' || version_no FROM assistant.publish_cost_config(4, 100, 100, 7) $$), 'published:5',
  'the administrator raises the student limits');
SELECT is(pg_temp.begin('ana', 63, '{z1}', 'proofreading', 'Izmišljeni odlomak o magli.', '{conv1}'), 'reserved|-|false', 'Ana reserves');
UPDATE institution.course SET ai_policy = 'prohibited' WHERE id = pg_temp.id('k1');
SELECT is(pg_temp.ask('ana', format('SELECT state || ''|'' || reason FROM assistant.mark_sent(%L)', pg_temp.rid(63))),
  'rejected|purpose_not_allowed', 'a course that became prohibited is not sent: rejected (I3)');
SELECT is((SELECT state FROM assistant.cost_ledger WHERE request_id = pg_temp.rid(63)), 'released', 'and the reservation is released');
SELECT is(pg_temp.begin('ana', 64, '{z1}', 'proofreading', 'Izmišljeni odlomak.', '{conv1}'), 'rejected|purpose_not_allowed|false',
  'a new request on a prohibited course is refused');
UPDATE institution.course SET ai_policy = 'partially_allowed' WHERE id = pg_temp.id('k1');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger after the releases');

-- The sweep of stale rows: a reservation never sent and a request sent long
-- ago, written as the owner with old times (the clock of one transaction does
-- not move), with their ledger rows and counters.
SET LOCAL ROLE ductus_identity;
INSERT INTO assistant.request (id, institution_id, student_id, assignment_id, assignment_version, conversation_id,
  idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id, model_id, config_version, state,
  requested_at, sent_at)
SELECT gen_random_uuid(), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('z1'), 2, pg_temp.id('conv1'), pg_temp.key(s.n),
       repeat('a', 64), 1, 'proofreading', 'provider-test-a', 'model-test-1', 'test-1', s.state, now() - s.age,
       CASE WHEN s.state = 'sent' THEN now() - s.age END
FROM (VALUES (70, 'reserved', interval '6 minutes'), (71, 'sent', interval '11 minutes'),
             (72, 'reserved', interval '4 minutes'), (73, 'sent', interval '9 minutes')) AS s (n, state, age);
INSERT INTO assistant.cost_ledger (request_id, institution_id, student_id, assignment_id, budget_day,
  institution_cap_period_start, service_cap_period_start, reserved_micro, state, reserved_at)
SELECT r.id, r.institution_id, r.student_id, r.assignment_id, assistant.budget_day(now()), assistant.budget_day(now()),
       date_trunc('month', assistant.budget_day(now()))::date, 7, 'reserved', r.requested_at
  FROM assistant.request r WHERE r.idempotency_key IN (pg_temp.key(70), pg_temp.key(71), pg_temp.key(72), pg_temp.key(73));
UPDATE assistant.budget_counter SET used_micro = used_micro + 28
 WHERE (scope = 'service_cap' AND period_start = date_trunc('month', assistant.budget_day(now()))::date)
    OR (scope = 'institution_cap' AND scope_key = pg_temp.id('fak_a')::text AND period_start = assistant.budget_day(now()))
    OR (scope = 'student_day' AND scope_key = pg_temp.id('fak_a') || ':' || pg_temp.id('ana') AND period_start = assistant.budget_day(now()))
    OR (scope = 'student_assignment_day' AND scope_key = pg_temp.id('fak_a') || ':' || pg_temp.id('ana') || ':' || pg_temp.id('z1')
        AND period_start = assistant.budget_day(now()));
RESET ROLE;
SELECT is(pg_temp.drift(), 0::bigint, 'the stale rows are in the ledger and the counters');
SELECT is(pg_temp.on_request('anon', 'SELECT assistant.sweep_and_settle($R)', pg_temp.rid(s.n), 'ductus_worker'), s.outcome, s.why)
FROM (VALUES (70, 'rejec', 'a reservation older than five minutes is rejected'),
             (71, 'settl', 'a request sent more than ten minutes ago becomes outcome_unknown and is settled'),
             (72, 'reser', 'a reservation of four minutes is left alone'),
             (73, 'sent', 'a request sent nine minutes ago is left alone'),
             (70, 'rejec', 'a second run over the rejected one changes nothing'),
             (71, 'settl', 'a second run over the settled one changes nothing')) AS s (n, outcome, why);
SELECT is((SELECT string_agg(r.state || ':' || coalesce(r.reason, '-') || ':' || l.state, ',' ORDER BY r.idempotency_key)
             FROM assistant.request r JOIN assistant.cost_ledger l ON l.request_id = r.id
            WHERE r.idempotency_key IN (pg_temp.key(70), pg_temp.key(71))),
  'rejected:request_outcome_unknown:released,settled:-:settled', 'released and settled once each');
SELECT is(pg_temp.drift(), 0::bigint, 'the counters equal the ledger after the sweep of stale rows');

-- 6. Forbidden: another student's id and an id that does not exist give the same answer.
SELECT is(pg_temp.on_request(o.actor, o.sql, pg_temp.rid(72)), 'ZD403', o.actor || ' gets forbidden from ' || o.what || ' on Ana''s request')
FROM (VALUES ('dora', 'SELECT state FROM assistant.mark_sent($R)', 'mark_sent'),
             ('tomo', $$ SELECT state FROM assistant.complete_request($R, 'Odgovor.', 1) $$, 'complete_request'),
             ('vesna', $$ SELECT state FROM assistant.fail_request($R, 'provider_failed', 1) $$, 'fail_request'),
             ('iva', 'SELECT assistant.mark_outcome_unknown($R)', 'mark_outcome_unknown')) AS o (actor, sql, what);
SELECT is(pg_temp.on_request('ana', o.sql, NULL), 'ZD403', 'Ana gets the same forbidden from ' || o.what || ' on an id that does not exist')
FROM (VALUES ('SELECT state FROM assistant.mark_sent($R)', 'mark_sent'),
             ($$ SELECT state FROM assistant.complete_request($R, 'Odgovor.', 1) $$, 'complete_request'),
             ($$ SELECT state FROM assistant.fail_request($R, 'provider_failed', 1) $$, 'fail_request'),
             ('SELECT assistant.mark_outcome_unknown($R)', 'mark_outcome_unknown')) AS o (sql, what);
SELECT is(pg_temp.ask(a.actor, 'SELECT count(*)::text FROM assistant.read_conversation(' || a.conversation || ')'), 'ZD403: forbidden',
  a.why)
FROM (VALUES ('dora', '{conv1}', 'another student cannot read the conversation'),
             ('vesna', '{conv1}', 'the teacher of the course reads no conversation while it is written (G1)'),
             ('iva', '{conv1}', 'the administrator reads no conversation'),
             ('tomo', '{conv1}', 'a student of another institution reads no conversation'),
             ('ana', '{nobody}', 'a conversation that does not exist gives the same answer')) AS a (actor, conversation, why);
SELECT is((SELECT state FROM assistant.request WHERE idempotency_key = pg_temp.key(72)), 'reserved', 'the refused calls changed nothing');

-- No direct write by the web role or the worker: only the RPCs write (M1, M2).
SELECT is(left(pg_temp.ask_as(r.role, 'ana', s.sql), 5), '42501', r.role || ' cannot ' || s.what)
FROM (VALUES ('ductus_app'), ('ductus_worker')) AS r (role)
CROSS JOIN (VALUES
  ($$ UPDATE assistant.request SET state = 'sent' RETURNING 1 $$, 'move a request'),
  ($$ INSERT INTO assistant.message (conversation_id, institution_id, seq, request_id, role, content, content_sha256)
      VALUES ({conv1}, {fak_a}, 99, {nobody}, 'provider_response', 'X', 'x') RETURNING 1 $$, 'write a message'),
  ($$ UPDATE assistant.budget_counter SET used_micro = 0 RETURNING 1 $$, 'reset a counter'),
  ($$ UPDATE assistant.cost_ledger SET state = 'released' RETURNING 1 $$, 'release a ledger row'),
  ($$ INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_micro, cap_period) VALUES (NULL, 99, 1, 'day') RETURNING 1 $$,
   'publish a configuration'),
  ($$ INSERT INTO audit.assistant_cost_config_event (config_version_id, version_no, kind, request_ref, occurred_at)
      VALUES ({nobody}, 1, 'published', 'Zahtjev', now()) RETURNING 1 $$, 'write the trail')
) AS s (sql, what);

SELECT * FROM finish();
ROLLBACK;
