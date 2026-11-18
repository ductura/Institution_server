-- migrate:up
-- Provisioning of an institution instance (contract Ductus#2028 c.6993786629
-- §2; slot w1111a). Aplication_server sends an institution to this server,
-- server to server; the browser never does. One SECURITY DEFINER function
-- writes, in one transaction, everything a login needs (open_session reads
-- identity.institution.aai_home_org and identity.institution_issuer, so a new
-- institution takes logins without a restart) together with its display name
-- and its seats per role. D-09 is unchanged: a row only names whom AAI@EduHr
-- may sign in for this institution, it adds no way to sign in.
--
-- identity.institution_seat: the number of accounts of each role an
-- institution has bought. As every identity table: RLS forced, only the owner
-- has a policy, no role holds a grant; it is read and written only through the
-- definer functions below.
--
-- identity.provision_institution: the HTTP route calls it over the ductus_auth
-- login (the server-to-server pool, as the back-channel logout); ductus_app
-- never holds it. Outcome, never an error, for the answers of §2:
--   created       201, every row written now
--   existing      200, the same slug with exactly the same data (idempotent)
--   slug_taken    409, the slug exists with any other data
--   domain_taken  409, the slug is free but aai_home_org belongs to another
--   ZD422         400, input outside the column rules (the route checks first)
-- Concurrent equal requests: ON CONFLICT waits for the first transaction and
-- the second then reads its rows as existing.
--
-- identity.provisioned_institution: the read of §2 GET, same login; no row for
-- an institution that cannot take logins (no home organisation, issuer or
-- display name).
--
-- app.my_account: the caller of GET /api/v1/me (§3.3) from app.current_actor();
-- no parameter names the caller. ZD401 without an open session. The roles are
-- relations in force: teacher and institution_admin from a confirmed, not
-- revoked institution_role, network_engineer from an active appointment, and
-- student from an open student membership or when the account holds no other
-- role (every AAI@EduHr account of an institution starts as a student).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE identity.institution_seat (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  role text NOT NULL CHECK (role IN ('student', 'teacher', 'network_engineer', 'institution_admin')),
  seats integer NOT NULL CHECK (seats BETWEEN 0 AND 1000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, role)
);
ALTER TABLE identity.institution_seat ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.institution_seat FORCE ROW LEVEL SECURITY;
CREATE POLICY institution_seat_owner ON identity.institution_seat TO ductus_identity
  USING (true) WITH CHECK (true);

