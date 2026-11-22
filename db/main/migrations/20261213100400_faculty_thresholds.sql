-- migrate:up
-- SRV-1111 (Ductus#2052; P-1, rule 12): the thresholds of a faculty per kind of
-- origin, and the comparison of a work with them.
--
--   institution.origin_threshold   one row per (institution, kind of origin):
--                                  the threshold in percent (0 to 100, one
--                                  decimal) and its strictness, 'hard' or
--                                  'soft'. There are NO defaults: a faculty that
--                                  has written nothing has no row, and nothing
--                                  is compared (the demo data may write
--                                  pasted_unknown 15 and assistant_inserted 10).
--   audit.origin_threshold_event   append-only trail of every change ('set' and
--                                  'cleared') with the administrator and the time.
--
-- The kinds are the closed list of SRV-0910. Only a confirmed, unrevoked
-- administrator of the institution reads or writes the thresholds; the
-- institution and the author come from the session, never from the caller.
-- A write sets or clears one kind, takes the institution's advisory lock so
-- two writes run one at a time, and records one event; a write that changes
-- nothing records nothing.
--
-- The comparison answers per kind that HAS a threshold, and only that:
--   in_line      the share of the kind is at or below the threshold;
--   for_review   above a 'soft' threshold;
--   exceeded     above a 'hard' threshold.
-- It returns no share, no percent and no ranking. It reads the composition of
-- SRV-0910 and is answered to the owner of the work and to its readers alike
-- (C-23: the same access as the composition). It is a statement of conformity
-- with the rules of the faculty, never an assessment of the student, and it
-- blocks nothing.
--
-- Errors carry no input: ZD401 no session, ZD403 not allowed (also every refusal
-- to read a work), ZD422 invalid input.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit, institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE institution.origin_threshold (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  kind text NOT NULL CHECK (kind IN ('typed', 'assistant_inserted', 'assistant_match',
                                     'imported_file', 'pasted_known', 'pasted_unknown')),
  threshold_percent numeric(4, 1) NOT NULL CHECK (threshold_percent >= 0 AND threshold_percent <= 100),
  strictness text NOT NULL CHECK (strictness IN ('hard', 'soft')),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, kind),
  FOREIGN KEY (updated_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX origin_threshold_updated_by_idx ON institution.origin_threshold (updated_by, institution_id);
ALTER TABLE institution.origin_threshold ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution.origin_threshold FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_threshold_owner ON institution.origin_threshold TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE TABLE audit.origin_threshold_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  kind text NOT NULL CHECK (kind IN ('typed', 'assistant_inserted', 'assistant_match',
                                     'imported_file', 'pasted_known', 'pasted_unknown')),
  action text NOT NULL CHECK (action IN ('set', 'cleared')),
  threshold_percent numeric(4, 1) CHECK (threshold_percent >= 0 AND threshold_percent <= 100),
  strictness text CHECK (strictness IN ('hard', 'soft')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  CHECK ((action = 'set') = (threshold_percent IS NOT NULL AND strictness IS NOT NULL))
);
CREATE INDEX origin_threshold_event_institution_idx ON audit.origin_threshold_event (institution_id, occurred_at);
CREATE INDEX origin_threshold_event_actor_idx ON audit.origin_threshold_event (actor_id, institution_id);
CREATE TRIGGER origin_threshold_event_append_only BEFORE UPDATE OR DELETE ON audit.origin_threshold_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER origin_threshold_event_no_truncate BEFORE TRUNCATE ON audit.origin_threshold_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
ALTER TABLE audit.origin_threshold_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.origin_threshold_event FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_threshold_event_owner ON audit.origin_threshold_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The administrator of the caller's institution, confirmed and not revoked; the
-- role row is locked FOR SHARE so a revocation waits for this transaction.
CREATE FUNCTION app.origin_threshold_admin() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = actor.institution_id AND r.user_id = actor.user_id AND r.role = 'admin'
     AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN actor.institution_id;
END
$$;

-- The thresholds written, in the fixed order of the kinds. Empty while none is written.
CREATE FUNCTION app.origin_thresholds_read()
RETURNS TABLE (kind text, threshold_percent numeric, strictness text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
BEGIN
  v_institution := app.origin_threshold_admin();
  RETURN QUERY
    SELECT t.kind, t.threshold_percent, t.strictness
      FROM institution.origin_threshold t
     WHERE t.institution_id = v_institution
     ORDER BY array_position(ARRAY['typed', 'assistant_inserted', 'assistant_match',
                                   'imported_file', 'pasted_known', 'pasted_unknown'], t.kind);
END
$$;

-- Writes the threshold of one kind. Returns whether anything changed: the same
-- value again changes nothing and records nothing.
CREATE FUNCTION app.origin_threshold_put(p_kind text, p_percent numeric, p_strictness text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_user uuid;
  v_percent numeric(4, 1);
  v_written boolean;
BEGIN
  v_institution := app.origin_threshold_admin();
  SELECT a.user_id INTO v_user FROM app.current_actor() a;
  IF p_kind IS NULL OR p_kind NOT IN ('typed', 'assistant_inserted', 'assistant_match',
                                       'imported_file', 'pasted_known', 'pasted_unknown')
     OR p_percent IS NULL OR p_percent < 0 OR p_percent > 100
     OR p_strictness IS NULL OR p_strictness NOT IN ('hard', 'soft') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_percent := round(p_percent, 1);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'origin_threshold:' || v_institution::text, 0));
  WITH written AS (
    INSERT INTO institution.origin_threshold AS t (institution_id, kind, threshold_percent, strictness, updated_by)
    VALUES (v_institution, p_kind, v_percent, p_strictness, v_user)
    ON CONFLICT (institution_id, kind) DO UPDATE
      SET threshold_percent = EXCLUDED.threshold_percent, strictness = EXCLUDED.strictness,
          updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE (t.threshold_percent, t.strictness) IS DISTINCT FROM (EXCLUDED.threshold_percent, EXCLUDED.strictness)
    RETURNING t.kind, t.threshold_percent, t.strictness),
  trail AS (
    INSERT INTO audit.origin_threshold_event (institution_id, kind, action, threshold_percent, strictness, actor_id)
    SELECT v_institution, w.kind, 'set', w.threshold_percent, w.strictness, v_user FROM written w
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM trail) INTO v_written;
  RETURN v_written;
END
$$;

-- Removes the threshold of one kind (the kind has none afterwards). Returns
-- whether there was one.
CREATE FUNCTION app.origin_threshold_clear(p_kind text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_user uuid;
  v_cleared boolean;
BEGIN
  v_institution := app.origin_threshold_admin();
  SELECT a.user_id INTO v_user FROM app.current_actor() a;
  IF p_kind IS NULL OR p_kind NOT IN ('typed', 'assistant_inserted', 'assistant_match',
                                       'imported_file', 'pasted_known', 'pasted_unknown') THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'origin_threshold:' || v_institution::text, 0));
  WITH gone AS (
    DELETE FROM institution.origin_threshold t
     WHERE t.institution_id = v_institution AND t.kind = p_kind
    RETURNING t.kind),
  trail AS (
    INSERT INTO audit.origin_threshold_event (institution_id, kind, action, threshold_percent, strictness, actor_id)
    SELECT v_institution, g.kind, 'cleared', NULL, NULL, v_user FROM gone g
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM trail) INTO v_cleared;
  RETURN v_cleared;
END
$$;

-- The comparison of a work with the thresholds, only for the kinds that have
-- one. The share is the one of app.origin_composition_of (one decimal); above
-- the threshold is strictly greater, so a share equal to it is in line.
CREATE FUNCTION app.work_origin_threshold_status(p_document_id text)
RETURNS TABLE (kind text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_access record;
BEGIN
  SELECT r.institution_id INTO v_institution FROM institution.require_actor() r;
  SELECT * INTO v_access FROM app.origin_work_access(p_document_id, false);
  RETURN QUERY
    SELECT t.kind,
           CASE WHEN c.percent <= t.threshold_percent THEN 'in_line'
                WHEN t.strictness = 'hard' THEN 'exceeded'
                ELSE 'for_review' END
      FROM institution.origin_threshold t
      JOIN app.origin_composition_of(v_access.assignment_id, v_access.student_id) c ON c.kind = t.kind
     WHERE t.institution_id = v_institution
     ORDER BY array_position(ARRAY['typed', 'assistant_inserted', 'assistant_match',
                                   'imported_file', 'pasted_known', 'pasted_unknown'], t.kind);
END
$$;

REVOKE ALL ON FUNCTION app.origin_threshold_admin(), app.origin_thresholds_read(),
  app.origin_threshold_put(text, numeric, text), app.origin_threshold_clear(text),
  app.work_origin_threshold_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.origin_thresholds_read(), app.origin_threshold_put(text, numeric, text),
  app.origin_threshold_clear(text), app.work_origin_threshold_status(text) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit, institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app, audit, institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.work_origin_threshold_status(text);
DROP FUNCTION app.origin_threshold_clear(text);
DROP FUNCTION app.origin_threshold_put(text, numeric, text);
DROP FUNCTION app.origin_thresholds_read();
DROP FUNCTION app.origin_threshold_admin();
DROP TABLE audit.origin_threshold_event;
DROP TABLE institution.origin_threshold;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app, audit, institution FROM ductus_identity;
