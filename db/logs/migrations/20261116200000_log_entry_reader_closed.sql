-- migrate:up
-- S-1K.5-a (DAN-835, part 835-4): the reader (the operator's read role) no
-- longer reads public.log_entry itself, whose payload holds the full IP. It
-- reads the log only through operator_log (835-1), which masks it, and
-- verifies the chain through log_chain_verify, which gives seq and problem
-- only. Both now run as their owner, the migrator, which reads the table by a
-- policy of its own (RLS is forced on the owner too). Their search path is
-- pg_catalog, then pg_temp, and every object they read is qualified, so a
-- caller has nothing to plant: no logs role may create in any schema.
-- EXECUTE of the two stays as it was: the reader and the owner.
--
-- The head hash and log_entry_digest cover the full payload: with the rest of
-- a row from operator_log (seq, at, kind, the /24) the reader could try the
-- 256 addresses of a /24 against them. So the reader loses the head and the
-- digest too; the verification reads both as the owner.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE POLICY log_entry_owner_read ON public.log_entry FOR SELECT TO ductus_logs_migrator
  USING (true);
DROP POLICY log_entry_read ON public.log_entry;
REVOKE ALL ON public.log_entry FROM ductus_logs_reader;
DROP POLICY log_chain_head_read ON public.log_chain_head;
REVOKE ALL ON public.log_chain_head FROM ductus_logs_reader;
REVOKE ALL ON FUNCTION public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb) FROM ductus_logs_reader;

ALTER FUNCTION public.operator_log(timestamptz, timestamptz, bigint)
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.log_chain_verify()
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- migrate:down
GRANT EXECUTE ON FUNCTION public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb) TO ductus_logs_reader;
GRANT SELECT ON public.log_chain_head TO ductus_logs_reader;
CREATE POLICY log_chain_head_read ON public.log_chain_head FOR SELECT TO ductus_logs_reader
  USING (true);
ALTER FUNCTION public.log_chain_verify()
  SECURITY INVOKER SET search_path = pg_catalog;
ALTER FUNCTION public.operator_log(timestamptz, timestamptz, bigint)
  SECURITY INVOKER SET search_path = pg_catalog;
GRANT SELECT ON public.log_entry TO ductus_logs_reader;
CREATE POLICY log_entry_read ON public.log_entry FOR SELECT TO ductus_logs_reader
  USING (true);
DROP POLICY log_entry_owner_read ON public.log_entry;
