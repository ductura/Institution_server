-- DAN-809 (S-1J-c; contract on Ductus#1836, comment 6906300892, confirmed in
-- 6906371365): the rule of server/roles/permissions.ts for
-- assign_admin_network_engineer_roles x institution_admin = own_institution,
-- for its network engineer half (D-297, amending D-262 Q04). Appointing the
-- institution's administrators stays the operator procedure of 20261104130000
-- until its own step.
--
-- - identity.appoint_network_engineer(user) and
--   identity.revoke_network_engineer(user): only a confirmed administrator of
--   the caller's own institution, from the session. A person who does not
--   exist, is of another institution or is the caller is refused with the
--   same ZD403, so the answer does not tell which. Revoking someone with no
--   active appointment, of another institution included, answers false and
--   changes nothing. A call that changes nothing writes nothing.
-- - audit.network_engineer_event: one append-only row per appointment and
--   kind, written in the same statement as the change, with the administrator
--   from the session. As audit.teacher_role_event (DAN-497): owner-only,
--   forced RLS, bound to the appointment row it records.
-- migrate:up

SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;

-- The target of the composite key below. id alone is already unique; this
-- adds no new rule to the appointment table, which no function has written
-- before this migration.
-- squawk-ignore constraint-missing-not-valid, disallowed-unique-constraint
ALTER TABLE identity.network_engineer_appointment
  ADD CONSTRAINT network_engineer_appointment_binding_key UNIQUE (id, institution_id, user_id);

CREATE TABLE audit.network_engineer_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  engineer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('appointed', 'revoked')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (appointment_id, kind),
  CONSTRAINT network_engineer_event_appointment_fkey FOREIGN KEY (appointment_id, institution_id, engineer_id)
    REFERENCES identity.network_engineer_appointment (id, institution_id, user_id),
  FOREIGN KEY (engineer_id, institution_id) REFERENCES identity.user_account (id, institution_id),
  FOREIGN KEY (actor_id, institution_id) REFERENCES identity.user_account (id, institution_id)
);
CREATE INDEX network_engineer_event_institution_idx ON audit.network_engineer_event (institution_id, occurred_at);
CREATE INDEX network_engineer_event_engineer_idx ON audit.network_engineer_event (engineer_id, institution_id);
CREATE INDEX network_engineer_event_actor_idx ON audit.network_engineer_event (actor_id, institution_id);

CREATE TRIGGER network_engineer_event_append_only BEFORE UPDATE OR DELETE ON audit.network_engineer_event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER network_engineer_event_no_truncate BEFORE TRUNCATE ON audit.network_engineer_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE audit.network_engineer_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.network_engineer_event FORCE ROW LEVEL SECURITY;
CREATE POLICY network_engineer_event_owner ON audit.network_engineer_event
  TO ductus_identity USING (true) WITH CHECK (true);

-- true when this call appointed the person; false when they already were.
CREATE FUNCTION identity.appoint_network_engineer(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_written integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin')
     OR p_user_id IS NULL
     OR p_user_id = actor.user_id
     OR NOT EXISTS (
       SELECT 1 FROM identity.user_account u
       WHERE u.id = p_user_id AND u.institution_id = actor.institution_id
     ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  WITH appointed AS (
    INSERT INTO identity.network_engineer_appointment (institution_id, user_id, appointed_by)
    VALUES (actor.institution_id, p_user_id, actor.user_id)
    ON CONFLICT (user_id, institution_id) WHERE revoked_at IS NULL DO NOTHING
    RETURNING id, institution_id, user_id, appointed_at
  )
  INSERT INTO audit.network_engineer_event (institution_id, appointment_id, engineer_id, kind, actor_id, occurred_at)
  SELECT appointed.institution_id, appointed.id, appointed.user_id, 'appointed', actor.user_id, appointed.appointed_at
  FROM appointed;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written > 0;
END
$$;

-- true when this call revoked an active appointment; false when there was none.
CREATE FUNCTION identity.revoke_network_engineer(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor record;
  v_written integer;
BEGIN
  SELECT * INTO actor FROM institution.require_actor();
  IF NOT institution.actor_has_role('admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;
  WITH revoked AS (
    -- now() is the start of this transaction; an appointment another
    -- administrator committed after that start would break its CHECK
    -- (revoked_at >= appointed_at), so the revocation is never earlier.
    UPDATE identity.network_engineer_appointment a SET revoked_at = greatest(now(), a.appointed_at)
     WHERE a.institution_id = actor.institution_id AND a.user_id = p_user_id AND a.revoked_at IS NULL
    RETURNING a.id, a.institution_id, a.user_id, a.revoked_at
  )
  INSERT INTO audit.network_engineer_event (institution_id, appointment_id, engineer_id, kind, actor_id, occurred_at)
  SELECT revoked.institution_id, revoked.id, revoked.user_id, 'revoked', actor.user_id, revoked.revoked_at
  FROM revoked;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written > 0;
END
$$;

REVOKE ALL ON FUNCTION identity.appoint_network_engineer(uuid), identity.revoke_network_engineer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.appoint_network_engineer(uuid), identity.revoke_network_engineer(uuid) TO ductus_app;

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
GRANT CREATE ON SCHEMA identity TO ductus_identity;
GRANT CREATE ON SCHEMA audit TO ductus_identity;
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.revoke_network_engineer(uuid);
DROP FUNCTION identity.appoint_network_engineer(uuid);
DROP TABLE audit.network_engineer_event;
ALTER TABLE identity.network_engineer_appointment DROP CONSTRAINT network_engineer_appointment_binding_key;
RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;
