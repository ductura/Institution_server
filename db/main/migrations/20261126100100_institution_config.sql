-- migrate:up
-- SRV-1405 (M2.12/M2.17): an assignment binds the published configuration
-- of its own institution on insert. Existing assignments have no such pin.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE app.institution_config (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  rules jsonb NOT NULL,
  PRIMARY KEY (institution_id, version_no),
  CHECK ((
    jsonb_typeof(rules) = 'object'
    AND rules - ARRAY['evidenceProfile', 'importAllowed'] = '{}'::jsonb
    AND rules ->> 'evidenceProfile' IN ('basic', 'extended')
    AND jsonb_typeof(rules -> 'importAllowed') = 'boolean'
  ) IS TRUE)
);
ALTER TABLE app.institution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_config FORCE ROW LEVEL SECURITY;
CREATE POLICY institution_config_owner ON app.institution_config TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY institution_config_admin_read ON app.institution_config FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id())
         AND (SELECT institution.actor_has_role('admin')));
GRANT SELECT ON app.institution_config TO ductus_app;

CREATE FUNCTION app.refuse_institution_config_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'institution configuration is immutable' USING ERRCODE = 'ZD403';
END
$$;
REVOKE ALL ON FUNCTION app.refuse_institution_config_change() FROM PUBLIC;
CREATE TRIGGER institution_config_immutable BEFORE UPDATE OR DELETE ON app.institution_config
  FOR EACH ROW EXECUTE FUNCTION app.refuse_institution_config_change();
CREATE TRIGGER institution_config_no_truncate BEFORE TRUNCATE ON app.institution_config
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_institution_config_change();

-- An operator imports validated files under the identity owner role.
-- Lock the institution so overlapping publications compare against the
-- latest committed version. Replaying the identical publication is safe.
CREATE FUNCTION app.publish_institution_config(p_faculty text, p_version integer, p_rules jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_institution uuid;
  v_latest integer;
BEGIN
  SELECT i.id INTO v_institution FROM identity.institution i
  WHERE i.slug = p_faculty FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'institution not found' USING ERRCODE = 'ZD404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.institution_config c WHERE c.institution_id = v_institution
      AND c.version_no = p_version AND c.rules = p_rules
  ) THEN
    RETURN;
  END IF;
  SELECT max(c.version_no) INTO v_latest FROM app.institution_config c
  WHERE c.institution_id = v_institution;
  IF p_version <= v_latest THEN
    RAISE EXCEPTION 'institution configuration version must increase' USING ERRCODE = 'ZD409';
  END IF;
  INSERT INTO app.institution_config (institution_id, version_no, rules)
  VALUES (v_institution, p_version, p_rules);
END
$$;
REVOKE ALL ON FUNCTION app.publish_institution_config(text, integer, jsonb) FROM PUBLIC;

ALTER TABLE institution.assignment ADD COLUMN institution_config_version integer;
ALTER TABLE institution.assignment ADD CONSTRAINT assignment_institution_config_fkey
  FOREIGN KEY (institution_id, institution_config_version)
  REFERENCES app.institution_config (institution_id, version_no);

CREATE FUNCTION app.pin_assignment_institution_config() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  SELECT max(c.version_no) INTO NEW.institution_config_version
  FROM app.institution_config c WHERE c.institution_id = NEW.institution_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.pin_assignment_institution_config() FROM PUBLIC;
CREATE TRIGGER assignment_institution_config_pin BEFORE INSERT ON institution.assignment
  FOR EACH ROW EXECUTE FUNCTION app.pin_assignment_institution_config();
CREATE TRIGGER assignment_institution_config_immutable
  BEFORE UPDATE OF institution_id, institution_config_version ON institution.assignment
  FOR EACH ROW WHEN (OLD.institution_id IS DISTINCT FROM NEW.institution_id
                    OR OLD.institution_config_version IS DISTINCT FROM NEW.institution_config_version)
  EXECUTE FUNCTION app.refuse_institution_config_change();

-- Same institution and assignment relationship as assignment_read.
CREATE FUNCTION app.assignment_institution_config(p_assignment_id uuid)
RETURNS TABLE (version_no integer, rules jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.version_no, c.rules
  FROM institution.assignment a
  JOIN app.institution_config c
    ON c.institution_id = a.institution_id AND c.version_no = a.institution_config_version
  WHERE a.id = p_assignment_id
    AND a.institution_id = (SELECT app.current_institution_id())
    AND a.id = ANY ((SELECT institution.actor_assignment_ids('{teacher,student}'))::uuid[])
$$;
REVOKE ALL ON FUNCTION app.assignment_institution_config(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_institution_config(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
RESET ROLE;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.assignment_institution_config(uuid);
DROP TRIGGER assignment_institution_config_immutable ON institution.assignment;
DROP TRIGGER assignment_institution_config_pin ON institution.assignment;
ALTER TABLE institution.assignment DROP COLUMN institution_config_version;
DROP FUNCTION app.pin_assignment_institution_config();
DROP FUNCTION app.publish_institution_config(text, integer, jsonb);
DROP TABLE app.institution_config;
DROP FUNCTION app.refuse_institution_config_change();
RESET ROLE;
