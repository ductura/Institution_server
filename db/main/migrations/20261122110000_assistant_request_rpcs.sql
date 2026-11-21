-- migrate:up
-- SRV-1203 (Val 12 / M9.0-S2, Ductus#2052): step 3 of the contract
-- Ductus docs/contracts/ai-request-v1.md (DAN-401; plan of attack Ductus#1662),
-- sections "Politika", "Stanja", "RPC-ovi", "Idempotencija" and "Matrica
-- pristupa". The RPCs that write the schema assistant (20261122100000):
--
--   assistant.begin_request         the AI proxy route: key, policy, cost configuration, reservation
--   assistant.mark_sent             reserved -> sent, or rejected when the policy or the relation is gone (I3)
--   assistant.complete_request      sent -> completed: the response message and the settlement
--   assistant.fail_request          sent -> provider_failed: the settlement
--   assistant.mark_outcome_unknown  sent -> outcome_unknown: the reservation stays
--   assistant.sweep_and_settle      the worker: stale reserved -> rejected, stale sent -> outcome_unknown,
--                                   outcome_unknown -> settled; twice settles once
--   assistant.read_conversation     the owning student: the messages by seq with the state of their request
--   assistant.publish_cost_config   the institution administrator: the student limits and the reservation
--   assistant.publish_cost_cap      the operator (no application role): the cap and its period of a scope
--
-- Every RPC an application role runs is SECURITY DEFINER with search_path ''
-- and takes the actor from institution.require_actor() (the worker's from its
-- role); no parameter names a student, an institution, an amount or a limit.
-- Another student's id and an id that does not exist give the same ZD403
-- (M4, M5). Errors carry no input: ZD401 no session, ZD403 forbidden, ZD409
-- idempotency_conflict (begin_request), a transition outside the table or a
-- publication from a version that is not the latest, ZD422 invalid input.
-- A refusal of the contract ("rejected" with ai_disabled, purpose_not_allowed
-- or budget_exceeded, limit_above_cap) is an answer, not an error.
--
-- Time comes from the database clock; a budget day is a calendar day in
-- Europe/Zagreb (R8, T6). The amounts are bigint micro-euros and none is
-- written here (OA-2); the providers and models are whatever the route names
-- from the versioned configuration (Q-10: none is chosen here).
--
-- Locks, always in this order, so no two calls wait on each other in a cycle:
-- the request row (FOR UPDATE), the idempotency key and the conversation
-- (advisory, transaction-scoped), then the counters in the fixed order
-- service_cap, institution_cap, student_day, student_assignment_day.
--
-- Two additions to the schema of step 2, both needed by the contract:
--   * cost_config_version.published_by may be NULL: the operator, who
--     publishes the caps (also of an institution), has no account (V-7);
--     every version has its row in audit.assistant_cost_config_event, which
--     names the administrator or, for the operator, the written request (M6);
--   * cost_config_version is unique on (id, institution_id), so that row
--     names its version together with the institution (033).
SET LOCAL ROLE ductus_migrator;
GRANT USAGE ON SCHEMA assistant TO ductus_worker;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- squawk-ignore ban-drop-not-null
ALTER TABLE assistant.cost_config_version ALTER COLUMN published_by DROP NOT NULL;
-- The table is empty until this step: nothing wrote it before.
-- squawk-ignore disallowed-unique-constraint
ALTER TABLE assistant.cost_config_version ADD CONSTRAINT cost_config_version_id_institution_key
  UNIQUE (id, institution_id);

-- The trail of cost configurations: one row per version, written by the same
-- statement as the version. An administrator's row names the account; the
-- operator's names the written request (a register number, never a name).
CREATE TABLE audit.assistant_cost_config_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_version_id uuid NOT NULL UNIQUE,
  -- NULL: the whole service.
  institution_id uuid,
  version_no integer NOT NULL,
  kind text NOT NULL CHECK (kind = 'published'),
  actor_id uuid,
  request_ref text CHECK (request_ref IS NULL
                          OR (request_ref = btrim(request_ref) AND institution.is_plain_label(request_ref))),
  occurred_at timestamptz NOT NULL,
  CHECK ((actor_id IS NULL) <> (request_ref IS NULL)),
  CHECK (institution_id IS NOT NULL OR actor_id IS NULL),
  FOREIGN KEY (config_version_id, institution_id) REFERENCES assistant.cost_config_version (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assistant_cost_config_event_actor_idx ON audit.assistant_cost_config_event (actor_id, institution_id);
CREATE TRIGGER assistant_cost_config_event_append_only BEFORE UPDATE OR DELETE ON audit.assistant_cost_config_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER assistant_cost_config_event_no_truncate BEFORE TRUNCATE ON audit.assistant_cost_config_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.assistant_cost_config_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.assistant_cost_config_event FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_cost_config_event_owner ON audit.assistant_cost_config_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The event names its own version: same id, scope, number and publisher. The
-- foreign key does not hold for the service scope (NULL institution), this does.
CREATE FUNCTION assistant.check_config_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assistant.cost_config_version v
                  WHERE v.id = NEW.config_version_id AND v.institution_id IS NOT DISTINCT FROM NEW.institution_id
                    AND v.version_no = NEW.version_no AND v.published_by IS NOT DISTINCT FROM NEW.actor_id) THEN
    RAISE EXCEPTION 'assistant: config event without its version' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assistant_cost_config_event_names_version BEFORE INSERT ON audit.assistant_cost_config_event
  FOR EACH ROW EXECUTE FUNCTION assistant.check_config_event();

-- No version without its trail row, checked at commit (M6). The definer reads
-- the trail, which no application role may.
CREATE FUNCTION assistant.check_config_version_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.assistant_cost_config_event e WHERE e.config_version_id = NEW.id) THEN
    RAISE EXCEPTION 'assistant: config version without audit row' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER cost_config_version_has_event AFTER INSERT ON assistant.cost_config_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assistant.check_config_version_event();

-- Named constants of the sweep (contract, "Stanja"): a reservation not sent
-- by then is stale, a sent request without an outcome by then is unknown.
CREATE FUNCTION assistant.stale_reserved_after() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT interval '5 minutes' $$;
CREATE FUNCTION assistant.stale_sent_after() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT interval '10 minutes' $$;
-- Z9: the bound of a paragraph in code points after NFC, as
-- MAX_PARAGRAPH_CODE_POINTS of server/domain/assistant/request.ts.
CREATE FUNCTION assistant.max_paragraph_code_points() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 5000 $$;

-- The calendar day in Europe/Zagreb of a moment, and the first day of the
-- period of a cap that holds that day (T6).
CREATE FUNCTION assistant.budget_day(p_at timestamptz) RETURNS date
LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT (p_at AT TIME ZONE 'Europe/Zagreb')::date $$;
CREATE FUNCTION assistant.period_start(p_day date, p_period text) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT CASE p_period WHEN 'day' THEN p_day WHEN 'month' THEN date_trunc('month', p_day)::date END $$;

-- A paragraph as the route admits it (Z9, Z10): NFC, 1 to the bound in code
-- points, no C0 or C1 control but tab and line feed, no BOM, no bidirectional
-- or invisible mark. The route checks first; this repeats it at the boundary.
CREATE FUNCTION assistant.is_paragraph(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(
    p_text IS NFC NORMALIZED
    AND char_length(p_text) BETWEEN 1 AND assistant.max_paragraph_code_points()
    AND p_text !~ '[\x0001-\x0008\x000B-\x001F\x007F-\x009F\xFEFF\x200E\x200F\x202A-\x202E\x2066-\x2069]',
    false)
$$;

-- SHA-256 of the JCS object of the contract: {assignmentId, conversationId,
-- purposeCatalogVersion, purposeKey, paragraphSha256}, keys in code point
-- order. Every value is a lower-case uuid, null, a small integer or a key of
-- [a-z_], so none needs escaping.
CREATE FUNCTION assistant.request_sha256(
  p_assignment_id uuid, p_conversation_id uuid, p_purpose_catalog_version integer, p_purpose_key text,
  p_paragraph text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(
    '{"assignmentId":"' || p_assignment_id::text
    || '","conversationId":' || coalesce('"' || p_conversation_id::text || '"', 'null')
    || ',"paragraphSha256":"' || encode(sha256(convert_to(p_paragraph, 'UTF8')), 'hex')
    || '","purposeCatalogVersion":' || p_purpose_catalog_version::text
    || ',"purposeKey":"' || p_purpose_key || '"}', 'UTF8')), 'hex')
$$;

-- The policy of a request (contract, "Politika"; as server/domain/assistant/
-- policy.ts): the narrower of the course rule (the faculty rule is only its
-- default, D-175; a mentorship has no course) and the assignment version in
-- force; never prohibited; the catalogue version of the assignment; the
-- purpose in that catalogue and listed on the version, so a level 2 purpose
-- passes only when the teacher listed it (D-64). Transcription needs the
-- institution switch (#1664, OC-1), which is off: [OC-1] it is refused here.
CREATE FUNCTION assistant.policy_allows(
  p_assignment_id uuid, p_version integer, p_purpose_catalog_version integer, p_purpose_key text
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT least(coalesce(institution.ai_policy_rank(c.ai_policy), 99), institution.ai_policy_rank(v.ai_policy)) > 1
       AND v.purpose_catalog_version = p_purpose_catalog_version
       AND p_purpose_key = ANY (institution.purpose_catalog_keys(v.purpose_catalog_version))
       AND p_purpose_key = ANY (v.ai_purposes)
       AND p_purpose_key <> 'transcription'
      FROM institution.assignment a
      JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = p_version
      LEFT JOIN institution.course c ON c.id = a.course_id
     WHERE a.id = p_assignment_id), false)
$$;

-- Moves the four counters a ledger row was reserved under by p_delta, in the
-- fixed order. The keys come from the row, never from today's configuration
-- (T6). No bound: a larger actual cost counts (R6).
CREATE FUNCTION assistant.move_counters(p_request_id uuid, p_delta bigint) RETURNS void
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  l record;
BEGIN
  SELECT * INTO STRICT l FROM assistant.cost_ledger WHERE request_id = p_request_id;
  IF p_delta = 0 THEN
    RETURN;
  END IF;
  UPDATE assistant.budget_counter SET used_micro = used_micro + p_delta
   WHERE scope = 'service_cap' AND scope_key = '' AND period_start = l.service_cap_period_start;
  UPDATE assistant.budget_counter SET used_micro = used_micro + p_delta
   WHERE scope = 'institution_cap' AND scope_key = l.institution_id::text
     AND period_start = l.institution_cap_period_start;
  UPDATE assistant.budget_counter SET used_micro = used_micro + p_delta
   WHERE scope = 'student_day' AND scope_key = l.institution_id || ':' || l.student_id
     AND period_start = l.budget_day;
  UPDATE assistant.budget_counter SET used_micro = used_micro + p_delta
   WHERE scope = 'student_assignment_day'
     AND scope_key = l.institution_id || ':' || l.student_id || ':' || l.assignment_id
     AND period_start = l.budget_day;
END
$$;

-- Settles a reserved ledger row at p_actual (the reservation when NULL), or
-- releases it; the counters move by the difference. Only a reserved row.
CREATE FUNCTION assistant.close_ledger(p_request_id uuid, p_settle boolean, p_actual bigint) RETURNS void
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_reserved bigint;
  v_actual bigint;
BEGIN
  SELECT l.reserved_micro INTO STRICT v_reserved FROM assistant.cost_ledger l
   WHERE l.request_id = p_request_id AND l.state = 'reserved';
  IF p_settle THEN
    v_actual := coalesce(p_actual, v_reserved);
    UPDATE assistant.cost_ledger SET state = 'settled', actual_micro = v_actual, settled_at = now()
     WHERE request_id = p_request_id;
    PERFORM assistant.move_counters(p_request_id, v_actual - v_reserved);
  ELSE
    UPDATE assistant.cost_ledger SET state = 'released', settled_at = now() WHERE request_id = p_request_id;
    PERFORM assistant.move_counters(p_request_id, -v_reserved);
  END IF;
END
$$;

-- The caller's own request, locked, or ZD403 for foreign and missing alike.
CREATE FUNCTION assistant.own_request(p_request_id uuid) RETURNS assistant.request
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  actor record;
  r assistant.request;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  SELECT * INTO r FROM assistant.request q
   WHERE q.id = p_request_id AND q.student_id = actor.user_id AND q.institution_id = actor.institution_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN r;
END
$$;

CREATE FUNCTION assistant.begin_request(
  p_idempotency_key uuid, p_assignment_id uuid, p_conversation_id uuid, p_purpose_catalog_version integer,
  p_purpose_key text, p_paragraph text, p_provider_id text, p_model_id text, p_config_version text
) RETURNS TABLE (request_id uuid, conversation_id uuid, state text, reason text, replayed boolean,
                 response_id uuid, response text)
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
     OR p_config_version IS NULL OR p_config_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
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
      SELECT v_existing.id, v_existing.conversation_id, v_existing.state, v_existing.reason, true, m.id, m.content
        FROM (SELECT 1) AS one
        LEFT JOIN assistant.message m ON m.request_id = v_existing.id AND m.role = 'provider_response'
                                     AND v_existing.state = 'completed';
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
    v_reserve := v_inst.reserve_micro;
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
  END IF;
  RETURN QUERY SELECT v_request, CASE WHEN v_reason IS NULL THEN v_conversation ELSE p_conversation_id END,
                      CASE WHEN v_reason IS NULL THEN 'reserved' ELSE 'rejected' END, v_reason, false,
                      NULL::uuid, NULL::text;
END
$$;

-- reserved -> sent after checking again the relation and the policy (I3);
-- when either is gone, rejected and the reservation released. The route calls
-- the port only after this commits with "sent" (R2).
CREATE FUNCTION assistant.mark_sent(p_request_id uuid) RETURNS TABLE (state text, reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
  v_version integer;
  v_reason text;
BEGIN
  IF r.state <> 'reserved' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  SELECT a.current_version INTO v_version FROM institution.assignment a WHERE a.id = r.assignment_id;
  IF institution.actor_assignment_role(r.assignment_id) IS DISTINCT FROM 'student' THEN
    v_reason := 'forbidden';
  ELSIF NOT assistant.policy_allows(r.assignment_id, v_version, r.purpose_catalog_version, r.purpose_key) THEN
    v_reason := 'purpose_not_allowed';
  END IF;
  IF v_reason IS NULL THEN
    UPDATE assistant.request q SET state = 'sent', sent_at = now() WHERE q.id = r.id;
    RETURN QUERY SELECT 'sent'::text, NULL::text;
  ELSE
    UPDATE assistant.request q SET state = 'rejected', reason = v_reason, finished_at = now() WHERE q.id = r.id;
    PERFORM assistant.close_ledger(r.id, false, NULL);
    RETURN QUERY SELECT 'rejected'::text, v_reason;
  END IF;
END
$$;

-- sent -> completed: the response as the next message and the settlement at
-- the actual cost, in one transaction. A response after outcome_unknown (or
-- once settled) is dropped: no message, no change of cost (R7).
CREATE FUNCTION assistant.complete_request(p_request_id uuid, p_response text, p_actual_micro bigint)
RETURNS TABLE (state text, accepted boolean, response_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
  v_text text;
  v_id uuid;
BEGIN
  IF r.state IN ('outcome_unknown', 'settled') THEN
    RETURN QUERY SELECT r.state, false, NULL::uuid;
    RETURN;
  END IF;
  IF r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  v_text := normalize(p_response, NFC);
  IF v_text IS NULL OR char_length(v_text) NOT BETWEEN 1 AND 40000 OR p_actual_micro IS NULL OR p_actual_micro < 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'assistant.conversation:' || r.conversation_id::text, 0));
  INSERT INTO assistant.message AS m (conversation_id, institution_id, seq, request_id, role, content, content_sha256)
  SELECT r.conversation_id, r.institution_id,
         1 + coalesce((SELECT max(x.seq) FROM assistant.message x WHERE x.conversation_id = r.conversation_id), 0),
         r.id, 'provider_response', v_text, encode(sha256(convert_to(v_text, 'UTF8')), 'hex')
  RETURNING m.id INTO v_id;
  UPDATE assistant.request q SET state = 'completed', finished_at = now() WHERE q.id = r.id;
  PERFORM assistant.close_ledger(r.id, true, p_actual_micro);
  RETURN QUERY SELECT 'completed'::text, true, v_id;
END
$$;

-- sent -> provider_failed, settled at the reported cost, else the reservation.
-- The reason is the closed one of the contract; late after outcome_unknown it
-- is dropped as a late response is (R7).
CREATE FUNCTION assistant.fail_request(p_request_id uuid, p_reason text, p_actual_micro bigint)
RETURNS TABLE (state text, accepted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
BEGIN
  IF p_reason IS DISTINCT FROM 'provider_failed' OR p_actual_micro < 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF r.state IN ('outcome_unknown', 'settled') THEN
    RETURN QUERY SELECT r.state, false;
    RETURN;
  END IF;
  IF r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE assistant.request q SET state = 'provider_failed', reason = 'provider_failed', finished_at = now()
   WHERE q.id = r.id;
  PERFORM assistant.close_ledger(r.id, true, p_actual_micro);
  RETURN QUERY SELECT 'provider_failed'::text, true;
END
$$;

-- sent -> outcome_unknown; the reservation stays until the worker settles it.
-- Asked again, it answers the same.
CREATE FUNCTION assistant.mark_outcome_unknown(p_request_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
BEGIN
  IF r.state = 'outcome_unknown' THEN
    RETURN r.state;
  END IF;
  IF r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE assistant.request q SET state = 'outcome_unknown' WHERE q.id = r.id;
  RETURN 'outcome_unknown';
END
$$;

-- The worker, with only the request id (M10): a stale reservation is
-- rejected and released; a stale sent request becomes outcome_unknown; an
-- outcome_unknown is settled at the reservation (no query of the actual cost
-- until OA-1). Each step happens once, so a second run changes nothing.
CREATE FUNCTION assistant.sweep_and_settle(p_request_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r assistant.request;
BEGIN
  SELECT * INTO r FROM assistant.request q WHERE q.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF r.state = 'reserved' AND r.requested_at <= now() - assistant.stale_reserved_after() THEN
    UPDATE assistant.request q SET state = 'rejected', reason = 'request_outcome_unknown', finished_at = now()
     WHERE q.id = r.id;
    PERFORM assistant.close_ledger(r.id, false, NULL);
    RETURN 'rejected';
  END IF;
  IF r.state = 'sent' AND r.sent_at <= now() - assistant.stale_sent_after() THEN
    UPDATE assistant.request q SET state = 'outcome_unknown' WHERE q.id = r.id;
    r.state := 'outcome_unknown';
  END IF;
  IF r.state = 'outcome_unknown' THEN
    UPDATE assistant.request q SET state = 'settled', finished_at = now() WHERE q.id = r.id;
    PERFORM assistant.close_ledger(r.id, true, NULL);
    RETURN 'settled';
  END IF;
  RETURN r.state;
END
$$;

-- The owning student reads the conversation by seq, every message with the
-- state of its request (a paragraph stays when its request ends without a
-- response). Nobody else, not even the teacher, until M9.5 (G1, G2).
CREATE FUNCTION assistant.read_conversation(p_conversation_id uuid)
RETURNS TABLE (seq integer, message_id uuid, request_id uuid, role text, content text, content_sha256 text,
               created_at timestamptz, request_state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT EXISTS (SELECT 1 FROM assistant.conversation c
                  WHERE c.id = p_conversation_id AND c.institution_id = actor.institution_id
                    AND c.student_id = actor.user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT m.seq, m.id, m.request_id, m.role, m.content, m.content_sha256, m.created_at, q.state
      FROM assistant.message m JOIN assistant.request q ON q.id = m.request_id
     WHERE m.conversation_id = p_conversation_id
     ORDER BY m.seq;
END
$$;

-- Writes the next version of a scope and its trail row in one statement (M6).
-- p_expected is the version the caller saw as the latest (0 for none).
CREATE FUNCTION assistant.write_config_version(
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

-- The latest version of a scope, read under the scope's lock.
CREATE FUNCTION assistant.latest_config(p_institution_id uuid) RETURNS assistant.cost_config_version
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v assistant.cost_config_version;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'assistant.cost_config:' || coalesce(p_institution_id::text, ''), 0));
  SELECT * INTO v FROM assistant.cost_config_version c
   WHERE c.institution_id IS NOT DISTINCT FROM p_institution_id ORDER BY c.version_no DESC LIMIT 1;
  RETURN v;
END
$$;

-- A confirmed administrator publishes the student limits and the reservation
-- of the own institution (D-270 O11); the cap and its period stay as the
-- operator set them. A student limit above the cap is refused with
-- limit_above_cap and nothing is written; the check of a request still takes
-- the smaller of the two (T2). NULL turns a limit, and so the assistant, off.
-- A retry of the same publication returns its version and writes nothing.
CREATE FUNCTION assistant.publish_cost_config(
  p_expected_version integer, p_student_day_micro bigint, p_student_assignment_day_micro bigint,
  p_reserve_micro bigint
) RETURNS TABLE (outcome text, version_no integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
  v assistant.cost_config_version;
  v_current integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_student_day_micro < 0
     OR p_student_assignment_day_micro < 0 OR p_reserve_micro <= 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v := assistant.latest_config(actor.institution_id);
  v_current := coalesce(v.version_no, 0);
  IF p_expected_version <> v_current THEN
    IF p_expected_version = v_current - 1 AND v.published_by = actor.user_id
       AND v.student_day_micro IS NOT DISTINCT FROM p_student_day_micro
       AND v.student_assignment_day_micro IS NOT DISTINCT FROM p_student_assignment_day_micro
       AND v.reserve_micro IS NOT DISTINCT FROM p_reserve_micro THEN
      RETURN QUERY SELECT 'published'::text, v_current;
      RETURN;
    END IF;
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  IF p_student_day_micro > v.cap_micro OR p_student_assignment_day_micro > v.cap_micro THEN
    RETURN QUERY SELECT 'limit_above_cap'::text, v_current;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'published'::text, assistant.write_config_version(
    actor.institution_id, v_current, v.cap_micro, coalesce(v.cap_period, 'day'), p_student_day_micro,
    p_student_assignment_day_micro, p_reserve_micro, actor.user_id, NULL);
END
$$;

-- The operator procedure (no application role may run it, as
-- appoint_institution_admin): the cap and its period of the service
-- (p_institution_id NULL) or of one institution, on a written request. The
-- student limits of an institution stay as its administrator set them; a cap
-- below them is allowed, the check takes the smaller (T2). Runs with the
-- rights of its caller.
CREATE FUNCTION assistant.publish_cost_cap(
  p_institution_id uuid, p_expected_version integer, p_cap_micro bigint, p_cap_period text, p_request_ref text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v assistant.cost_config_version;
  v_current integer;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_cap_micro < 0
     OR p_cap_period IS NULL OR p_cap_period NOT IN ('day', 'month')
     OR p_request_ref IS NULL OR p_request_ref <> pg_catalog.btrim(p_request_ref)
     OR NOT coalesce(institution.is_plain_label(p_request_ref), false)
     OR (p_institution_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM identity.institution i WHERE i.id = p_institution_id)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v := assistant.latest_config(p_institution_id);
  v_current := coalesce(v.version_no, 0);
  IF p_expected_version <> v_current THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  RETURN assistant.write_config_version(p_institution_id, v_current, p_cap_micro, p_cap_period,
    v.student_day_micro, v.student_assignment_day_micro, v.reserve_micro, NULL, p_request_ref);
END
$$;

REVOKE ALL ON FUNCTION
  assistant.check_config_event(),
  assistant.check_config_version_event(),
  assistant.stale_reserved_after(),
  assistant.stale_sent_after(),
  assistant.max_paragraph_code_points(),
  assistant.budget_day(timestamptz),
  assistant.period_start(date, text),
  assistant.is_paragraph(text),
  assistant.request_sha256(uuid, uuid, integer, text, text),
  assistant.policy_allows(uuid, integer, integer, text),
  assistant.move_counters(uuid, bigint),
  assistant.close_ledger(uuid, boolean, bigint),
  assistant.own_request(uuid),
  assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text),
  assistant.mark_sent(uuid),
  assistant.complete_request(uuid, text, bigint),
  assistant.fail_request(uuid, text, bigint),
  assistant.mark_outcome_unknown(uuid),
  assistant.sweep_and_settle(uuid),
  assistant.read_conversation(uuid),
  assistant.write_config_version(uuid, integer, bigint, text, bigint, bigint, bigint, uuid, text),
  assistant.latest_config(uuid),
  assistant.publish_cost_config(integer, bigint, bigint, bigint),
  assistant.publish_cost_cap(uuid, integer, bigint, text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text),
  assistant.mark_sent(uuid),
  assistant.complete_request(uuid, text, bigint),
  assistant.fail_request(uuid, text, bigint),
  assistant.mark_outcome_unknown(uuid),
  assistant.read_conversation(uuid),
  assistant.publish_cost_config(integer, bigint, bigint, bigint)
TO ductus_app;
GRANT EXECUTE ON FUNCTION assistant.sweep_and_settle(uuid) TO ductus_worker;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.publish_cost_cap(uuid, integer, bigint, text, text);
DROP FUNCTION assistant.publish_cost_config(integer, bigint, bigint, bigint);
DROP FUNCTION assistant.latest_config(uuid);
DROP FUNCTION assistant.write_config_version(uuid, integer, bigint, text, bigint, bigint, bigint, uuid, text);
DROP FUNCTION assistant.read_conversation(uuid);
DROP FUNCTION assistant.sweep_and_settle(uuid);
DROP FUNCTION assistant.mark_outcome_unknown(uuid);
DROP FUNCTION assistant.fail_request(uuid, text, bigint);
DROP FUNCTION assistant.complete_request(uuid, text, bigint);
DROP FUNCTION assistant.mark_sent(uuid);
DROP FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text);
DROP FUNCTION assistant.own_request(uuid);
DROP FUNCTION assistant.close_ledger(uuid, boolean, bigint);
DROP FUNCTION assistant.move_counters(uuid, bigint);
DROP FUNCTION assistant.policy_allows(uuid, integer, integer, text);
DROP FUNCTION assistant.request_sha256(uuid, uuid, integer, text, text);
DROP FUNCTION assistant.is_paragraph(text);
DROP FUNCTION assistant.period_start(date, text);
DROP FUNCTION assistant.budget_day(timestamptz);
DROP FUNCTION assistant.max_paragraph_code_points();
DROP FUNCTION assistant.stale_sent_after();
DROP FUNCTION assistant.stale_reserved_after();
DROP TRIGGER cost_config_version_has_event ON assistant.cost_config_version;
DROP FUNCTION assistant.check_config_version_event();
DROP TABLE audit.assistant_cost_config_event;
DROP FUNCTION assistant.check_config_event();
ALTER TABLE assistant.cost_config_version DROP CONSTRAINT cost_config_version_id_institution_key;
ALTER TABLE assistant.cost_config_version ALTER COLUMN published_by SET NOT NULL;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
REVOKE USAGE ON SCHEMA assistant FROM ductus_worker;
