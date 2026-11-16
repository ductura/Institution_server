-- migrate:up
-- S-1K.2-a (DAN-813): the log table of the logs database, append-only. One
-- row per record the log writer (server/log/writer.ts) accepts: `kind` is the
-- event of the catalogue (server/log/events, S-1K.1), `payload` the checked
-- and redacted record. The chain over the rows is S-1K.2-b; deletion by
-- retention is S-1K.8 and gets its own path.
--
-- Append-only in three layers:
-- - rights: the writer may only INSERT kind and payload (it cannot forge the
--   id or the time, and cannot read the history); the reader may only SELECT;
--   the retention role, PUBLIC and every other role hold nothing; the owner
--   (the migrator) gives up UPDATE, DELETE and TRUNCATE;
-- - RLS, enabled and forced, with one policy per right;
-- - triggers ENABLE ALWAYS that refuse UPDATE, DELETE and TRUNCATE for
--   everyone, a superuser and session_replication_role = replica included.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE TABLE public.log_entry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  -- "<area>.<name>" in lower case, as every kind of the catalogue is
  -- (server/log/writer.integration.test.ts stores one of each kind through
  -- the fake log database, which runs these migrations).
  kind text NOT NULL CONSTRAINT log_entry_kind_shape CHECK (
    pg_catalog.length(kind) <= 64
    AND kind OPERATOR(pg_catalog.~) '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  payload jsonb NOT NULL CONSTRAINT log_entry_payload_shape CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND pg_catalog.octet_length(payload::text) <= 16384
  )
);

CREATE FUNCTION public.log_entry_refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'log_entry is append-only: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION public.log_entry_refuse_change() FROM PUBLIC;

CREATE TRIGGER log_entry_no_change BEFORE UPDATE OR DELETE ON public.log_entry
  FOR EACH ROW EXECUTE FUNCTION public.log_entry_refuse_change();
CREATE TRIGGER log_entry_no_truncate BEFORE TRUNCATE ON public.log_entry
  FOR EACH STATEMENT EXECUTE FUNCTION public.log_entry_refuse_change();
ALTER TABLE public.log_entry ENABLE ALWAYS TRIGGER log_entry_no_change;
ALTER TABLE public.log_entry ENABLE ALWAYS TRIGGER log_entry_no_truncate;

ALTER TABLE public.log_entry ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY log_entry_append ON public.log_entry FOR INSERT TO ductus_logs_writer
  WITH CHECK (true);
CREATE POLICY log_entry_read ON public.log_entry FOR SELECT TO ductus_logs_reader
  USING (true);

REVOKE ALL ON public.log_entry FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.log_entry FROM ductus_logs_migrator;
GRANT INSERT (kind, payload) ON public.log_entry TO ductus_logs_writer;
GRANT SELECT ON public.log_entry TO ductus_logs_reader;

-- migrate:down
DROP TABLE public.log_entry;
DROP FUNCTION public.log_entry_refuse_change();
