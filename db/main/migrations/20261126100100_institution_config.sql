-- migrate:up
-- SRV-1405 (M2.12, M2.17; D-117, D-175, D-199): the configuration of an
-- institution as versioned rules of the faculty.
--
-- app.institution_config keeps every version of the rules of one
-- institution. A version is only ever added: the row of an older version
-- stays as it was for the assignments that already use it, so no UPDATE and
-- no DELETE reaches a row, not even the owner's (ZD409). The rules are a JSON
-- object; its shape is checked by the server against the schema of
-- server/database/institution-config (ductura-faculty-rules-v1) before it
-- comes here, and here only as an object of bounded size.
--
-- An administrator of the institution adds a version through
-- app.publish_institution_config and reads the versions of the own
-- institution through RLS; an administrator of another institution, a
-- teacher and a student see no row (a role alone opens nothing else, C-23).
--
-- An assignment remembers the version in force when it was created
-- (institution.assignment.config_version, set by a trigger, never by the
-- caller, and never changed afterwards). app.assignment_institution_config
-- returns exactly that version to whoever may see the assignment, so an
-- assignment created before a new version keeps reading the older one. An
-- assignment created while the institution had no version has none; the
-- server then uses the faculty file in config/faculties.
--
-- Errors carry no input: ZD401 no open session, ZD403 not allowed (also when
-- the object does not exist), ZD409 not the expected latest version or a
-- change of a stored version, ZD422 invalid rules.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE app.institution_config (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  version integer NOT NULL CHECK (version >= 1),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object' AND octet_length(rules::text) <= 16384),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (institution_id, version),
  FOREIGN KEY (created_by, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE app.institution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_config FORCE ROW LEVEL SECURITY;
CREATE POLICY institution_config_owner ON app.institution_config TO ductus_identity
  USING (true) WITH CHECK (true);
CREATE POLICY institution_config_read ON app.institution_config FOR SELECT TO ductus_app
  USING (institution_id = (SELECT app.current_institution_id()) AND (SELECT institution.actor_has_role('admin')));
GRANT SELECT ON app.institution_config TO ductus_app;

-- Append-only, for every role: a stored version never changes and never goes.
CREATE FUNCTION app.refuse_institution_config_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'institution config version is immutable' USING ERRCODE = 'ZD409';
END
$$;
REVOKE ALL ON FUNCTION app.refuse_institution_config_change() FROM PUBLIC;
CREATE TRIGGER institution_config_immutable BEFORE UPDATE OR DELETE ON app.institution_config
  FOR EACH ROW EXECUTE FUNCTION app.refuse_institution_config_change();
CREATE TRIGGER institution_config_no_truncate BEFORE TRUNCATE ON app.institution_config
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_institution_config_change();

-- The administrator of the caller's institution adds the next version.
-- p_expected_version is the latest version the administrator saw (0 when
-- there was none); another version added in between gives ZD409, so two
-- administrators never overwrite each other's change unnoticed. The
-- institution row is locked, so versions are numbered without gaps.
CREATE FUNCTION app.publish_institution_config(p_expected_version integer, p_rules jsonb) RETURNS integer
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
REVOKE ALL ON FUNCTION app.publish_institution_config(integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publish_institution_config(integer, jsonb) TO ductus_app;

-- The version an assignment was created under. Existing assignments keep
-- none: they were created before any version existed.
ALTER TABLE institution.assignment ADD COLUMN config_version integer;
ALTER TABLE institution.assignment ADD CONSTRAINT assignment_config_version_fkey
  FOREIGN KEY (institution_id, config_version) REFERENCES app.institution_config (institution_id, version);

-- On insert the latest version of the assignment's institution, whatever the
-- caller sent; afterwards the column never changes (ZD409).
-- A definer, so whichever role inserts the assignment reads the versions as
-- their owner; RLS and the grants of that role stay as they were.
CREATE FUNCTION institution.pin_assignment_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.config_version := (SELECT max(c.version) FROM app.institution_config c
                            WHERE c.institution_id = NEW.institution_id);
  ELSIF NEW.config_version IS DISTINCT FROM OLD.config_version THEN
    RAISE EXCEPTION 'config version is immutable' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION institution.pin_assignment_config() FROM PUBLIC;
CREATE TRIGGER assignment_config_pin BEFORE INSERT OR UPDATE OF config_version ON institution.assignment
  FOR EACH ROW EXECUTE FUNCTION institution.pin_assignment_config();

-- The rules an assignment reads: its own version, for whoever may see the
-- assignment (teacher, student, mentor through actor_assignment_role). No
-- row when the assignment was created without a version. ZD403 for an
-- assignment the caller may not see or that does not exist.
CREATE FUNCTION app.assignment_institution_config(p_assignment_id uuid)
RETURNS TABLE (version integer, rules jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (SELECT a.user_id FROM app.current_actor() a) IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  IF institution.actor_assignment_role(p_assignment_id) IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  RETURN QUERY
    SELECT c.version, c.rules
      FROM institution.assignment a
      JOIN app.institution_config c ON c.institution_id = a.institution_id AND c.version = a.config_version
     WHERE a.id = p_assignment_id;
END
$$;
REVOKE ALL ON FUNCTION app.assignment_institution_config(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignment_institution_config(uuid) TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA app TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION app.assignment_institution_config(uuid);
DROP TRIGGER assignment_config_pin ON institution.assignment;
DROP FUNCTION institution.pin_assignment_config();
ALTER TABLE institution.assignment DROP CONSTRAINT assignment_config_version_fkey;
ALTER TABLE institution.assignment DROP COLUMN config_version;
DROP FUNCTION app.publish_institution_config(integer, jsonb);
DROP TABLE app.institution_config;
DROP FUNCTION app.refuse_institution_config_change();

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
