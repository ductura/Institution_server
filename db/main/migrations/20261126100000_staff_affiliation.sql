-- migrate:up
-- SRV-1403 (M1.3, DAN-304, D-205 t. 4): the staff affiliation that lets an
-- administrator confirm a teacher role. A teacher role is confirmed only for
-- a person whose last AAI@EduHr login released an affiliation of a member of
-- staff (employee or faculty) of the institution the account belongs to.
--
-- identity.staff_affiliation keeps, per account, which attribute gave the
-- affiliation and when a login last confirmed it; never the attribute's value
-- and never a scope. One row means "affiliated", no row means "not": the
-- person stays a student and reads the closed code staff_affiliation_missing.
-- The row and identity.teacher_eligibility (DAN-304) are written together, at
-- every login and in the same transaction, so neither outlives the other.
--
-- The source is a closed set: hrEduPersonAffiliation and eduPersonAffiliation
-- release values of the home organisation alone (they carry no scope);
-- eduPersonScopedAffiliation carries one, and only a scope equal to the home
-- organisation of the account's institution counts. Another institution's
-- affiliation gives nothing. A confirmed role stays when the affiliation goes
-- (D-200 P7), exactly as for teacher_eligibility.
--
-- Like every identity table, no role but ductus_identity holds a privilege on
-- it (pgTAP 020): the caller reads only their own row through
-- identity.my_staff_affiliation(), and nothing but the login writes it.
-- The foreign key does not cascade (033), as for teacher_eligibility.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE identity.staff_affiliation (
  user_id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('hrEduPersonAffiliation', 'eduPersonAffiliation', 'eduPersonScopedAffiliation')),
  confirmed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);

ALTER TABLE identity.staff_affiliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_affiliation FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_affiliation_owner ON identity.staff_affiliation TO ductus_identity
  USING (true) WITH CHECK (true);

-- The affiliation never outlives the right: whatever removes a row of
-- teacher_eligibility (a login without the right, or the step that deletes an
-- account and removes the right first) removes the affiliation in the same
-- statement. This is no foreign-key action (033): the two rows stay
-- independent references to the account.
CREATE FUNCTION identity.staff_affiliation_follows_right() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM identity.staff_affiliation WHERE user_id = OLD.user_id;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION identity.staff_affiliation_follows_right() FROM PUBLIC;
CREATE TRIGGER staff_affiliation_follows_right AFTER DELETE ON identity.teacher_eligibility
  FOR EACH ROW EXECUTE FUNCTION identity.staff_affiliation_follows_right();