CREATE FUNCTION identity.provision_institution(
  p_slug text,
  p_display_name text,
  p_aai_home_org text,
  p_oidc_issuer text,
  p_student_seats integer,
  p_teacher_seats integer,
  p_engineer_seats integer,
  p_admin_seats integer,
  OUT outcome text,
  OUT institution_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_seats jsonb;
  v_same boolean;
BEGIN
  IF p_slug IS NULL OR p_slug !~ ('^[a-z0-9-]{2,32}$' COLLATE "C")
     OR p_display_name IS NULL OR NOT institution.is_plain_label(p_display_name)
     OR p_aai_home_org IS NULL OR char_length(p_aai_home_org) > 253
     OR p_aai_home_org !~ ('^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' COLLATE "C")
     OR p_oidc_issuer IS NULL OR char_length(p_oidc_issuer) > 255
     OR p_oidc_issuer !~ ('^https?://[!-~]+$' COLLATE "C")
     OR p_student_seats IS NULL OR p_student_seats NOT BETWEEN 0 AND 1000000
     OR p_teacher_seats IS NULL OR p_teacher_seats NOT BETWEEN 0 AND 1000000
     OR p_engineer_seats IS NULL OR p_engineer_seats NOT BETWEEN 0 AND 1000000
     OR p_admin_seats IS NULL OR p_admin_seats NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = 'ZD422';
  END IF;
  v_seats := pg_catalog.jsonb_build_object(
    'student', p_student_seats, 'teacher', p_teacher_seats,
    'network_engineer', p_engineer_seats, 'institution_admin', p_admin_seats);

  INSERT INTO identity.institution AS i (slug, aai_home_org)
  VALUES (p_slug, p_aai_home_org)
  ON CONFLICT DO NOTHING
  RETURNING i.id INTO institution_id;

  IF institution_id IS NOT NULL THEN
    INSERT INTO identity.institution_issuer (institution_id, oidc_issuer)
    VALUES (institution_id, p_oidc_issuer);
    INSERT INTO institution.institution_settings (institution_id, display_name)
    VALUES (institution_id, p_display_name);
    INSERT INTO identity.institution_seat (institution_id, role, seats)
    SELECT institution_id, s.key, (s.value)::integer FROM pg_catalog.jsonb_each_text(v_seats) s;
    outcome := 'created';
    RETURN;
  END IF;

  SELECT i.id INTO institution_id FROM identity.institution i WHERE i.slug = p_slug;
  IF institution_id IS NULL THEN
    -- The slug is free, so the conflict was the home organisation.
    outcome := 'domain_taken';
    RETURN;
  END IF;

  SELECT i.aai_home_org IS NOT DISTINCT FROM p_aai_home_org
     AND EXISTS (SELECT 1 FROM institution.institution_settings s
                  WHERE s.institution_id = i.id AND s.display_name = p_display_name)
     AND (SELECT pg_catalog.array_agg(ii.oidc_issuer) FROM identity.institution_issuer ii
           WHERE ii.institution_id = i.id) = ARRAY[p_oidc_issuer]
     AND (SELECT pg_catalog.jsonb_object_agg(st.role, st.seats) FROM identity.institution_seat st
           WHERE st.institution_id = i.id) = v_seats
    INTO v_same
  FROM identity.institution i WHERE i.id = institution_id;

  IF v_same IS TRUE THEN
    outcome := 'existing';
  ELSE
    outcome := 'slug_taken';
    institution_id := NULL;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION identity.provision_institution(text, text, text, text, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.provision_institution(text, text, text, text, integer, integer, integer, integer) TO ductus_auth;

CREATE FUNCTION identity.provisioned_institution(p_slug text)
RETURNS TABLE (
  institution_id uuid,
  slug text,
  display_name text,
  aai_home_org text,
  oidc_issuer text,
  student integer,
  teacher integer,
  network_engineer integer,
  institution_admin integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT i.id, i.slug, s.display_name, i.aai_home_org,
         (SELECT ii.oidc_issuer FROM identity.institution_issuer ii
           WHERE ii.institution_id = i.id ORDER BY ii.created_at, ii.oidc_issuer LIMIT 1),
         coalesce((SELECT st.seats FROM identity.institution_seat st WHERE st.institution_id = i.id AND st.role = 'student'), 0),
         coalesce((SELECT st.seats FROM identity.institution_seat st WHERE st.institution_id = i.id AND st.role = 'teacher'), 0),
         coalesce((SELECT st.seats FROM identity.institution_seat st WHERE st.institution_id = i.id AND st.role = 'network_engineer'), 0),
         coalesce((SELECT st.seats FROM identity.institution_seat st WHERE st.institution_id = i.id AND st.role = 'institution_admin'), 0)
  FROM identity.institution i
  JOIN institution.institution_settings s ON s.institution_id = i.id
  WHERE i.slug = p_slug
    AND i.aai_home_org IS NOT NULL
    AND EXISTS (SELECT 1 FROM identity.institution_issuer ii WHERE ii.institution_id = i.id)
$$;
REVOKE ALL ON FUNCTION identity.provisioned_institution(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.provisioned_institution(text) TO ductus_auth;

CREATE FUNCTION app.my_account(
  OUT institution_slug text,
  OUT institution_display_name text,
  OUT display_name text,
  OUT roles text[]
)
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
  SELECT i.slug, s.display_name INTO institution_slug, institution_display_name
  FROM identity.institution i
  LEFT JOIN institution.institution_settings s ON s.institution_id = i.id
  WHERE i.id = v_institution;
  SELECT n.given_name || ' ' || n.family_name INTO display_name
  FROM identity.person_name n WHERE n.user_id = v_user AND n.institution_id = v_institution;

  SELECT pg_catalog.array_agg(r.role ORDER BY r.role) INTO roles FROM (
    SELECT CASE ir.role WHEN 'admin' THEN 'institution_admin' ELSE ir.role END AS role
      FROM institution.institution_role ir
     WHERE ir.user_id = v_user AND ir.institution_id = v_institution
       AND ir.confirmed_at IS NOT NULL AND ir.revoked_at IS NULL
    UNION
    SELECT 'network_engineer' FROM identity.network_engineer_appointment ne
     WHERE ne.user_id = v_user AND ne.institution_id = v_institution
       AND ne.revoked_at IS NULL AND ne.appointed_at <= pg_catalog.now()
    UNION
    SELECT 'student' FROM institution.course_member m
     WHERE m.user_id = v_user AND m.institution_id = v_institution
       AND m.role = 'student' AND m.member_to IS NULL
  ) r;
  roles := coalesce(roles, ARRAY['student']);
END
$$;
REVOKE ALL ON FUNCTION app.my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_account() TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
GRANT CREATE ON SCHEMA app TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION app.my_account();
DROP FUNCTION identity.provisioned_institution(text);
DROP FUNCTION identity.provision_institution(text, text, text, text, integer, integer, integer, integer);
DROP TABLE identity.institution_seat;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA app FROM ductus_identity;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
