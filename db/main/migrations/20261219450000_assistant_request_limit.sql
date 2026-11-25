-- migrate:up
-- SRV-ASIST-BROJAC (Ductus#2055 c.7162920212 T2, decision A c.7163132796 and
-- c.7163900837): a daily number of assistant requests per student and
-- assignment. The student sees {limit, used} as a number of requests, never an
-- amount (SRV-1809 stays).
--
--   assistant.cost_config_version.student_assignment_day_requests
--         optional; NULL is no limit. Only an institution's version has one.
--   assistant.write_config_version_requests  the writer with the limit; the
--         old writer keeps its signature and carries the previous limit over
--   assistant.publish_request_limit  the operator procedure that sets it, as
--         publish_cost_cap (no application role may run it)
--   assistant.requests_today(student, assignment)  today's requests that were
--         not refused (Europe/Zagreb, assistant.budget_day)
--   assistant.begin_request  the copy from 20261201130000, changed only by the
--         request limit check; over the limit is the existing budget_exceeded,
--         no new code
--   app.my_assistant_requests(assignment)  a student of the assignment reads
--         {limit, used}; anyone else not_found
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant, app TO ductus_identity;

SET LOCAL ROLE ductus_identity;

ALTER TABLE assistant.cost_config_version
  ADD COLUMN student_assignment_day_requests integer CHECK (student_assignment_day_requests > 0),
  ADD CONSTRAINT cost_config_version_requests_institution
    CHECK (institution_id IS NOT NULL OR student_assignment_day_requests IS NULL);

CREATE INDEX request_student_assignment_idx ON assistant.request (student_id, assignment_id, requested_at);

CREATE FUNCTION assistant.write_config_version_requests(
  p_institution_id uuid, p_expected integer, p_cap_micro bigint, p_cap_period text, p_student_day_micro bigint,
  p_student_assignment_day_micro bigint, p_reserve_micro bigint, p_requests integer, p_actor_id uuid,
  p_request_ref text
) RETURNS integer
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_no integer;
BEGIN
  WITH published AS (
    INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_micro, cap_period, student_day_micro,
      student_assignment_day_micro, reserve_micro, student_assignment_day_requests, published_by)
    VALUES (p_institution_id, p_expected + 1, p_cap_micro, p_cap_period, p_student_day_micro,
            p_student_assignment_day_micro, p_reserve_micro, p_requests, p_actor_id)
    RETURNING id, institution_id, version_no, published_by, published_at
  )
  INSERT INTO audit.assistant_cost_config_event (config_version_id, institution_id, version_no, kind, actor_id,
                                                 request_ref, occurred_at)
  SELECT id, institution_id, version_no, 'published', published_by, p_request_ref, published_at FROM published
  RETURNING version_no INTO v_no;
  RETURN v_no;
END
$$;

-- Every writer of a version (publish_cost_config, publish_cost_cap) keeps the
-- request limit of the version it replaces; only publish_request_limit sets it.
CREATE OR REPLACE FUNCTION assistant.write_config_version(
  p_institution_id uuid, p_expected integer, p_cap_micro bigint, p_cap_period text, p_student_day_micro bigint,
  p_student_assignment_day_micro bigint, p_reserve_micro bigint, p_actor_id uuid, p_request_ref text
) RETURNS integer
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RETURN assistant.write_config_version_requests(p_institution_id, p_expected, p_cap_micro, p_cap_period,
    p_student_day_micro, p_student_assignment_day_micro, p_reserve_micro,
    (SELECT v.student_assignment_day_requests FROM assistant.cost_config_version v
      WHERE v.institution_id IS NOT DISTINCT FROM p_institution_id AND v.version_no = p_expected),
    p_actor_id, p_request_ref);
END
$$;

