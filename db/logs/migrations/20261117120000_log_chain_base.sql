-- migrate:up
-- S-1K.8 (DAN-868, part 868-1): the base of the log chain. Deletion by
-- retention (868-2) takes the oldest rows of public.log_entry away as a whole
-- prefix of the chain; public.log_chain_verify() then has to start where that
-- prefix ended, not at seq 0 and 32 zero bytes, or every cut would read as a
-- deleted row. public.log_chain_base is that start: the seq and hash of the
-- last row cut away; seq 0 and 32 zero bytes while nothing is cut, so a chain
-- without a cut verifies exactly as before.
--
-- In this part nothing moves the base: a trigger ENABLE ALWAYS refuses every
-- INSERT, UPDATE, DELETE and TRUNCATE, a superuser and
-- session_replication_role = replica included, and no role holds a right to
-- write it. The verification reads it as the owner, by a policy of its own;
-- no other role reads it. Moving it forward with the cut is 868-2.
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

CREATE TRIGGER log_chain_base_guard BEFORE INSERT OR UPDATE OR DELETE ON public.log_chain_base
  FOR EACH ROW EXECUTE FUNCTION public.log_chain_base_refuse_change();
CREATE TRIGGER log_chain_base_no_truncate BEFORE TRUNCATE ON public.log_chain_base
  FOR EACH STATEMENT EXECUTE FUNCTION public.log_chain_base_refuse_change();
ALTER TABLE public.log_chain_base ENABLE ALWAYS TRIGGER log_chain_base_guard;
ALTER TABLE public.log_chain_base ENABLE ALWAYS TRIGGER log_chain_base_no_truncate;

ALTER TABLE public.log_chain_base ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY log_chain_base_owner_read ON public.log_chain_base FOR SELECT TO ductus_logs_migrator
  USING (true);

REVOKE ALL ON public.log_chain_base FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.log_chain_base FROM ductus_logs_migrator;

-- As 20261116170000_log_chain.sql, from the base instead of seq 0 and 32
-- zero bytes: the first row must follow the base (gap, link), and with no row
-- left the head must be the base. A base that is not one row is reported as
-- 'base' (seq NULL), and the chain is then verified from the greatest base
-- row, or from seq 0 and 32 zero bytes when there is none, so the
-- verification never fails on it.
CREATE OR REPLACE FUNCTION public.log_chain_verify() RETURNS TABLE (seq bigint, problem text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH base AS (
    SELECT x.seq, x.hash FROM (
      SELECT b.seq, b.hash FROM public.log_chain_base b
      UNION ALL
      SELECT 0::bigint, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')
      WHERE NOT EXISTS (SELECT 1 FROM public.log_chain_base)
    ) x
    ORDER BY x.seq DESC, x.hash
    LIMIT 1
  ), entry AS (
    SELECT e.seq, e.prev_hash, e.hash,
           public.log_entry_digest(e.prev_hash, e.seq, e.id, e.at, e.kind, e.payload) AS computed,
           coalesce(pg_catalog.lag(e.seq) OVER w, base.seq) AS before_seq,
           coalesce(pg_catalog.lag(e.hash) OVER w, base.hash) AS before_hash
    FROM public.log_entry e CROSS JOIN base
    WINDOW w AS (ORDER BY e.seq)
  ), last AS (
    SELECT coalesce((SELECT x.seq FROM public.log_entry x ORDER BY x.seq DESC LIMIT 1), base.seq) AS seq,
           coalesce((SELECT x.hash FROM public.log_entry x ORDER BY x.seq DESC LIMIT 1), base.hash) AS hash
    FROM base
  )
  SELECT x.seq, x.problem FROM (
    SELECT entry.seq, 'hash' AS problem FROM entry WHERE entry.hash IS DISTINCT FROM entry.computed
    UNION ALL
    SELECT entry.seq, 'link' FROM entry WHERE entry.prev_hash IS DISTINCT FROM entry.before_hash
    UNION ALL
    SELECT entry.seq, 'gap' FROM entry
    WHERE entry.seq IS DISTINCT FROM (entry.before_seq OPERATOR(pg_catalog.+) 1)
    UNION ALL
    SELECT h.seq, 'head' FROM public.log_chain_head h, last
    WHERE h.seq IS DISTINCT FROM last.seq OR h.hash IS DISTINCT FROM last.hash
    UNION ALL
    SELECT NULL::bigint, 'head' WHERE (SELECT pg_catalog.count(*) FROM public.log_chain_head) OPERATOR(pg_catalog.<>) 1
    UNION ALL
    SELECT NULL::bigint, 'base' WHERE (SELECT pg_catalog.count(*) FROM public.log_chain_base) OPERATOR(pg_catalog.<>) 1
  ) x
  ORDER BY x.seq NULLS FIRST, x.problem
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION public.log_chain_verify() RETURNS TABLE (seq bigint, problem text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH entry AS (
    SELECT e.seq, e.prev_hash, e.hash,
           public.log_entry_digest(e.prev_hash, e.seq, e.id, e.at, e.kind, e.payload) AS computed,
           pg_catalog.lag(e.seq, 1, 0::bigint) OVER w AS before_seq,
           pg_catalog.lag(e.hash, 1, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')) OVER w AS before_hash
    FROM public.log_entry e
    WINDOW w AS (ORDER BY e.seq)
  ), last AS (
    SELECT coalesce(pg_catalog.max(e.seq), 0) AS seq,
           coalesce((SELECT x.hash FROM public.log_entry x ORDER BY x.seq DESC LIMIT 1),
                    pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')) AS hash
    FROM public.log_entry e
  )
  SELECT x.seq, x.problem FROM (
    SELECT entry.seq, 'hash' AS problem FROM entry WHERE entry.hash IS DISTINCT FROM entry.computed
    UNION ALL
    SELECT entry.seq, 'link' FROM entry WHERE entry.prev_hash IS DISTINCT FROM entry.before_hash
    UNION ALL
    SELECT entry.seq, 'gap' FROM entry
    WHERE entry.seq IS DISTINCT FROM (entry.before_seq OPERATOR(pg_catalog.+) 1)
    UNION ALL
    SELECT h.seq, 'head' FROM public.log_chain_head h, last
    WHERE h.seq IS DISTINCT FROM last.seq OR h.hash IS DISTINCT FROM last.hash
    UNION ALL
    SELECT NULL::bigint, 'head' WHERE (SELECT pg_catalog.count(*) FROM public.log_chain_head) OPERATOR(pg_catalog.<>) 1
  ) x
  ORDER BY x.seq NULLS FIRST, x.problem
$$;
DROP TABLE public.log_chain_base;
DROP FUNCTION public.log_chain_base_refuse_change();
