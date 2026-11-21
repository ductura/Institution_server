-- migrate:up
-- SRV-1301 (M10.0-S1; D-272 MQ05): the separate migration that narrows the
-- append-only guard of audit.access_log. A DELETE of a row passes only when
-- it runs as the table's owner (ductus_identity) and the row's tombstone is
-- already in evidence.erasure. The owner deletes only in app.access_log_erase,
-- which only the evidence role may call, and a tombstone is written only by
-- app.erasure_append (20261125100000), which only ductus_retention may call;
-- so a row of the access log is removed only through erasure_append and never
-- without its tombstone in the same transaction. Every other DELETE, by the
-- owner too, and every UPDATE still fail with ZD403; the TRUNCATE trigger
-- (access_log_no_truncate) is unchanged.
--
-- audit.reject_change() is unchanged: other audit tables and the assistant
-- tables still use it as it is.
SET LOCAL ROLE ductus_migrator;
-- Only while this migration runs; revoked at the end.
GRANT CREATE ON SCHEMA audit TO ductus_identity;

SET LOCAL ROLE ductus_identity;

-- Not a definer: current_user is the role that runs the DELETE. Only the
-- owner may delete from the table at all (forced RLS with the owner's policy
-- only); the tombstone check runs only for the owner, as the only role
-- allowed to execute app.erasure_recorded.
CREATE FUNCTION audit.access_log_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'ductus_identity' THEN
    IF app.erasure_recorded('access_log', OLD.id::text) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'append-only row' USING ERRCODE = 'ZD403';
END
$$;
REVOKE ALL ON FUNCTION audit.access_log_guard() FROM PUBLIC;

-- The trigger keeps its name; only its function changes. Both statements run
-- in the one transaction of this migration, so there is no moment without a
-- guard.
DROP TRIGGER access_log_append_only ON audit.access_log;
CREATE TRIGGER access_log_append_only BEFORE UPDATE OR DELETE ON audit.access_log
  FOR EACH ROW EXECUTE FUNCTION audit.access_log_guard();

RESET ROLE;
SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA audit FROM ductus_identity;

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
DROP TRIGGER access_log_append_only ON audit.access_log;
CREATE TRIGGER access_log_append_only BEFORE UPDATE OR DELETE ON audit.access_log
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
DROP FUNCTION audit.access_log_guard();
RESET ROLE;
