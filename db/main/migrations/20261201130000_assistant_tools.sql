-- migrate:up
-- SRV-1207 (M9.0-S3, Ductus#2052): step 3 of the contract Ductus
-- docs/contracts/ai-tools-v1.md (C-37, DAN-401; plan of attack Ductus#1664),
-- sections "Dopušteni skup alata", "Trošak petlje alata", "RPC-ovi", "Ishodi"
-- and "Matrica pristupa". The tools of the assistant in the database:
--
--   assistant.assignment_tool_setting  L4: the teacher's tools per assignment, append-only versions
--   assistant.tool_step                L1: one row per tool step, hashes only (OC-5)
--   assistant.tool_loop_reservation    L1: the loop reserved with the request; frozen
--   audit.assistant_tool_setting_event the trail of every setting version (#1662 M6)
--
--   assistant.set_assignment_tools     a teacher of the assignment's course: a new version
--   assistant.read_assignment_tools    a teacher or a student of the course: the version in force
--   assistant.begin_tool_step          the AI route (the student's session): one step, outcome by the contract's order
--   assistant.finish_tool_step         the AI route: allowed -> done or failed
--   assistant.begin_request            replaced: takes the tools the server permits and reserves the loop
--   assistant.fail_request             replaced: also tool_step_limit, response_too_large, request_revoked
--
-- The allowed set of a step is CODE_TOOLS ∩ switch.tools ∩ the teacher's
-- setting ∩ ready, plus the policy. The institution switch and the ready
-- tools (search: a non-empty destination list) are not in this database: they
-- live in the versioned faculty setting config/faculties/<faculty>.json
-- (owner decision OC-1; for the pilot every flag is off and the destination
-- list is empty, OC-2). The route hands their intersection with the code set
-- in as p_offered_tools, and the database can only narrow it: it intersects
-- with the code set, the setting in force at the moment of the call and the
-- policy (S3-D1, S3-Z1). With the pilot's setting p_offered_tools is always
-- empty, so no loop is ever reserved and every step is refused.
--
-- Departures from the contract's columns, for the key chain of this database
-- (033: every table carries institution_id and every foreign key pairs it):
-- each new table carries institution_id, and assistant.request gets a unique
-- key (id, institution_id) for the foreign keys of the step and the loop.
--
-- Errors carry no input: ZD401 no session, ZD403 forbidden (a foreign and a
-- missing assignment or request alike), ZD409 version_conflict
-- (set_assignment_tools) or a step out of order, without a loop or in a
-- state that takes none, ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- Named constants, as server/domain/assistant: CODE_TOOLS and TOOL_STEP_MAX.
CREATE FUNCTION assistant.code_tools() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT ARRAY['web_search']::text[] $$;
CREATE FUNCTION assistant.tool_step_max() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 3 $$;

-- A tool list: one-dimensional, no NULL, no duplicate, every name exactly a
-- member of the code set (byte for byte, S3-D3).
CREATE FUNCTION assistant.is_tool_list(p_tools text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(
    (cardinality(p_tools) = 0 OR array_ndims(p_tools) = 1)
    AND array_position(p_tools, NULL) IS NULL
    AND p_tools <@ assistant.code_tools()
    AND cardinality(p_tools) = (SELECT count(DISTINCT t) FROM unnest(p_tools) AS t),
    false)
$$;

-- The members of the code set in both lists, in code order.
CREATE FUNCTION assistant.intersect_tools(p_a text[], p_b text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(array_agg(c.name ORDER BY c.n), '{}'::text[])
    FROM unnest(assistant.code_tools()) WITH ORDINALITY AS c (name, n)
   WHERE c.name = ANY (coalesce(p_a, '{}'::text[])) AND c.name = ANY (coalesce(p_b, '{}'::text[]))
$$;

-- squawk-ignore disallowed-unique-constraint
ALTER TABLE assistant.request ADD CONSTRAINT request_id_institution_key UNIQUE (id, institution_id);
-- The three codes of ai-tools-v1 ("Ishodi") as reasons of provider_failed.
ALTER TABLE assistant.request DROP CONSTRAINT request_reason_check;
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE assistant.request ADD CONSTRAINT request_reason_check CHECK (reason IN (
  'invalid_request', 'invalid_idempotency_key', 'idempotency_conflict', 'forbidden', 'ai_disabled',
  'purpose_not_allowed', 'budget_exceeded', 'in_progress', 'request_outcome_unknown', 'provider_failed', 'completed',
  'tool_step_limit', 'response_too_large', 'request_revoked'));

CREATE TABLE assistant.assignment_tool_setting (
  assignment_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  tools text[] NOT NULL CHECK (assistant.is_tool_list(tools)),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, version_no),
  UNIQUE (assignment_id, version_no, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (set_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assignment_tool_setting_set_by_idx ON assistant.assignment_tool_setting (set_by, institution_id);

CREATE TABLE assistant.tool_step (
  request_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  step_no integer NOT NULL CHECK (step_no BETWEEN 1 AND assistant.tool_step_max()),
  tool_name text CHECK (tool_name = ANY (assistant.code_tools())),
  requested_name_sha256 text NOT NULL CHECK (requested_name_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied_not_in_set', 'denied_schema', 'denied_revoked',
                                           'failed', 'done')),
  args_sha256 text NOT NULL CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  result_bytes integer CHECK (result_bytes >= 0),
  truncated boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (request_id, step_no),
  -- Only a step that ran has a result; only an allowed step is open.
  CHECK ((result_sha256 IS NOT NULL) = (outcome = 'done')),
  CHECK ((result_bytes IS NOT NULL) = (outcome = 'done')),
  CHECK ((truncated IS NOT NULL) = (outcome = 'done')),
  CHECK ((finished_at IS NULL) = (outcome = 'allowed')),
  CHECK (finished_at >= created_at),
  -- A step runs only for a member of the code set.
  CHECK (outcome NOT IN ('allowed', 'done', 'failed') OR tool_name IS NOT NULL),
  FOREIGN KEY (request_id, institution_id) REFERENCES assistant.request (id, institution_id)
);

CREATE TABLE assistant.tool_loop_reservation (
  request_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  steps_reserved integer NOT NULL CHECK (steps_reserved >= 1),
  tools_reserved text[] NOT NULL CHECK (cardinality(tools_reserved) > 0 AND assistant.is_tool_list(tools_reserved)),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, institution_id) REFERENCES assistant.request (id, institution_id)
);

-- The trail of the setting: one row per version, written by the same RPC
-- call as the version and checked at commit (#1662 M6).
CREATE TABLE audit.assistant_tool_setting_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  version_no integer NOT NULL,
  kind text NOT NULL CHECK (kind = 'set'),
  tools text[] NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (assignment_id, version_no),
  FOREIGN KEY (assignment_id, version_no, institution_id)
    REFERENCES assistant.assignment_tool_setting (assignment_id, version_no, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX assistant_tool_setting_event_actor_idx ON audit.assistant_tool_setting_event (actor_id, institution_id);
CREATE INDEX assistant_tool_setting_event_setting_idx
  ON audit.assistant_tool_setting_event (assignment_id, version_no, institution_id);
CREATE TRIGGER assistant_tool_setting_event_append_only BEFORE UPDATE OR DELETE ON audit.assistant_tool_setting_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER assistant_tool_setting_event_no_truncate BEFORE TRUNCATE ON audit.assistant_tool_setting_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE assistant.assignment_tool_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.assignment_tool_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.tool_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.tool_step FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.tool_loop_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.tool_loop_reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.assistant_tool_setting_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.assistant_tool_setting_event FORCE ROW LEVEL SECURITY;

-- Only the owner reaches the rows; every other role goes through the RPCs
-- (contract, "Matrica pristupa": no direct read or write for anyone).
CREATE POLICY assignment_tool_setting_owner ON assistant.assignment_tool_setting TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY tool_step_owner ON assistant.tool_step TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY tool_loop_reservation_owner ON assistant.tool_loop_reservation TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY assistant_tool_setting_event_owner ON audit.assistant_tool_setting_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- Triggers. The setting and the loop are append-only and frozen; a step only
-- moves allowed -> done or failed, once, and nothing else of it changes.
CREATE TRIGGER assignment_tool_setting_append_only BEFORE UPDATE OR DELETE ON assistant.assignment_tool_setting
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER assignment_tool_setting_no_truncate BEFORE TRUNCATE ON assistant.assignment_tool_setting
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER tool_loop_reservation_frozen BEFORE UPDATE OR DELETE ON assistant.tool_loop_reservation
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER tool_loop_reservation_no_truncate BEFORE TRUNCATE ON assistant.tool_loop_reservation
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER tool_step_no_delete BEFORE DELETE ON assistant.tool_step
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER tool_step_no_truncate BEFORE TRUNCATE ON assistant.tool_step
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();

CREATE FUNCTION assistant.guard_tool_step_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.outcome <> 'allowed' OR NEW.outcome NOT IN ('done', 'failed')
     OR (NEW.request_id, NEW.institution_id, NEW.step_no, NEW.tool_name, NEW.requested_name_sha256, NEW.args_sha256,
         NEW.created_at)
        IS DISTINCT FROM
        (OLD.request_id, OLD.institution_id, OLD.step_no, OLD.tool_name, OLD.requested_name_sha256, OLD.args_sha256,
         OLD.created_at) THEN
    RAISE EXCEPTION 'assistant: tool_step change refused' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tool_step_finish_once BEFORE UPDATE ON assistant.tool_step
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_tool_step_change();

-- Versions of one assignment are 1, 2, 3 ... without a gap.
CREATE FUNCTION assistant.guard_tool_setting_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.version_no <> 1 + coalesce((SELECT max(s.version_no) FROM assistant.assignment_tool_setting s
                                      WHERE s.assignment_id = NEW.assignment_id), 0) THEN
    RAISE EXCEPTION 'assistant: assignment_tool_setting out of order' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assignment_tool_setting_next BEFORE INSERT ON assistant.assignment_tool_setting
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_tool_setting_version();

-- The event names its own version: same tools and the same teacher.
CREATE FUNCTION assistant.check_tool_setting_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assistant.assignment_tool_setting s
                  WHERE s.assignment_id = NEW.assignment_id AND s.version_no = NEW.version_no
                    AND s.institution_id = NEW.institution_id AND s.tools = NEW.tools AND s.set_by = NEW.actor_id) THEN
    RAISE EXCEPTION 'assistant: tool setting event without its version' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assistant_tool_setting_event_names_version BEFORE INSERT ON audit.assistant_tool_setting_event
  FOR EACH ROW EXECUTE FUNCTION assistant.check_tool_setting_event();

-- No version without its trail row, checked at commit (M6).
CREATE FUNCTION assistant.check_tool_setting_has_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.assistant_tool_setting_event e
                  WHERE e.assignment_id = NEW.assignment_id AND e.version_no = NEW.version_no) THEN
    RAISE EXCEPTION 'assistant: tool setting without audit row' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER assignment_tool_setting_has_event AFTER INSERT ON assistant.assignment_tool_setting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assistant.check_tool_setting_has_event();

-- The teacher's tools of an assignment in force: the latest version, empty
-- without one (D-64, §4.5: turned on per assignment).
CREATE FUNCTION assistant.latest_tools(p_assignment_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.tools FROM assistant.assignment_tool_setting s
                    WHERE s.assignment_id = p_assignment_id ORDER BY s.version_no DESC LIMIT 1), '{}'::text[])
$$;

-- The allowed set for a step of r at this moment: empty when the relation or
-- the policy is gone (I3), else the code set ∩ what the server permits ∩ the
-- setting in force, read now and not remembered from the start (S3-Z1).
CREATE FUNCTION assistant.allowed_tools_now(r assistant.request, p_offered text[]) RETURNS text[]
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN institution.actor_assignment_role(r.assignment_id) IS DISTINCT FROM 'student'
      OR NOT assistant.policy_allows(r.assignment_id,
                                     (SELECT a.current_version FROM institution.assignment a
                                       WHERE a.id = r.assignment_id),
                                     r.purpose_catalog_version, r.purpose_key)
      THEN '{}'::text[]
    ELSE assistant.intersect_tools(p_offered, assistant.latest_tools(r.assignment_id))
  END
$$;

CREATE OR REPLACE FUNCTION assistant.fail_request(p_request_id uuid, p_reason text, p_actual_micro bigint)
RETURNS TABLE (state text, accepted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('provider_failed', 'tool_step_limit', 'response_too_large', 'request_revoked')
     OR p_actual_micro < 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF r.state IN ('outcome_unknown', 'settled') THEN
    RETURN QUERY SELECT r.state, false;
    RETURN;
  END IF;
  IF r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE assistant.request q SET state = 'provider_failed', reason = p_reason, finished_at = now()
   WHERE q.id = r.id;
  PERFORM assistant.close_ledger(r.id, true, p_actual_micro);
  RETURN QUERY SELECT 'provider_failed'::text, true;
END
$$;

DROP FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text);
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

-- A teacher of the course of the assignment sets its tools: a new version
-- from expected_version, and the trail row in the same call (#1662 M6).
CREATE FUNCTION assistant.set_assignment_tools(p_assignment_id uuid, p_expected_version integer, p_tools text[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_current integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_assignment_role(p_assignment_id) IS DISTINCT FROM 'teacher'
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 OR NOT assistant.is_tool_list(p_tools) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'assistant.assignment_tool_setting:' || p_assignment_id::text, 0));
  SELECT coalesce(max(s.version_no), 0) INTO v_current FROM assistant.assignment_tool_setting s
   WHERE s.assignment_id = p_assignment_id;
  IF v_current <> p_expected_version THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO assistant.assignment_tool_setting (assignment_id, institution_id, version_no, tools, set_by)
  VALUES (p_assignment_id, actor.institution_id, v_current + 1, p_tools, actor.user_id);
  INSERT INTO audit.assistant_tool_setting_event (assignment_id, institution_id, version_no, kind, tools, actor_id,
                                                  occurred_at)
  VALUES (p_assignment_id, actor.institution_id, v_current + 1, 'set', p_tools, actor.user_id, now());
  RETURN v_current + 1;
END
$$;

-- The version in force for a teacher of the course or a student of it
-- (PRODUCT §8: the student sees which tools the teacher turned on). Version
-- 0 with no tools when the teacher never set any.
CREATE FUNCTION assistant.read_assignment_tools(p_assignment_id uuid)
RETURNS TABLE (version_no integer, tools text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF institution.actor_assignment_role(p_assignment_id) IS NULL
     OR NOT EXISTS (SELECT 1 FROM institution.assignment a
                     WHERE a.id = p_assignment_id AND a.institution_id = actor.institution_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT coalesce(max(s.version_no), 0), assistant.latest_tools(p_assignment_id)
      FROM assistant.assignment_tool_setting s WHERE s.assignment_id = p_assignment_id;
END
$$;

-- One step of the loop, under the lock of the request row. The outcome by
-- the contract's order, the first that holds: (1) revoked, whatever was
-- asked: the policy or the relation is gone, or a reserved tool left the
-- allowed set; (2) no code tool, or one outside the allowed set; (3) the
-- arguments failed the closed schema; (4) allowed. Every outcome takes its
-- step_no, so the loop stays bounded however the model asks.
CREATE FUNCTION assistant.begin_tool_step(
  p_request_id uuid, p_step_no integer, p_tool_name text, p_requested_name_sha256 text, p_args_sha256 text,
  p_args_valid boolean, p_offered_tools text[]
) RETURNS TABLE (outcome text, tools text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
  l assistant.tool_loop_reservation;
  v_last integer;
  v_allowed text[];
  v_outcome text;
BEGIN
  IF p_step_no IS NULL OR p_args_valid IS NULL
     OR (p_tool_name IS NOT NULL AND NOT (p_tool_name = ANY (assistant.code_tools())))
     OR p_requested_name_sha256 IS NULL OR p_requested_name_sha256 !~ '^[0-9a-f]{64}$'
     OR p_args_sha256 IS NULL OR p_args_sha256 !~ '^[0-9a-f]{64}$'
     OR NOT assistant.is_tool_list(p_offered_tools) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  IF r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  -- A request without a loop has none, also if a tool was turned on since.
  SELECT * INTO l FROM assistant.tool_loop_reservation t WHERE t.request_id = r.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  SELECT coalesce(max(s.step_no), 0) INTO v_last FROM assistant.tool_step s WHERE s.request_id = r.id;
  IF p_step_no <> v_last + 1 OR p_step_no > l.steps_reserved THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  v_allowed := assistant.allowed_tools_now(r, p_offered_tools);
  v_outcome := CASE
    WHEN NOT (l.tools_reserved <@ v_allowed) THEN 'denied_revoked'
    WHEN p_tool_name IS NULL OR NOT (p_tool_name = ANY (v_allowed)) THEN 'denied_not_in_set'
    WHEN NOT p_args_valid THEN 'denied_schema'
    ELSE 'allowed' END;
  INSERT INTO assistant.tool_step (request_id, institution_id, step_no, tool_name, requested_name_sha256, outcome,
                                   args_sha256, finished_at)
  VALUES (r.id, r.institution_id, p_step_no, p_tool_name, p_requested_name_sha256, v_outcome, p_args_sha256,
          CASE WHEN v_outcome = 'allowed' THEN NULL ELSE now() END);
  RETURN QUERY SELECT v_outcome, CASE WHEN v_outcome = 'denied_revoked' THEN '{}'::text[] ELSE v_allowed END;
END
$$;

-- allowed -> done (with the hash and size of the result) or failed; every
-- other move is refused. Only while the request is sent.
CREATE FUNCTION assistant.finish_tool_step(
  p_request_id uuid, p_step_no integer, p_outcome text, p_result_sha256 text, p_result_bytes integer,
  p_truncated boolean
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r assistant.request := assistant.own_request(p_request_id);
  s assistant.tool_step;
BEGIN
  IF p_step_no IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('done', 'failed')
     OR (p_outcome = 'done' AND (p_result_sha256 IS NULL OR p_result_sha256 !~ '^[0-9a-f]{64}$'
                                 OR p_result_bytes IS NULL OR p_result_bytes < 0 OR p_truncated IS NULL)) THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  SELECT * INTO s FROM assistant.tool_step t WHERE t.request_id = r.id AND t.step_no = p_step_no FOR UPDATE;
  IF NOT FOUND OR s.outcome <> 'allowed' OR r.state <> 'sent' THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;
  UPDATE assistant.tool_step t
     SET outcome = p_outcome,
         result_sha256 = CASE WHEN p_outcome = 'done' THEN p_result_sha256 END,
         result_bytes = CASE WHEN p_outcome = 'done' THEN p_result_bytes END,
         truncated = CASE WHEN p_outcome = 'done' THEN p_truncated END,
         finished_at = now()
   WHERE t.request_id = r.id AND t.step_no = p_step_no;
  RETURN p_outcome;
END
$$;

REVOKE ALL ON FUNCTION
  assistant.code_tools(),
  assistant.tool_step_max(),
  assistant.is_tool_list(text[]),
  assistant.intersect_tools(text[], text[]),
  assistant.guard_tool_step_change(),
  assistant.guard_tool_setting_version(),
  assistant.check_tool_setting_event(),
  assistant.check_tool_setting_has_event(),
  assistant.latest_tools(uuid),
  assistant.allowed_tools_now(assistant.request, text[]),
  assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]),
  assistant.set_assignment_tools(uuid, integer, text[]),
  assistant.read_assignment_tools(uuid),
  assistant.begin_tool_step(uuid, integer, text, text, text, boolean, text[]),
  assistant.finish_tool_step(uuid, integer, text, text, integer, boolean)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]),
  assistant.set_assignment_tools(uuid, integer, text[]),
  assistant.read_assignment_tools(uuid),
  assistant.begin_tool_step(uuid, integer, text, text, text, boolean, text[]),
  assistant.finish_tool_step(uuid, integer, text, text, integer, boolean)
TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION assistant.finish_tool_step(uuid, integer, text, text, integer, boolean);
DROP FUNCTION assistant.begin_tool_step(uuid, integer, text, text, text, boolean, text[]);
DROP FUNCTION assistant.read_assignment_tools(uuid);
DROP FUNCTION assistant.set_assignment_tools(uuid, integer, text[]);
DROP FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text, text[]);
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

REVOKE ALL ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.begin_request(uuid, uuid, uuid, integer, text, text, text, text, text)
  TO ductus_app;
CREATE OR REPLACE FUNCTION assistant.fail_request(p_request_id uuid, p_reason text, p_actual_micro bigint)
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

DROP FUNCTION assistant.allowed_tools_now(assistant.request, text[]);
DROP FUNCTION assistant.latest_tools(uuid);
DROP TABLE audit.assistant_tool_setting_event, assistant.tool_loop_reservation, assistant.tool_step,
  assistant.assignment_tool_setting;
DROP FUNCTION assistant.check_tool_setting_has_event(), assistant.check_tool_setting_event(),
  assistant.guard_tool_setting_version(), assistant.guard_tool_step_change();
ALTER TABLE assistant.request DROP CONSTRAINT request_reason_check;
ALTER TABLE assistant.request ADD CONSTRAINT request_reason_check CHECK (reason IN (
  'invalid_request', 'invalid_idempotency_key', 'idempotency_conflict', 'forbidden', 'ai_disabled',
  'purpose_not_allowed', 'budget_exceeded', 'in_progress', 'request_outcome_unknown', 'provider_failed', 'completed'));
ALTER TABLE assistant.request DROP CONSTRAINT request_id_institution_key;
DROP FUNCTION assistant.intersect_tools(text[], text[]), assistant.is_tool_list(text[]),
  assistant.tool_step_max(), assistant.code_tools();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;
