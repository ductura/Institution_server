-- DAN-810 (S-1J-c2; contract on Ductus#1836, comment 6907140478; attack plan
-- ductura/server#110): the rule of server/roles/permissions.ts for
-- assign_admin_network_engineer_roles x institution_admin = own_institution,
-- for its administrator half (D-297 (2), amending D-262 Q04). The network
-- engineer half is 20261116140000 (DAN-809).
--
-- The operator procedure of 20261104130000 stays as it is: the first
-- administrator of a new institution, the revocation of the last one and the
-- written request as evidence still go only through it (D-297 keeps that part
-- of Q04 for that case). Its trail, audit.teacher_role_event, still admits no
-- administrator row from the owner; this path has its own trail instead.
--
-- - institution.admin_appoint_admin(user): only a confirmed administrator of
--   the caller's own institution, from the session. A person who does not
--   exist, is of another institution or is the caller is refused with the
--   same ZD403, so the answer does not tell which. Someone already in office
--   answers false and nothing is written. It takes the operator procedure's
--   lock of the institution before it reads the caller's office, and holds
--   the caller's row until commit, so a revocation in flight cannot let
--   through an appointment by an administrator it has just removed.
-- - audit.institution_admin_event: one append-only row per role row, written
--   in the same statement as the role row, with the administrator from the
--   session. Owner-only, forced RLS, bound to the role row it records. A
--   trigger refuses a row whose administrator is not one in office at the
--   same institution, or is the person appointed, so the owner cannot write
--   one in anybody's name either.
-- - institution.check_admin_appointment(): an active confirmed administrator
--   row is admitted with the operator's 'confirmed' row or with this trail's
--   'appointed' row of the same statement (same xmin); everything else it
--   checks is unchanged.
--
-- Errors carry no input: ZD401 no session, ZD403 refused, ZD409 a trail row
-- the trigger refuses, 25000 a level other than READ COMMITTED.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE audit.institution_admin_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  role_id uuid NOT NULL,
  admin_id uuid NOT NULL,
  role text NOT NULL CHECK (role = 'admin'),
  kind text NOT NULL CHECK (kind = 'appointed'),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (role_id, kind),
  CHECK (actor_id <> admin_id),
  CONSTRAINT institution_admin_event_role_fkey FOREIGN KEY (role_id, institution_id, admin_id, role)
    REFERENCES institution.institution_role (id, institution_id, user_id, role),
  FOREIGN KEY (admin_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX institution_admin_event_institution_idx ON audit.institution_admin_event (institution_id, occurred_at);
CREATE INDEX institution_admin_event_admin_idx ON audit.institution_admin_event (admin_id, institution_id);
CREATE INDEX institution_admin_event_actor_idx ON audit.institution_admin_event (actor_id, institution_id);

CREATE TRIGGER institution_admin_event_append_only BEFORE UPDATE OR DELETE ON audit.institution_admin_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER institution_admin_event_no_truncate BEFORE TRUNCATE ON audit.institution_admin_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE audit.institution_admin_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.institution_admin_event FORCE ROW LEVEL SECURITY;
CREATE POLICY institution_admin_event_owner ON audit.institution_admin_event
  TO ductus_identity USING (true) WITH CHECK (true);

-- The administrator who appoints must be in office at that institution when
-- the row is written: a confirmed, unrevoked administrator row other than the
-- one being appointed.
CREATE FUNCTION institution.check_admin_event_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_id = NEW.admin_id
     OR NOT EXISTS (SELECT 1 FROM institution.institution_role r
                    WHERE r.institution_id = NEW.institution_id AND r.user_id = NEW.actor_id
                      AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
                      AND r.id <> NEW.role_id) THEN
    RAISE EXCEPTION 'appointing administrator not in office' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER institution_admin_event_actor BEFORE INSERT ON audit.institution_admin_event
  FOR EACH ROW EXECUTE FUNCTION institution.check_admin_event_actor();

-- true when this call appointed the person; false when they already were in
-- office. RETURNING gives only a row inserted now or a pending row confirmed
-- now. As in the operator procedure, a pending row that was confirmed once
-- before (made pending by a direct write) is closed first, so each trail
-- holds at most one confirming row per role row.
CREATE FUNCTION institution.admin_appoint_admin(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_written integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'read committed required' USING ERRCODE = '25000';
  END IF;
  SELECT * INTO actor FROM institution.require_actor();
  -- The operator procedure's lock first; the statements below then see every
  -- revocation committed before it.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'institution.institution_admin:' || actor.institution_id::text, 0));
  PERFORM 1 FROM institution.institution_role r
   WHERE r.institution_id = actor.institution_id AND r.user_id = actor.user_id
     AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND
     OR p_user_id IS NULL
     OR p_user_id = actor.user_id
     OR NOT EXISTS (
       SELECT 1 FROM identity.user_account u
       WHERE u.id = p_user_id AND u.institution_id = actor.institution_id
       FOR SHARE
     ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  UPDATE institution.institution_role r SET revoked_at = now()
   WHERE r.institution_id = actor.institution_id AND r.user_id = p_user_id AND r.role = 'admin'
     AND r.confirmed_at IS NULL AND r.revoked_at IS NULL
     AND (EXISTS (SELECT 1 FROM audit.teacher_role_event e WHERE e.role_id = r.id AND e.kind = 'confirmed')
          OR EXISTS (SELECT 1 FROM audit.institution_admin_event e WHERE e.role_id = r.id));
  WITH appointed AS (
    INSERT INTO institution.institution_role AS r (institution_id, user_id, role, confirmed_by, confirmed_at)
    VALUES (actor.institution_id, p_user_id, 'admin', actor.user_id, now())
    ON CONFLICT (institution_id, user_id, role) WHERE revoked_at IS NULL
    DO UPDATE SET confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at
    WHERE r.confirmed_at IS NULL
    RETURNING r.id, r.institution_id, r.user_id, r.role, r.confirmed_at
  )
  INSERT INTO audit.institution_admin_event (institution_id, role_id, admin_id, role, kind, actor_id, occurred_at)
  SELECT appointed.institution_id, appointed.id, appointed.user_id, appointed.role, 'appointed', actor.user_id,
         appointed.confirmed_at
  FROM appointed;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written > 0;
END
$$;

-- As in 20261104130000, with the second admitting trail row. The operator's
-- 'revoked' row and a restore still refuse the row whichever trail admitted it.
CREATE OR REPLACE FUNCTION institution.check_admin_appointment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_restored boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_restored := OLD.revoked_at IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.institution_role r
             WHERE r.id = NEW.id AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
               AND (v_restored
                    OR (NOT EXISTS (SELECT 1 FROM audit.teacher_role_event e
                                    WHERE e.role_id = r.id AND e.role = 'admin' AND e.kind = 'confirmed'
                                      AND e.xmin = r.xmin)
                        AND NOT EXISTS (SELECT 1 FROM audit.institution_admin_event e
                                        WHERE e.role_id = r.id AND e.kind = 'appointed' AND e.xmin = r.xmin))
                    OR EXISTS (SELECT 1 FROM audit.teacher_role_event e
                               WHERE e.role_id = r.id AND e.kind = 'revoked'))) THEN
    RAISE EXCEPTION 'administrator not appointed by the operator' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION institution.admin_appoint_admin(uuid), institution.check_admin_event_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION institution.admin_appoint_admin(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- An administrator this path appointed is refused again by the old check at
-- the next write of their row.
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
GRANT CREATE ON SCHEMA institution TO ductus_identity;
SET LOCAL ROLE ductus_identity;
CREATE OR REPLACE FUNCTION institution.check_admin_appointment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_restored boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_restored := OLD.revoked_at IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM institution.institution_role r
             WHERE r.id = NEW.id AND r.role = 'admin' AND r.confirmed_at IS NOT NULL AND r.revoked_at IS NULL
               AND (v_restored
                    OR NOT EXISTS (SELECT 1 FROM audit.teacher_role_event e
                                   WHERE e.role_id = r.id AND e.role = 'admin' AND e.kind = 'confirmed'
                                     AND e.xmin = r.xmin)
                    OR EXISTS (SELECT 1 FROM audit.teacher_role_event e
                               WHERE e.role_id = r.id AND e.kind = 'revoked'))) THEN
    RAISE EXCEPTION 'administrator not appointed by the operator' USING ERRCODE = 'ZD409';
  END IF;
  RETURN NULL;
END
$$;
DROP FUNCTION institution.admin_appoint_admin(uuid);
DROP TABLE audit.institution_admin_event;
DROP FUNCTION institution.check_admin_event_actor();
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
REVOKE CREATE ON SCHEMA institution FROM ductus_identity;
