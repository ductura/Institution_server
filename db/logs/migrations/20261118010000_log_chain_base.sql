-- migrate:up
-- S-1K.8 (DAN-868, part 868-1a): the base of the log chain. Deletion by
-- retention (868-2) takes the oldest rows of public.log_entry away as a whole
-- prefix of the chain; public.log_chain_base will hold where that prefix
-- ended: the seq and hash of the last row cut away, seq 0 and 32 zero bytes
-- while nothing is cut. Verifying the chain from it is part 868-1b; moving it
-- with the cut is 868-2.
--
-- In this part no write changes the base. Two triggers ENABLE ALWAYS refuse
-- it, a superuser and session_replication_role = replica included:
-- - at statement level, every INSERT, UPDATE, DELETE and TRUNCATE naming the
--   base, before a row is touched, so one that would touch no row (WHERE
--   false) is refused too, as are MERGE, COPY and INSERT ... ON CONFLICT;
-- - at row level, every row write that does not pass the statement trigger
--   of the base: through an inheritance or partitioned parent the statement
--   names, and the apply of logical replication, which fires row triggers
--   only.
-- No role holds a right to write it, and only the owner reads it, by a
-- policy of its own (for the verification of 868-1b). DDL by the owner or a
-- superuser (dropping or disabling a trigger, ALTER COLUMN TYPE ... USING,
-- a child table, RENAME) stays outside, as for the head (#125).
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE TABLE public.log_chain_base (
  only_row boolean PRIMARY KEY DEFAULT true CONSTRAINT log_chain_base_one_row CHECK (only_row),
  seq bigint NOT NULL CONSTRAINT log_chain_base_seq CHECK (seq >= 0),
  hash bytea NOT NULL CONSTRAINT log_chain_base_hash_size CHECK (pg_catalog.octet_length(hash) = 32)
);
INSERT INTO public.log_chain_base (seq, hash) VALUES (0, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex'));

CREATE FUNCTION public.log_chain_base_refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'log_chain_base does not change: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION public.log_chain_base_refuse_change() FROM PUBLIC;

CREATE TRIGGER log_chain_base_no_change BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.log_chain_base
  FOR EACH STATEMENT EXECUTE FUNCTION public.log_chain_base_refuse_change();
CREATE TRIGGER log_chain_base_no_row_change BEFORE INSERT OR UPDATE OR DELETE ON public.log_chain_base
  FOR EACH ROW EXECUTE FUNCTION public.log_chain_base_refuse_change();
ALTER TABLE public.log_chain_base ENABLE ALWAYS TRIGGER log_chain_base_no_change;
ALTER TABLE public.log_chain_base ENABLE ALWAYS TRIGGER log_chain_base_no_row_change;

ALTER TABLE public.log_chain_base ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY log_chain_base_owner_read ON public.log_chain_base FOR SELECT TO ductus_logs_migrator
  USING (true);

REVOKE ALL ON public.log_chain_base FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.log_chain_base FROM ductus_logs_migrator;

-- migrate:down
DROP TABLE public.log_chain_base;
DROP FUNCTION public.log_chain_base_refuse_change();
