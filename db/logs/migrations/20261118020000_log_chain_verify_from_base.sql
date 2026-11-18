-- migrate:up
-- S-1K.8 (DAN-868, part 868-1b): public.log_chain_verify() verifies the chain
-- from its base (public.log_chain_base, 868-1a2) instead of seq 0 and 32 zero
-- bytes: the first row must follow the base (gap, link), and where no row
-- gives the last seq or hash (none left, or only NULLs) the base's stand in,
-- as seq 0 and 32 zero bytes did before.
-- While nothing is cut the base is seq 0 and 32 zero bytes, and every chain,
-- however damaged, gives exactly what the verification of 20261116170000
-- (with 20261116200000) gave, wherever that one returns at all: on a seq at
-- the greatest bigint it failed with bigint out of range, and this one
-- reports. db/logs/tests/020-log-chain.sql compares the two on every damage
-- it knows.
--
-- What changes:
-- - The predecessor of the first row is lag's default, the base, as the zero
--   default was before; a NULL seq or hash inside the chain stays NULL. The
--   default is a scalar subquery, not a join, so the window sorts the same
--   rows as before: where seqs repeat (their unique constraint dropped) the
--   order of the repeated rows is the sort's, as it was.
-- - The last seq stays max(seq) and the last hash the hash of the row first
--   in seq DESC order, each with the base's in place of NULL.
-- - A base that is not exactly one row is reported as 'base' (seq NULL). The
--   chain is then verified from the base row with the greatest seq (a NULL
--   seq last, then the smallest hash), or from seq 0 and 32 zero bytes when
--   there is none: the base CTE is always exactly one row, so no state of
--   the base table can empty the verification. The base is read FROM ONLY,
--   so no child table adds to it.
-- - The gap is compared in numeric: no stored seq, the greatest bigint of a
--   base included, makes the verification fail instead of report.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.log_chain_verify() RETURNS TABLE (seq bigint, problem text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH base AS (
    SELECT x.seq, x.hash FROM (
      SELECT 0 AS fallback, b.seq, b.hash FROM ONLY public.log_chain_base b
      UNION ALL
      SELECT 1, 0::bigint, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')
    ) x
    ORDER BY x.fallback, x.seq DESC NULLS LAST, x.hash
    LIMIT 1
  ), entry AS (
    SELECT e.seq, e.prev_hash, e.hash,
           public.log_entry_digest(e.prev_hash, e.seq, e.id, e.at, e.kind, e.payload) AS computed,
           pg_catalog.lag(e.seq, 1, (SELECT b.seq FROM base b)) OVER w AS before_seq,
           pg_catalog.lag(e.hash, 1, (SELECT b.hash FROM base b)) OVER w AS before_hash
    FROM public.log_entry e
    WINDOW w AS (ORDER BY e.seq)
  ), last AS (
    SELECT coalesce((SELECT pg_catalog.max(e.seq) FROM public.log_entry e), base.seq) AS seq,
           coalesce((SELECT x.hash FROM public.log_entry x ORDER BY x.seq DESC LIMIT 1), base.hash) AS hash
    FROM base
  )
  SELECT x.seq, x.problem FROM (
    SELECT entry.seq, 'hash' AS problem FROM entry WHERE entry.hash IS DISTINCT FROM entry.computed
    UNION ALL
    SELECT entry.seq, 'link' FROM entry WHERE entry.prev_hash IS DISTINCT FROM entry.before_hash
    UNION ALL
    SELECT entry.seq, 'gap' FROM entry
    WHERE entry.seq::numeric IS DISTINCT FROM (entry.before_seq::numeric OPERATOR(pg_catalog.+) 1)
    UNION ALL
    SELECT h.seq, 'head' FROM public.log_chain_head h, last
    WHERE h.seq IS DISTINCT FROM last.seq OR h.hash IS DISTINCT FROM last.hash
    UNION ALL
    SELECT NULL::bigint, 'head' WHERE (SELECT pg_catalog.count(*) FROM public.log_chain_head) OPERATOR(pg_catalog.<>) 1
    UNION ALL
    SELECT NULL::bigint, 'base' WHERE (SELECT pg_catalog.count(*) FROM ONLY public.log_chain_base) OPERATOR(pg_catalog.<>) 1
  ) x
  ORDER BY x.seq NULLS FIRST, x.problem
$$;

-- migrate:down
-- The body of 20261116170000_log_chain.sql, with the owner rights of
-- 20261116200000_log_entry_reader_closed.sql.
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
