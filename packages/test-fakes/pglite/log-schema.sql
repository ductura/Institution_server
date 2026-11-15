-- U9-b (DAN-741): temporary schema of the fake log database, until S-1F brings
-- the migrations of the log database (db/logs/migrations); S-1F deletes this
-- file and the fake applies those migrations instead (log.test.ts fails while
-- both exist). Append-only: the writer has INSERT and SELECT only, and the
-- triggers refuse UPDATE, DELETE and TRUNCATE for everyone, also the owner, a
-- superuser and session_replication_role = replica (ENABLE ALWAYS).
CREATE ROLE fake_logs_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE fake_logs_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA logs AUTHORIZATION fake_logs_owner;
REVOKE ALL ON SCHEMA logs FROM PUBLIC;

SET ROLE fake_logs_owner;
CREATE TABLE logs.entry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind <> ''),
  payload jsonb NOT NULL
);
CREATE FUNCTION logs.refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'logs.entry is append-only: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER entry_no_change BEFORE UPDATE OR DELETE ON logs.entry
  FOR EACH ROW EXECUTE FUNCTION logs.refuse_change();
CREATE TRIGGER entry_no_truncate BEFORE TRUNCATE ON logs.entry
  FOR EACH STATEMENT EXECUTE FUNCTION logs.refuse_change();
ALTER TABLE logs.entry ENABLE ALWAYS TRIGGER entry_no_change;
ALTER TABLE logs.entry ENABLE ALWAYS TRIGGER entry_no_truncate;
REVOKE ALL ON logs.entry FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON logs.entry FROM fake_logs_owner;
GRANT USAGE ON SCHEMA logs TO fake_logs_writer;
GRANT SELECT, INSERT ON logs.entry TO fake_logs_writer;
RESET ROLE;