-- The eight-argument form as before (20261101190000), with the affiliation
-- kept next to the right: a login that still sends only the fact (the eight-
-- and nine-argument forms) sends an unscoped hrEduPersonAffiliation value,
-- which is of the home organisation by definition.
CREATE OR REPLACE FUNCTION identity.open_session(
  p_issuer text,
  p_subject text,
  p_unique_id text,
  p_home_org text,
  p_token_hash bytea,
  p_given_name text,
  p_family_name text,
  p_teacher_eligible boolean
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_expires timestamptz;
  v_user uuid;
  v_institution uuid;
BEGIN
  v_expires := identity.open_session(p_issuer, p_subject, p_unique_id, p_home_org, p_token_hash, p_given_name, p_family_name);

  SELECT u.id, u.institution_id INTO STRICT v_user, v_institution
  FROM identity.user_account u
  WHERE u.oidc_issuer = p_issuer AND u.hr_edu_person_unique_id = p_unique_id;

  -- Only true gives the right; false and NULL take it away.
  IF p_teacher_eligible IS TRUE THEN
    INSERT INTO identity.teacher_eligibility (user_id, institution_id)
    VALUES (v_user, v_institution)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = pg_catalog.now();
    INSERT INTO identity.staff_affiliation (user_id, institution_id, source)
    VALUES (v_user, v_institution, 'hrEduPersonAffiliation')
    ON CONFLICT (user_id) DO UPDATE
      SET source = EXCLUDED.source, confirmed_at = pg_catalog.statement_timestamp();
  ELSE
    DELETE FROM identity.staff_affiliation WHERE user_id = v_user;
    DELETE FROM identity.teacher_eligibility WHERE user_id = v_user;
  END IF;
  RETURN v_expires;
END
$$;

-- The login the server sends from SRV-1403 on: the affiliation instead of
-- the bare fact. p_affiliation_source names the attribute that released a
-- staff value, NULL when none did; p_affiliation_scope is the scope of an
-- eduPersonScopedAffiliation value and NULL for the unscoped ones. The nine-
-- argument form runs first with no right, so every refusal is the same
-- refusal and nothing changes for a login that fails; the right and the
-- affiliation are then given here only when the source is one of the set
-- and a scope, when there is one, is the home organisation of the
-- institution the account belongs to. Anything else, an unknown source among
-- it, leaves the person without the right: the login stands.
CREATE FUNCTION identity.open_session(
  p_issuer text,
  p_subject text,
  p_unique_id text,
  p_home_org text,
  p_token_hash bytea,
  p_given_name text,
  p_family_name text,
  p_sid text,
  p_affiliation_source text,
  p_affiliation_scope text
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_expires timestamptz;
  v_user uuid;
  v_institution uuid;
  v_home_org text;
  v_accepted boolean;
BEGIN
  v_expires := identity.open_session(
    p_issuer, p_subject, p_unique_id, p_home_org, p_token_hash, p_given_name, p_family_name, false, p_sid
  );

  SELECT u.id, u.institution_id, i.aai_home_org INTO STRICT v_user, v_institution, v_home_org
  FROM identity.user_account u
  JOIN identity.institution i ON i.id = u.institution_id
  WHERE u.oidc_issuer = p_issuer AND u.hr_edu_person_unique_id = p_unique_id;

  v_accepted := CASE
    WHEN p_affiliation_source IN ('hrEduPersonAffiliation', 'eduPersonAffiliation')
      THEN p_affiliation_scope IS NULL
    WHEN p_affiliation_source = 'eduPersonScopedAffiliation'
      THEN v_home_org IS NOT NULL
       AND pg_catalog.lower(pg_catalog.btrim(p_affiliation_scope, E' \t\r\n') COLLATE "C") = v_home_org COLLATE "C"
    ELSE false
  END;

  IF v_accepted IS TRUE THEN
    INSERT INTO identity.teacher_eligibility (user_id, institution_id)
    VALUES (v_user, v_institution)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = pg_catalog.now();
    INSERT INTO identity.staff_affiliation (user_id, institution_id, source)
    VALUES (v_user, v_institution, p_affiliation_source)
    ON CONFLICT (user_id) DO UPDATE
      SET source = EXCLUDED.source, confirmed_at = pg_catalog.statement_timestamp();
  END IF;
  RETURN v_expires;
END
$$;

REVOKE ALL ON FUNCTION identity.open_session(text, text, text, text, bytea, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.open_session(text, text, text, text, bytea, text, text, text, text, text) TO ductus_auth;

-- The caller's own affiliation: one row (the source and the time a login
-- last confirmed it) or none. ZD401 without a live session. No argument, so
-- nobody can name another person.
CREATE FUNCTION identity.my_staff_affiliation()
RETURNS TABLE (source text, confirmed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_institution uuid;
BEGIN
  SELECT a.user_id, a.institution_id INTO v_user, v_institution FROM app.current_actor() a;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'ZD401';
  END IF;
  RETURN QUERY
    SELECT s.source, s.confirmed_at FROM identity.staff_affiliation s
     WHERE s.user_id = v_user AND s.institution_id = v_institution;
END
$$;

REVOKE ALL ON FUNCTION identity.my_staff_affiliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.my_staff_affiliation() TO ductus_app;

-- Every account that holds the right today got it from an unscoped
-- hrEduPersonAffiliation value (the only one read before SRV-1403).
INSERT INTO identity.staff_affiliation (user_id, institution_id, source, confirmed_at)
SELECT e.user_id, e.institution_id, 'hrEduPersonAffiliation', e.updated_at
  FROM identity.teacher_eligibility e;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

DROP FUNCTION identity.my_staff_affiliation();
DROP FUNCTION identity.open_session(text, text, text, text, bytea, text, text, text, text, text);

CREATE OR REPLACE FUNCTION identity.open_session(
  p_issuer text,
  p_subject text,
  p_unique_id text,
  p_home_org text,
  p_token_hash bytea,
  p_given_name text,
  p_family_name text,
  p_teacher_eligible boolean
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_expires timestamptz;
  v_user uuid;
  v_institution uuid;
BEGIN
  v_expires := identity.open_session(p_issuer, p_subject, p_unique_id, p_home_org, p_token_hash, p_given_name, p_family_name);

  SELECT u.id, u.institution_id INTO STRICT v_user, v_institution
  FROM identity.user_account u
  WHERE u.oidc_issuer = p_issuer AND u.hr_edu_person_unique_id = p_unique_id;

  -- Only true gives the right; false and NULL take it away.
  IF p_teacher_eligible IS TRUE THEN
    INSERT INTO identity.teacher_eligibility (user_id, institution_id)
    VALUES (v_user, v_institution)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = pg_catalog.now();
  ELSE
    DELETE FROM identity.teacher_eligibility WHERE user_id = v_user;
  END IF;
  RETURN v_expires;
END
$$;

DROP TRIGGER staff_affiliation_follows_right ON identity.teacher_eligibility;
DROP FUNCTION identity.staff_affiliation_follows_right();
DROP TABLE identity.staff_affiliation;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