-- The operator procedure, as publish_cost_cap: the request limit of one
-- institution on a written request; NULL removes it. The other values stay as
-- they are. Runs with the rights of its caller.
CREATE FUNCTION assistant.publish_request_limit(
  p_institution_id uuid, p_expected_version integer, p_requests integer, p_request_ref text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v assistant.cost_config_version;
  v_current integer;
BEGIN
  IF p_institution_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0 OR p_requests <= 0
     OR p_request_ref IS NULL OR p_request_ref <> pg_catalog.btrim(p_request_ref)
     OR NOT coalesce(institution.is_plain_label(p_request_ref), false)
     OR NOT EXISTS (SELECT 1 FROM identity.institution i WHERE i.id = p_institution_id) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v := assistant.latest_config(p_institution_id);
  v_current := coalesce(v.version_no, 0);
  IF p_expected_version <> v_current THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN assistant.write_config_version_requests(p_institution_id, v_current, v.cap_micro,
    coalesce(v.cap_period, 'day'), v.student_day_micro, v.student_assignment_day_micro, v.reserve_micro,
    p_requests, NULL, p_request_ref);
END
$$;

CREATE FUNCTION assistant.requests_today(p_student_id uuid, p_assignment_id uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT count(*)::integer FROM assistant.request q
   WHERE q.student_id = p_student_id AND q.assignment_id = p_assignment_id AND q.state <> 'rejected'
     AND q.requested_at >= (assistant.budget_day(now())::timestamp AT TIME ZONE 'Europe/Zagreb')
$$;

DROP FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]);
CREATE FUNCTION assistant.begin_request(
  p_idempotency_key uuid, p_assignment_id uuid, p_conversation_id uuid, p_purpose_catalog_version integer,
  p_purpose_key text, p_paragraph text, p_provider_id text, p_model_id text, p_config_version text,
  p_offered_tools text[] DEFAULT '{}'::text[]
) RETURNS TABLE (request_id uuid, conversation_id uuid, state text, reason text, replayed boolean,
                 response_id uuid, response text, tools text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  v_sha text;
  v_existing assistant.request;
  v_version integer;
  v_service assistant.cost_config_version;
  v_inst assistant.cost_config_version;
  v_day date;
  v_inst_period date;
  v_service_period date;
  v_reserve bigint;
  v_conversation uuid := p_conversation_id;
  v_request uuid;
  v_reason text;
  v_scope record;
  v_tools text[] := '{}'::text[];
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- Shape first; the route checked it already (Z1 to Z13), the table
  -- constraints would quote the row.
  IF p_idempotency_key IS NULL OR p_assignment_id IS NULL
     OR p_purpose_catalog_version IS NULL OR p_purpose_catalog_version NOT IN (1, 2)
     OR p_purpose_key IS NULL OR p_purpose_key !~ '^[a-z][a-z_]{0,63}$'
     OR NOT assistant.is_paragraph(p_paragraph)
     OR p_provider_id IS NULL OR p_provider_id !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     OR p_model_id IS NULL OR p_model_id !~ '^[a-z0-9][a-z0-9._-]{0,127}$'
     OR p_config_version IS NULL OR p_config_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR NOT assistant.is_tool_list(p_offered_tools) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- Ownership: a student of the assignment, and the own conversation of it.
  IF institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'student'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id)
     OR (p_conversation_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM assistant.conversation c
            WHERE c.id = p_conversation_id AND c.institution_id = actor.institution_id
              AND c.student_id = actor.user_id AND c.assignment_id = p_assignment_id)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  -- The key (R3, R4): one holder at a time per account and key; the same key
  -- with the same request returns what is there, with another one conflicts.
  v_sha := assistant.request_sha256(p_assignment_id, p_conversation_id, p_purpose_catalog_version, p_purpose_key,
                                    p_paragraph);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'assistant.request:' || actor.user_id::text || ':' || p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM assistant.request q
   WHERE q.student_id = actor.user_id AND q.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_sha256 <> v_sha THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'ZD409';
    END IF;
    RETURN QUERY
      SELECT v_existing.id, v_existing.conversation_id, v_existing.state, v_existing.reason, true, m.id, m.content,
             coalesce(t.tools_reserved, '{}'::text[])
        FROM (SELECT 1) AS one
        LEFT JOIN assistant.message m ON m.request_id = v_existing.id AND m.role = 'provider_response'
                                     AND v_existing.state = 'completed'
        LEFT JOIN assistant.tool_loop_reservation t ON t.request_id = v_existing.id;
    RETURN;
  END IF;
  -- Messages of one conversation get their seq one writer at a time (I6).
  IF p_conversation_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'assistant.conversation:' || p_conversation_id::text, 0));
  END IF;

  SELECT a.current_version INTO v_version FROM institution.assignment a WHERE a.id = p_assignment_id;

  -- Policy, then the cost configuration (P1, Z13): a scope without a
  -- published version, or any limit without a value, is off.
  IF NOT assistant.policy_allows(p_assignment_id, v_version, p_purpose_catalog_version, p_purpose_key) THEN
    v_reason := 'purpose_not_allowed';
  ELSE
    SELECT * INTO v_service FROM assistant.cost_config_version v
     WHERE v.institution_id IS NULL ORDER BY v.version_no DESC LIMIT 1;
    SELECT * INTO v_inst FROM assistant.cost_config_version v
     WHERE v.institution_id = actor.institution_id ORDER BY v.version_no DESC LIMIT 1;
    IF v_service.cap_micro IS NULL OR v_inst.cap_micro IS NULL OR v_inst.student_day_micro IS NULL
       OR v_inst.student_assignment_day_micro IS NULL OR v_inst.reserve_micro IS NULL THEN
      v_reason := 'ai_disabled';
    END IF;
  END IF;

  -- SRV-ASIST-BROJAC: the daily number of requests per student and assignment,
  -- when the institution set one. One counter per student and assignment at a
  -- time, held until this call writes its own request row; a refused request
  -- does not count. Over the limit is the existing budget_exceeded.
  IF v_reason IS NULL AND v_inst.student_assignment_day_requests IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'assistant.request_count:' || actor.user_id::text || ':' || p_assignment_id::text, 0));
    IF assistant.requests_today(actor.user_id, p_assignment_id) >= v_inst.student_assignment_day_requests THEN
      v_reason := 'budget_exceeded';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    -- The allowed set at the start (ai-tools-v1, "Trošak petlje alata"): the
    -- code set ∩ what the server permits (switch ∩ ready) ∩ the teacher's
    -- setting in force; the policy passed above. A non-empty set reserves the
    -- whole loop in the same ledger row and the same conditional UPDATEs.
    v_tools := assistant.intersect_tools(p_offered_tools, assistant.latest_tools(p_assignment_id));
    v_reserve := v_inst.reserve_micro * CASE WHEN cardinality(v_tools) > 0 THEN 1 + assistant.tool_step_max() ELSE 1 END;
    v_day := assistant.budget_day(now());
    v_inst_period := assistant.period_start(v_day, v_inst.cap_period);
    v_service_period := assistant.period_start(v_day, v_service.cap_period);
    -- Every scope in the fixed order: the row if it is missing, then one
    -- conditional UPDATE. A student limit counts no higher than the cap of
    -- the institution (T2). If one fails, the block rolls back every counter.
    BEGIN
      FOR v_scope IN
        SELECT * FROM (VALUES
          (1, 'service_cap', '', NULL::uuid, v_service_period, v_service.cap_micro),
          (2, 'institution_cap', actor.institution_id::text, actor.institution_id, v_inst_period, v_inst.cap_micro),
          (3, 'student_day', actor.institution_id || ':' || actor.user_id, actor.institution_id, v_day,
           least(v_inst.student_day_micro, v_inst.cap_micro)),
          (4, 'student_assignment_day', actor.institution_id || ':' || actor.user_id || ':' || p_assignment_id,
           actor.institution_id, v_day, least(v_inst.student_assignment_day_micro, v_inst.cap_micro))
        ) AS s (n, scope, scope_key, institution_id, period_start, bound) ORDER BY n
      LOOP
        INSERT INTO assistant.budget_counter (scope, scope_key, institution_id, period_start, used_micro)
        VALUES (v_scope.scope, v_scope.scope_key, v_scope.institution_id, v_scope.period_start, 0)
        ON CONFLICT ON CONSTRAINT budget_counter_pkey DO NOTHING;
        UPDATE assistant.budget_counter b SET used_micro = b.used_micro + v_reserve
         WHERE b.scope = v_scope.scope AND b.scope_key = v_scope.scope_key
           AND b.period_start = v_scope.period_start AND b.used_micro + v_reserve <= v_scope.bound;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'budget' USING ERRCODE = 'ZD429';
        END IF;
      END LOOP;
    EXCEPTION WHEN SQLSTATE 'ZD429' THEN
      v_reason := 'budget_exceeded';
    END;
  END IF;

  IF v_reason IS NOT NULL THEN
    -- A refusal keeps no paragraph and opens no conversation.
    INSERT INTO assistant.request AS q (institution_id, student_id, assignment_id, assignment_version,
      conversation_id, idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id,
      model_id, config_version, state, reason, finished_at)
    VALUES (actor.institution_id, actor.user_id, p_assignment_id, v_version, p_conversation_id, p_idempotency_key,
            v_sha, p_purpose_catalog_version, p_purpose_key, p_provider_id, p_model_id, p_config_version,
            'rejected', v_reason, now())
    ON CONFLICT (student_id, idempotency_key) DO NOTHING
    RETURNING q.id INTO v_request;
  ELSE
    IF v_conversation IS NULL THEN
      INSERT INTO assistant.conversation AS c (institution_id, student_id, assignment_id)
      VALUES (actor.institution_id, actor.user_id, p_assignment_id)
      RETURNING c.id INTO v_conversation;
    END IF;
    INSERT INTO assistant.request AS q (institution_id, student_id, assignment_id, assignment_version,
      conversation_id, idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id,
      model_id, config_version, state)
    VALUES (actor.institution_id, actor.user_id, p_assignment_id, v_version, v_conversation, p_idempotency_key,
            v_sha, p_purpose_catalog_version, p_purpose_key, p_provider_id, p_model_id, p_config_version, 'reserved')
    ON CONFLICT (student_id, idempotency_key) DO NOTHING
    RETURNING q.id INTO v_request;
    INSERT INTO assistant.message (conversation_id, institution_id, seq, request_id, role, content, content_sha256)
    SELECT v_conversation, actor.institution_id,
           1 + coalesce((SELECT max(m.seq) FROM assistant.message m WHERE m.conversation_id = v_conversation), 0),
           v_request, 'student_paragraph', p_paragraph, encode(sha256(convert_to(p_paragraph, 'UTF8')), 'hex');
    INSERT INTO assistant.cost_ledger (request_id, institution_id, student_id, assignment_id, budget_day,
      institution_cap_period_start, service_cap_period_start, reserved_micro, state)
    VALUES (v_request, actor.institution_id, actor.user_id, p_assignment_id, v_day, v_inst_period, v_service_period,
            v_reserve, 'reserved');
    IF cardinality(v_tools) > 0 THEN
      INSERT INTO assistant.tool_loop_reservation (request_id, institution_id, steps_reserved, tools_reserved)
      VALUES (v_request, actor.institution_id, assistant.tool_step_max(), v_tools);
    END IF;
  END IF;
  RETURN QUERY SELECT v_request, CASE WHEN v_reason IS NULL THEN v_conversation ELSE p_conversation_id END,
                      CASE WHEN v_reason IS NULL THEN 'reserved' ELSE 'rejected' END, v_reason, false,
                      NULL::uuid, NULL::text, CASE WHEN v_reason IS NULL THEN v_tools ELSE '{}'::text[] END;
