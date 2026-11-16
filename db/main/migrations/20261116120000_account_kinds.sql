-- DAN-798 (S-1J.1-b; contract on Ductus#1836, comment 6903835425, confirmed
-- in 6903876036): every one of the five account kinds of
-- server/roles/account-kinds.ts has its place in the main database.
--
--   student            institution.course_member, role 'student' (exists)
--   teacher            institution.institution_role, role 'teacher' (exists)
--   institution_admin  institution.institution_role, role 'admin' (exists)
--   network_engineer   identity.network_engineer_appointment (new)
--   app_admin          identity.app_admin (new)
--
-- db/main/tests/130-account-kinds.sql holds this list as the access matrix.
--
-- - identity.network_engineer_appointment: an engineer of an institution and
--   who appointed them, both accounts of that institution. D-297 (amending
--   D-262 Q04) gives the appointment to the institution's administrator; the
--   function that does it, with its audit row, is S-1J-c. Nothing here writes
--   a row, and no role but the owner holds any right on the table.
-- - identity.app_admin: an application administrator, written only by the
--   owner of the system outside the application (owner action V-7). D-297
--   leaves open whether that person is a user of an institution (D-16) and
--   how they sign in (plan question 8), so the row has no link to an account
--   yet; the step that decides it adds one. Three layers keep it unwritable
--   from the application: no role but the owner holds a right on it; the
--   owner, ductus_identity, gives up its own write rights and its only policy
--   is SELECT, so no SECURITY DEFINER function it owns can write either; and
--   a trigger refuses every write, TRUNCATE included, by a role that is not a
--   superuser (ZD409). The owner can still undo the first two with DDL; that
--   is not an application role, and 130 fails if a migration does it.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE identity.network_engineer_appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  user_id uuid NOT NULL,
  appointed_by uuid NOT NULL,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (user_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (appointed_by, institution_id) REFERENCES identity.user_account (id, institution_id),
  CHECK (revoked_at >= appointed_at)
);
-- One active appointment per person and institution. The plain indexes below
-- serve the two foreign keys, revoked rows included.
CREATE UNIQUE INDEX network_engineer_appointment_active
  ON identity.network_engineer_appointment (user_id, institution_id) WHERE revoked_at IS NULL;
CREATE INDEX network_engineer_appointment_user
  ON identity.network_engineer_appointment (user_id, institution_id);
CREATE INDEX network_engineer_appointment_appointed_by
  ON identity.network_engineer_appointment (appointed_by, institution_id);

ALTER TABLE identity.network_engineer_appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.network_engineer_appointment FORCE ROW LEVEL SECURITY;
CREATE POLICY network_engineer_appointment_owner ON identity.network_engineer_appointment
  TO ductus_identity USING (true) WITH CHECK (true);

CREATE TABLE identity.app_admin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (revoked_at >= created_at)
);

ALTER TABLE identity.app_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.app_admin FORCE ROW LEVEL SECURITY;
CREATE POLICY app_admin_owner_read ON identity.app_admin FOR SELECT TO ductus_identity USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.app_admin FROM ductus_identity;

-- SECURITY INVOKER, so current_user is the role that writes, not the owner.
CREATE FUNCTION identity.refuse_app_admin_write() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NOT coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'app_admin is written only outside the application' USING ERRCODE = 'ZD409';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.refuse_app_admin_write() FROM PUBLIC;
CREATE TRIGGER app_admin_refuse_row_write BEFORE INSERT OR UPDATE OR DELETE ON identity.app_admin
  FOR EACH ROW EXECUTE FUNCTION identity.refuse_app_admin_write();
CREATE TRIGGER app_admin_refuse_truncate BEFORE TRUNCATE ON identity.app_admin
  FOR EACH STATEMENT EXECUTE FUNCTION identity.refuse_app_admin_write();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP TABLE identity.app_admin;
DROP FUNCTION identity.refuse_app_admin_write();
DROP TABLE identity.network_engineer_appointment;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
