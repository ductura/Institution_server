-- migrate:up
-- SRV-1202 (Val 12 / M9.0-S2, Ductus#2051): step 2 of the contract
-- Ductus docs/contracts/ai-request-v1.md (DAN-401; plan of attack Ductus#1662).
-- The schema assistant: the private conversation of a student with the
-- assistant, its requests, the cost ledger, the budget counters and the
-- versioned cost configuration. Tables, checks, RLS and triggers only: no RPC
-- here, every write comes with the RPCs of SRV-1203.
--
--   assistant.conversation         L1: one student, one assignment; never deleted (G7)
--   assistant.message              L1 + L2 content: append-only (M7, G4)
--   assistant.request              L1: no paragraph, response or amount
--   assistant.cost_ledger          L3: one row per request; settled and released rows frozen (M7)
--   assistant.budget_counter       L3: derived from the ledger
--   assistant.cost_config_version  L4: append-only, one version line per scope
--
-- Classes L1 to L4 are those of Ductus#1662; L5 (a provider secret) does not
-- appear: there is no table of provider keys (OA-1, M8). Amounts are bigint
-- micro-euros (1 EUR = 1 000 000); no amount is written here (OA-2).
--
-- Access (contract, "Matrica pristupa"; reading only, writing only through
-- the RPCs of SRV-1203):
--   * ductus_identity owns every table and reaches it through its own policy;
--   * ductus_app reads, through RLS, the own conversations, their messages and
--     the own requests of the session's student, nothing else; it holds no
--     INSERT, UPDATE, DELETE or TRUNCATE on any table (M1, M2);
--   * the worker reads nothing directly: the state and ids of a request come
--     to it, and it settles, through the RPC sweep_and_settle (SRV-1203; the
--     job carries only the request id, M10), so no policy here passes every
--     row for a role that is not the owner (001, 012);
--   * the ledger, the counters and the configuration have no reader yet: the
--     student's own spend, the sums for the administrator and the operator and
--     the configuration are read through RPCs of a later step.
-- Another student's row and a row that does not exist read the same: none (M4, M5).
--
-- Two departures from the contract's columns, for the key chain of this
-- database (033: every table carries institution_id and every foreign key to
-- a keyed table pairs it): message and budget_counter carry institution_id
-- too (NULL only for the counter of the whole service), and the assignment
-- version is (assignment_id, assignment_version) with the institution, as in
-- evidence.submission: institution.assignment_version has no uuid of its own.
--
-- Triggers refuse, for every role (ZD409, no input in the message):
--   * message: UPDATE, DELETE, TRUNCATE;
--   * conversation: UPDATE, DELETE, TRUNCATE;
--   * request: DELETE, TRUNCATE, an UPDATE outside the transition table of the
--     contract ("Stanja"), and any change of a column other than state,
--     reason, sent_at and finished_at (R1);
--   * cost_ledger: DELETE, TRUNCATE, any change of a settled or released row,
--     and any change of a reserved row but to settled or released;
--   * cost_config_version: UPDATE, DELETE, TRUNCATE; a version that is not the
--     next one of its scope.
-- Known limit, as for settings.change: the owner, and ductus_migrator through
-- SET ROLE, can still drop or disable a trigger with DDL. Neither is an
-- application role and no function runs DDL for them.
SET LOCAL ROLE ductus_migrator;
CREATE SCHEMA assistant;
GRANT USAGE ON SCHEMA assistant TO ductus_app, ductus_identity;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE assistant.conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  student_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id),
  UNIQUE (id, institution_id, student_id, assignment_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX conversation_student_idx ON assistant.conversation (student_id, institution_id, assignment_id);

CREATE TABLE assistant.request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  student_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  assignment_version integer NOT NULL,
  conversation_id uuid,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  purpose_catalog_version integer NOT NULL CHECK (purpose_catalog_version IN (1, 2)),
  purpose_key text NOT NULL CHECK (purpose_key ~ '^[a-z][a-z_]{0,63}$'),
  provider_id text CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  model_id text CHECK (model_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  config_version text CHECK (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  state text NOT NULL CHECK (state IN ('rejected', 'reserved', 'sent', 'completed', 'provider_failed',
                                       'outcome_unknown', 'settled')),
  reason text CHECK (reason IN ('invalid_request', 'invalid_idempotency_key', 'idempotency_conflict', 'forbidden',
                                'ai_disabled', 'purpose_not_allowed', 'budget_exceeded', 'in_progress',
                                'request_outcome_unknown', 'provider_failed', 'completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  finished_at timestamptz,
  UNIQUE (student_id, idempotency_key),
  UNIQUE (id, conversation_id, institution_id),
  UNIQUE (id, institution_id, student_id, assignment_id),
  -- A reason only for a refusal or a provider failure, and always there.
  CHECK ((reason IS NOT NULL) = (state IN ('rejected', 'provider_failed'))),
  -- Without a conversation, a provider, a model or a configuration only when refused.
  CHECK (state = 'rejected' OR (conversation_id IS NOT NULL AND provider_id IS NOT NULL
                                AND model_id IS NOT NULL AND config_version IS NOT NULL)),
  CHECK ((sent_at IS NOT NULL) = (state IN ('sent', 'completed', 'provider_failed', 'outcome_unknown', 'settled'))),
  CHECK ((finished_at IS NOT NULL) = (state IN ('rejected', 'completed', 'provider_failed', 'settled'))),
  CHECK (sent_at >= requested_at),
  CHECK (finished_at >= coalesce(sent_at, requested_at)),
  FOREIGN KEY (conversation_id, institution_id, student_id, assignment_id)
    REFERENCES assistant.conversation (id, institution_id, student_id, assignment_id),
  FOREIGN KEY (assignment_id, assignment_version, institution_id)
    REFERENCES institution.assignment_version (assignment_id, version_no, institution_id),
  FOREIGN KEY (assignment_id, institution_id) REFERENCES institution.assignment (id, institution_id),
  FOREIGN KEY (student_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX request_conversation_idx ON assistant.request (conversation_id);
CREATE INDEX request_open_idx ON assistant.request (state, requested_at)
  WHERE state IN ('reserved', 'sent', 'outcome_unknown');

CREATE TABLE assistant.message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  request_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('student_paragraph', 'provider_response')),
  -- The outer bound; the route's own bound of a paragraph (Z9) is narrower.
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 40000 AND content IS NFC NORMALIZED),
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  -- One paragraph and at most one response per request (R4).
  UNIQUE (request_id, role),
  CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  FOREIGN KEY (conversation_id, institution_id) REFERENCES assistant.conversation (id, institution_id),
  -- The message belongs to the conversation of its request.
  FOREIGN KEY (request_id, conversation_id, institution_id)
    REFERENCES assistant.request (id, conversation_id, institution_id)
);

CREATE TABLE assistant.cost_ledger (
  request_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  student_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  budget_day date NOT NULL,
  institution_cap_period_start date NOT NULL,
  service_cap_period_start date NOT NULL,
  reserved_micro bigint NOT NULL CHECK (reserved_micro > 0),
  actual_micro bigint CHECK (actual_micro >= 0),
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- reserved: open; settled: an actual amount; released: none, the reservation is given back.
  CHECK ((settled_at IS NULL) = (state = 'reserved')),
  CHECK ((actual_micro IS NOT NULL) = (state = 'settled')),
  CHECK (settled_at >= reserved_at),
  CHECK (institution_cap_period_start <= budget_day AND service_cap_period_start <= budget_day),
  FOREIGN KEY (request_id, institution_id, student_id, assignment_id)
    REFERENCES assistant.request (id, institution_id, student_id, assignment_id)
);

CREATE TABLE assistant.budget_counter (
  scope text NOT NULL CHECK (scope IN ('student_assignment_day', 'student_day', 'institution_cap', 'service_cap')),
  -- The ids of the scope joined with ':': institution; institution:student;
  -- institution:student:assignment; empty for the whole service.
  scope_key text NOT NULL,
  -- NULL only for the whole service; else the first id of scope_key.
  institution_id uuid REFERENCES identity.institution (id),
  period_start date NOT NULL,
  used_micro bigint NOT NULL DEFAULT 0 CHECK (used_micro >= 0),
  PRIMARY KEY (scope, scope_key, period_start),
  CHECK (scope_key ~ CASE scope
    WHEN 'service_cap' THEN '^$'
    WHEN 'institution_cap' THEN '^[0-9a-f-]{36}$'
    WHEN 'student_day' THEN '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
    ELSE '^[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f-]{36}$' END),
  CHECK (CASE WHEN scope = 'service_cap' THEN institution_id IS NULL
              ELSE coalesce(split_part(scope_key, ':', 1) = institution_id::text, false) END)
);

CREATE TABLE assistant.cost_config_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: the whole service.
  institution_id uuid REFERENCES identity.institution (id),
  version_no integer NOT NULL CHECK (version_no >= 1),
  cap_micro bigint CHECK (cap_micro >= 0),
  cap_period text NOT NULL CHECK (cap_period IN ('day', 'month')),
  student_day_micro bigint CHECK (student_day_micro >= 0),
  student_assignment_day_micro bigint CHECK (student_assignment_day_micro >= 0),
  reserve_micro bigint CHECK (reserve_micro > 0),
  -- An account of the institution for its own scope; the operator, who
  -- publishes the service scope, has no account link yet (owner action V-7).
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (institution_id, version_no),
  -- The student limits and the reservation belong to an institution only.
  CHECK (institution_id IS NOT NULL
         OR (student_day_micro IS NULL AND student_assignment_day_micro IS NULL AND reserve_micro IS NULL)),
  FOREIGN KEY (published_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE assistant.conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.conversation FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.message ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.message FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.request ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.request FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.cost_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.budget_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.budget_counter FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.cost_config_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.cost_config_version FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_owner ON assistant.conversation TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY message_owner ON assistant.message TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY request_owner ON assistant.request TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY cost_ledger_owner ON assistant.cost_ledger TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY budget_counter_owner ON assistant.budget_counter TO ductus_identity USING (true) WITH CHECK (true);
CREATE POLICY cost_config_version_owner ON assistant.cost_config_version TO ductus_identity
  USING (true) WITH CHECK (true);

-- The student of the session reads the own conversations, their messages and
-- the own requests; the relation is ownership of the row (C-23).
CREATE POLICY conversation_student_read ON assistant.conversation FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id()) AND student_id = (SELECT app.current_user_id()));
CREATE POLICY message_student_read ON assistant.message FOR SELECT TO ductus_app
  USING (conversation_id IN (SELECT c.id FROM assistant.conversation c
                              WHERE c.institution_id = (SELECT app.current_institution_id())
                                AND c.student_id = (SELECT app.current_user_id())));
CREATE POLICY request_student_read ON assistant.request FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id()) AND student_id = (SELECT app.current_user_id()));

GRANT SELECT ON assistant.conversation, assistant.message, assistant.request TO ductus_app;

-- Triggers. One error for every refusal, without the row.
CREATE FUNCTION assistant.refuse_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'assistant: % refused on %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'ZD409';
END
$$;

CREATE TRIGGER message_append_only BEFORE UPDATE OR DELETE ON assistant.message
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER message_no_truncate BEFORE TRUNCATE ON assistant.message
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER conversation_no_change BEFORE UPDATE OR DELETE ON assistant.conversation
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER conversation_no_truncate BEFORE TRUNCATE ON assistant.conversation
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER request_no_delete BEFORE DELETE ON assistant.request
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER request_no_truncate BEFORE TRUNCATE ON assistant.request
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER cost_ledger_no_delete BEFORE DELETE ON assistant.cost_ledger
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER cost_ledger_no_truncate BEFORE TRUNCATE ON assistant.cost_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER cost_config_version_append_only BEFORE UPDATE OR DELETE ON assistant.cost_config_version
  FOR EACH ROW EXECUTE FUNCTION assistant.refuse_change();
CREATE TRIGGER cost_config_version_no_truncate BEFORE TRUNCATE ON assistant.cost_config_version
  FOR EACH STATEMENT EXECUTE FUNCTION assistant.refuse_change();

-- A request moves only along the contract's transition table, and only its
-- state, reason and times change.
CREATE FUNCTION assistant.guard_request_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF (NEW.id, NEW.institution_id, NEW.student_id, NEW.assignment_id, NEW.assignment_version, NEW.conversation_id,
      NEW.idempotency_key, NEW.request_sha256, NEW.purpose_catalog_version, NEW.purpose_key, NEW.provider_id,
      NEW.model_id, NEW.config_version, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.institution_id, OLD.student_id, OLD.assignment_id, OLD.assignment_version, OLD.conversation_id,
      OLD.idempotency_key, OLD.request_sha256, OLD.purpose_catalog_version, OLD.purpose_key, OLD.provider_id,
      OLD.model_id, OLD.config_version, OLD.requested_at)
     OR (OLD.state, NEW.state) NOT IN (('reserved', 'sent'), ('reserved', 'rejected'), ('sent', 'completed'),
                                       ('sent', 'provider_failed'), ('sent', 'outcome_unknown'),
                                       ('outcome_unknown', 'settled'))
     OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
    RAISE EXCEPTION 'assistant: request transition refused' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER request_transition BEFORE UPDATE ON assistant.request
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_request_transition();

-- A reserved row is settled or released once; then it is frozen (M7). The
-- keys of the counters it moves never change (T6).
CREATE FUNCTION assistant.guard_ledger_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.state <> 'reserved' OR NEW.state NOT IN ('settled', 'released')
     OR (NEW.request_id, NEW.institution_id, NEW.student_id, NEW.assignment_id, NEW.budget_day,
         NEW.institution_cap_period_start, NEW.service_cap_period_start, NEW.reserved_micro, NEW.reserved_at)
        IS DISTINCT FROM
        (OLD.request_id, OLD.institution_id, OLD.student_id, OLD.assignment_id, OLD.budget_day,
         OLD.institution_cap_period_start, OLD.service_cap_period_start, OLD.reserved_micro, OLD.reserved_at) THEN
    RAISE EXCEPTION 'assistant: cost_ledger change refused' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_ledger_settle_once BEFORE UPDATE ON assistant.cost_ledger
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_ledger_change();

-- Versions of one scope are 1, 2, 3 ... without a gap; two concurrent
-- publications of the same number meet the unique key.
CREATE FUNCTION assistant.guard_config_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.version_no <> 1 + coalesce((SELECT max(v.version_no) FROM assistant.cost_config_version v
                                      WHERE v.institution_id IS NOT DISTINCT FROM NEW.institution_id), 0) THEN
    RAISE EXCEPTION 'assistant: cost_config_version out of order' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_config_version_next BEFORE INSERT ON assistant.cost_config_version
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_config_version();

REVOKE ALL ON FUNCTION
  assistant.refuse_change(),
  assistant.guard_request_transition(),
  assistant.guard_ledger_change(),
  assistant.guard_config_version()
FROM PUBLIC;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA assistant FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA assistant TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP TABLE assistant.cost_config_version, assistant.budget_counter, assistant.cost_ledger, assistant.message,
  assistant.request, assistant.conversation;
DROP FUNCTION assistant.guard_config_version(), assistant.guard_ledger_change(),
  assistant.guard_request_transition(), assistant.refuse_change();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
DROP SCHEMA assistant;