END
$$;

-- A student of the assignment reads the limit of the own institution and the
-- requests counted today, as app.my_assistant_available; anyone else, an
-- unknown and a null assignment: not_found.
CREATE FUNCTION app.my_assistant_requests(p_assignment_id uuid)
RETURNS TABLE (outcome text, request_limit integer, used integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor record;
BEGIN
  SELECT r.user_id, r.institution_id INTO v_actor FROM institution.require_actor() r;
  IF NOT EXISTS (SELECT 1 FROM institution.assignment a
                  WHERE a.id = p_assignment_id AND a.institution_id = v_actor.institution_id)
     OR institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'student' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'found'::text,
    (SELECT v.student_assignment_day_requests FROM assistant.cost_config_version v
      WHERE v.institution_id = v_actor.institution_id ORDER BY v.version_no DESC LIMIT 1),
    assistant.requests_today(v_actor.user_id, p_assignment_id);
END
$$;

REVOKE ALL ON FUNCTION assistant.write_config_version_requests(uuid, integer, bigint, text, bigint, bigint, bigint, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.write_config_version(uuid, integer, bigint, text, bigint, bigint, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.publish_request_limit(uuid, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.requests_today(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.my_assistant_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]) TO ductus_app;
GRANT EXECUTE ON FUNCTION app.my_assistant_requests(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant, app FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (Ductus docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.my_assistant_requests(uuid);
DROP FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]);
CREATE FUNCTION assistant.begin_request(
  p_idempotency_key uuid, p_assignment_id uuid, p_conversation_id uuid, p_purpose_catalog_version integer,
  p_purpose_key text, p_paragraph text, p_provider_id text, p_model_id text, p_config_version text,
  p_offered_tools text[] DEFAULT '{}'::text[]
) RETURNS TABLE (request_id uuid, conversation_id uuid, state text, reason text, replayed boolean,
                 response_id uuid, response text, tools text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  v_sha text;
  v_existing assistant.request;
  v_version integer;
  v_service assistant.cost_config_version;
  v_inst assistant.cost_config_version;
  v_day date;
  v_inst_period date;
  v_service_period date;
  v_reserve bigint;
  v_conversation uuid := p_conversation_id;
  v_request uuid;
  v_reason text;
  v_scope record;
  v_tools text[] := '{}'::text[];
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  -- Shape first; the route checked it already (Z1 to Z13), the table
  -- constraints would quote the row.
  IF p_idempotency_key IS NULL OR p_assignment_id IS NULL
     OR p_purpose_catalog_version IS NULL OR p_purpose_catalog_version NOT IN (1, 2)
     OR p_purpose_key IS NULL OR p_purpose_key !~ '^[a-z][a-z_]{0,63}$'
     OR NOT assistant.is_paragraph(p_paragraph)
     OR p_provider_id IS NULL OR p_provider_id !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     OR p_model_id IS NULL OR p_model_id !~ '^[a-z0-9][a-z0-9._-]{0,127}$'
     OR p_config_version IS NULL OR p_config_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR NOT assistant.is_tool_list(p_offered_tools) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  -- Ownership: a student of the assignment, and the own conversation of it.
  IF institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'student'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id)
     OR (p_conversation_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM assistant.conversation c
            WHERE c.id = p_conversation_id AND c.institution_id = actor.institution_id
              AND c.student_id = actor.user_id AND c.assignment_id = p_assignment_id)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  -- The key (R3, R4): one holder at a time per account and key; the same key
  -- with the same request returns what is there, with another one conflicts.
  v_sha := assistant.request_sha256(p_assignment_id, p_conversation_id, p_purpose_catalog_version, p_purpose_key,
                                    p_paragraph);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'assistant.request:' || actor.user_id::text || ':' || p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM assistant.request q
   WHERE q.student_id = actor.user_id AND q.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_sha256 <> v_sha THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'ZD409';
    END IF;
    RETURN QUERY
      SELECT v_existing.id, v_existing.conversation_id, v_existing.state, v_existing.reason, true, m.id, m.content,
             coalesce(t.tools_reserved, '{}'::text[])
        FROM (SELECT 1) AS one
        LEFT JOIN assistant.message m ON m.request_id = v_existing.id AND m.role = 'provider_response'
                                     AND v_existing.state = 'completed'
        LEFT JOIN assistant.tool_loop_reservation t ON t.request_id = v_existing.id;
    RETURN;
  END IF;
  -- Messages of one conversation get their seq one writer at a time (I6).
  IF p_conversation_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'assistant.conversation:' || p_conversation_id::text, 0));
  END IF;

  SELECT a.current_version INTO v_version FROM institution.assignment a WHERE a.id = p_assignment_id;

  -- Policy, then the cost configuration (P1, Z13): a scope without a
  -- published version, or any limit without a value, is off.
  IF NOT assistant.policy_allows(p_assignment_id, v_version, p_purpose_catalog_version, p_purpose_key) THEN
    v_reason := 'purpose_not_allowed';
  ELSE
    SELECT * INTO v_service FROM assistant.cost_config_version v
     WHERE v.institution_id IS NULL ORDER BY v.version_no DESC LIMIT 1;
    SELECT * INTO v_inst FROM assistant.cost_config_version v
     WHERE v.institution_id = actor.institution_id ORDER BY v.version_no DESC LIMIT 1;
    IF v_service.cap_micro IS NULL OR v_inst.cap_micro IS NULL OR v_inst.student_day_micro IS NULL
       OR v_inst.student_assignment_day_micro IS NULL OR v_inst.reserve_micro IS NULL THEN
      v_reason := 'ai_disabled';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    -- The allowed set at the start (ai-tools-v1, "Trošak petlje alata"): the
    -- code set ∩ what the server permits (switch ∩ ready) ∩ the teacher's
    -- setting in force; the policy passed above. A non-empty set reserves the
    -- whole loop in the same ledger row and the same conditional UPDATEs.
    v_tools := assistant.intersect_tools(p_offered_tools, assistant.latest_tools(p_assignment_id));
    v_reserve := v_inst.reserve_micro * CASE WHEN cardinality(v_tools) > 0 THEN 1 + assistant.tool_step_max() ELSE 1 END;
    v_day := assistant.budget_day(now());
    v_inst_period := assistant.period_start(v_day, v_inst.cap_period);
    v_service_period := assistant.period_start(v_day, v_service.cap_period);
    -- Every scope in the fixed order: the row if it is missing, then one
    -- conditional UPDATE. A student limit counts no higher than the cap of
    -- the institution (T2). If one fails, the block rolls back every counter.
    BEGIN
      FOR v_scope IN
        SELECT * FROM (VALUES
          (1, 'service_cap', '', NULL::uuid, v_service_period, v_service.cap_micro),
          (2, 'institution_cap', actor.institution_id::text, actor.institution_id, v_inst_period, v_inst.cap_micro),
          (3, 'student_day', actor.institution_id || ':' || actor.user_id, actor.institution_id, v_day,
           least(v_inst.student_day_micro, v_inst.cap_micro)),
          (4, 'student_assignment_day', actor.institution_id || ':' || actor.user_id || ':' || p_assignment_id,
           actor.institution_id, v_day, least(v_inst.student_assignment_day_micro, v_inst.cap_micro))
        ) AS s (n, scope, scope_key, institution_id, period_start, bound) ORDER BY n
      LOOP
        INSERT INTO assistant.budget_counter (scope, scope_key, institution_id, period_start, used_micro)
        VALUES (v_scope.scope, v_scope.scope_key, v_scope.institution_id, v_scope.period_start, 0)
        ON CONFLICT ON CONSTRAINT budget_counter_pkey DO NOTHING;
        UPDATE assistant.budget_counter b SET used_micro = b.used_micro + v_reserve
         WHERE b.scope = v_scope.scope AND b.scope_key = v_scope.scope_key
           AND b.period_start = v_scope.period_start AND b.used_micro + v_reserve <= v_scope.bound;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'budget' USING ERRCODE = 'ZD429';
        END IF;
      END LOOP;
    EXCEPTION WHEN SQLSTATE 'ZD429' THEN
      v_reason := 'budget_exceeded';
    END;
  END IF;

  IF v_reason IS NOT NULL THEN
    -- A refusal keeps no paragraph and opens no conversation.
    INSERT INTO assistant.request AS q (institution_id, student_id, assignment_id, assignment_version,
      conversation_id, idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id,
      model_id, config_version, state, reason, finished_at)
    VALUES (actor.institution_id, actor.user_id, p_assignment_id, v_version, p_conversation_id, p_idempotency_key,
            v_sha, p_purpose_catalog_version, p_purpose_key, p_provider_id, p_model_id, p_config_version,
            'rejected', v_reason, now())
    ON CONFLICT (student_id, idempotency_key) DO NOTHING
    RETURNING q.id INTO v_request;
  ELSE
    IF v_conversation IS NULL THEN
      INSERT INTO assistant.conversation AS c (institution_id, student_id, assignment_id)
      VALUES (actor.institution_id, actor.user_id, p_assignment_id)
      RETURNING c.id INTO v_conversation;
    END IF;
    INSERT INTO assistant.request AS q (institution_id, student_id, assignment_id, assignment_version,
      conversation_id, idempotency_key, request_sha256, purpose_catalog_version, purpose_key, provider_id,
      model_id, config_version, state)
    VALUES (actor.institution_id, actor.user_id, p_assignment_id, v_version, v_conversation, p_idempotency_key,
            v_sha, p_purpose_catalog_version, p_purpose_key, p_provider_id, p_model_id, p_config_version, 'reserved')
    ON CONFLICT (student_id, idempotency_key) DO NOTHING
    RETURNING q.id INTO v_request;
    INSERT INTO assistant.message (conversation_id, institution_id, seq, request_id, role, content, content_sha256)
    SELECT v_conversation, actor.institution_id,
           1 + coalesce((SELECT max(m.seq) FROM assistant.message m WHERE m.conversation_id = v_conversation), 0),
           v_request, 'student_paragraph', p_paragraph, encode(sha256(convert_to(p_paragraph, 'UTF8')), 'hex');
    INSERT INTO assistant.cost_ledger (request_id, institution_id, student_id, assignment_id, budget_day,
      institution_cap_period_start, service_cap_period_start, reserved_micro, state)
    VALUES (v_request, actor.institution_id, actor.user_id, p_assignment_id, v_day, v_inst_period, v_service_period,
            v_reserve, 'reserved');
    IF cardinality(v_tools) > 0 THEN
      INSERT INTO assistant.tool_loop_reservation (request_id, institution_id, steps_reserved, tools_reserved)
      VALUES (v_request, actor.institution_id, assistant.tool_step_max(), v_tools);
    END IF;
  END IF;
  RETURN QUERY SELECT v_request, CASE WHEN v_reason IS NULL THEN v_conversation ELSE p_conversation_id END,
                      CASE WHEN v_reason IS NULL THEN 'reserved' ELSE 'rejected' END, v_reason, false,
                      NULL::uuid, NULL::text, CASE WHEN v_reason IS NULL THEN v_tools ELSE '{}'::text[] END;
END
$$;
REVOKE ALL ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]) TO ductus_app;
DROP FUNCTION assistant.requests_today(uuid, uuid);
DROP FUNCTION assistant.publish_request_limit(uuid, integer, integer, text);
CREATE OR REPLACE FUNCTION assistant.write_config_version(
  p_institution_id uuid, p_expected integer, p_cap_micro bigint, p_cap_period text, p_student_day_micro bigint,
  p_student_assignment_day_micro bigint, p_reserve_micro bigint, p_actor_id uuid, p_request_ref text
) RETURNS integer
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_no integer;
BEGIN
  WITH published AS (
    INSERT INTO assistant.cost_config_version (institution_id, version_no, cap_micro, cap_period, student_day_micro,
      student_assignment_day_micro, reserve_micro, published_by)
    VALUES (p_institution_id, p_expected + 1, p_cap_micro, p_cap_period, p_student_day_micro,
            p_student_assignment_day_micro, p_reserve_micro, p_actor_id)
    RETURNING id, institution_id, version_no, published_by, published_at
  )
  INSERT INTO audit.assistant_cost_config_event (config_version_id, institution_id, version_no, kind, actor_id,
                                                 request_ref, occurred_at)
  SELECT id, institution_id, version_no, 'published', published_by, p_request_ref, published_at FROM published
  RETURNING version_no INTO v_no;
  RETURN v_no;
END
$$;
DROP FUNCTION assistant.write_config_version_requests(uuid, integer, bigint, text, bigint, bigint, bigint, integer, uuid, text);
DROP INDEX assistant.request_student_assignment_idx;
ALTER TABLE assistant.cost_config_version
  DROP CONSTRAINT cost_config_version_requests_institution,
  DROP COLUMN student_assignment_day_requests;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
