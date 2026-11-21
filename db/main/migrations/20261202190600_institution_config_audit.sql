-- migrate:up
-- SRV-1406 (M2.12, plan M2 C1-C3): the audit trail of the versions of the
-- institution configuration. SRV-1405 stores every version of the rules in
-- app.institution_config but writes no audit row; the route that publishes a
-- version (acceptance 4: every new version leaves a record in the audit log)
-- needs one, so it is added here exactly as for the faculty rules
-- (audit.faculty_rule_event, DAN-315).
--
-- audit.institution_config_event: one append-only row per published version,
-- bound by foreign keys to the version and to its author, written by
-- app.publish_institution_config in the same statement as the version. Owner
-- only, forced RLS; no application role reads or writes it. A deferred check
-- refuses to commit a version without its row, and the row of every version
-- that exists is added below, as of its creation.
--
-- Errors are those of SRV-1405: ZD401, ZD403, ZD409, ZD422.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE audit.institution_config_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  version integer NOT NULL,
  kind text NOT NULL CHECK (kind = 'published'),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (institution_id, version, kind),
  CONSTRAINT institution_config_event_version_fkey FOREIGN KEY (institution_id, version)
    REFERENCES app.institution_config (institution_id, version),
  CONSTRAINT institution_config_event_actor_fkey FOREIGN KEY (actor_id, institution_id)
    REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX institution_config_event_institution_idx ON audit.institution_config_event (institution_id, occurred_at);

CREATE TRIGGER institution_config_event_append_only BEFORE UPDATE OR DELETE ON audit.institution_config_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER institution_config_event_no_truncate BEFORE TRUNCATE ON audit.institution_config_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE audit.institution_config_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.institution_config_event FORCE ROW LEVEL SECURITY;
CREATE POLICY institution_config_event_owner ON audit.institution_config_event TO ductus_identity
  USING (true) WITH CHECK (true);

-- The versions that exist become events, as of their creation.
INSERT INTO audit.institution_config_event (institution_id, version, kind, actor_id, occurred_at)
SELECT institution_id, version, 'published', created_by, created_at FROM app.institution_config;

-- No version without its audit row (the foreign key already refuses a row
-- without its version). Checked at commit, where the caller is still
-- ductus_app, which cannot read the trail: hence the definer.
CREATE FUNCTION app.check_institution_config_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.institution_config_event e
                 WHERE e.institution_id = NEW.institution_id AND e.version = NEW.version) THEN
    RAISE EXCEPTION 'institution config version without audit row' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.check_institution_config_event() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER institution_config_has_event AFTER INSERT ON app.institution_config
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_institution_config_event();

-- As in SRV-1405, with the audit row written in the same statement.
CREATE OR REPLACE FUNCTION app.publish_institution_config(p_expected_version integer, p_rules jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_rules IS NULL OR pg_catalog.jsonb_typeof(p_rules) <> 'object'
     OR pg_catalog.octet_length(p_rules::text) > 16384
     OR p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  PERFORM 1 FROM identity.institution i WHERE i.id = v_institution FOR UPDATE;
  SELECT coalesce(max(c.version), 0) INTO v_latest
    FROM app.institution_config c WHERE c.institution_id = v_institution;
  IF v_latest <> p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;

  WITH published AS (
    INSERT INTO app.institution_config (institution_id, version, rules, created_by)
    VALUES (v_institution, v_latest + 1, p_rules, v_user)
    RETURNING institution_id, version, created_by, created_at
  )
  INSERT INTO audit.institution_config_event (institution_id, version, kind, actor_id, occurred_at)
  SELECT institution_id, version, 'published', created_by, created_at FROM published;
  RETURN v_latest + 1;
END
$$;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE OR REPLACE FUNCTION app.publish_institution_config(p_expected_version integer, p_rules jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
  v_latest integer;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  IF p_rules IS NULL OR pg_catalog.jsonb_typeof(p_rules) <> 'object'
     OR pg_catalog.octet_length(p_rules::text) > 16384
     OR p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;

  PERFORM 1 FROM identity.institution i WHERE i.id = v_institution FOR UPDATE;
  SELECT coalesce(max(c.version), 0) INTO v_latest
    FROM app.institution_config c WHERE c.institution_id = v_institution;
  IF v_latest <> p_expected_version THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'ZD409';
  END IF;

  INSERT INTO app.institution_config (institution_id, version, rules, created_by)
  VALUES (v_institution, v_latest + 1, p_rules, v_user);
  RETURN v_latest + 1;
END
$$;
DROP TRIGGER institution_config_has_event ON app.institution_config;
DROP FUNCTION app.check_institution_config_event();
DROP TABLE audit.institution_config_event;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
