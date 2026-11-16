-- migrate:up
-- S-1K.2-b (DAN-816): the chain over the log table. Every row carries its
-- place in the chain (seq, from 1 with no gap), the digest of the row before
-- it (prev_hash; 32 zero bytes for the first) and its own digest (hash), so a
-- changed, deleted or inserted row breaks the chain where it stands, and
-- public.log_chain_verify() finds it. Plan of attack: ductura/server#125.
--
-- - The digest is SHA-256 over prev_hash and the row: seq, id and the time in
--   microseconds as 8 bytes each, the length of kind as 4 bytes, kind, and the
--   text of payload (jsonb prints one way). No session setting changes it.
-- - The head of the chain (last seq and hash) is the one row of
--   public.log_chain_head. The insert trigger locks it, so appends queue up:
--   under READ COMMITTED each one chains on the one before; under REPEATABLE
--   READ or SERIALIZABLE a concurrent append fails with 40001 rather than
--   fork the chain. A rolled back append rolls back the head with it, so no
--   seq is lost. The trigger sets seq, prev_hash, hash and at itself; values
--   anyone gave are overwritten.
-- - Changing every row after a point and the head together is not caught
--   inside this database; that takes an anchor outside it (not this step).
--
-- log_entry must be empty: the new columns are NOT NULL, so ALTER TABLE stops
-- on any row, and no chain is invented for rows written without one.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

ALTER TABLE public.log_entry
  ADD COLUMN seq bigint NOT NULL CONSTRAINT log_entry_seq_positive CHECK (seq >= 1),
  ADD COLUMN prev_hash bytea NOT NULL CONSTRAINT log_entry_prev_hash_size CHECK (pg_catalog.octet_length(prev_hash) = 32),
  ADD COLUMN hash bytea NOT NULL CONSTRAINT log_entry_hash_size CHECK (pg_catalog.octet_length(hash) = 32),
  -- One row per place and one successor per row: the chain cannot fork.
  ADD CONSTRAINT log_entry_seq_unique UNIQUE (seq),
  ADD CONSTRAINT log_entry_prev_hash_unique UNIQUE (prev_hash);

CREATE TABLE public.log_chain_head (
  only_row boolean PRIMARY KEY DEFAULT true CONSTRAINT log_chain_head_one_row CHECK (only_row),
  seq bigint NOT NULL CONSTRAINT log_chain_head_seq CHECK (seq >= 0),
  hash bytea NOT NULL CONSTRAINT log_chain_head_hash_size CHECK (pg_catalog.octet_length(hash) = 32)
);
INSERT INTO public.log_chain_head (seq, hash) VALUES (0, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex'));

CREATE FUNCTION public.log_entry_digest(
  prev_hash bytea, seq bigint, id bigint, at timestamptz, kind text, payload jsonb
) RETURNS bytea
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS $$
  SELECT pg_catalog.sha256(
    prev_hash
    OPERATOR(pg_catalog.||) pg_catalog.int8send(seq)
    OPERATOR(pg_catalog.||) pg_catalog.int8send(id)
    OPERATOR(pg_catalog.||) pg_catalog.int8send(
      (pg_catalog.extract('epoch', at) OPERATOR(pg_catalog.*) 1000000)::bigint)
    OPERATOR(pg_catalog.||) pg_catalog.int4send(pg_catalog.octet_length(kind))
    OPERATOR(pg_catalog.||) pg_catalog.convert_to(kind, 'UTF8')
    OPERATOR(pg_catalog.||) pg_catalog.convert_to(payload::text, 'UTF8'))
$$;

CREATE FUNCTION public.log_entry_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  head record;
BEGIN
  SELECT h.seq, h.hash INTO STRICT head FROM public.log_chain_head h FOR UPDATE;
  NEW.at := pg_catalog.clock_timestamp();
  NEW.seq := head.seq OPERATOR(pg_catalog.+) 1;
  NEW.prev_hash := head.hash;
  NEW.hash := public.log_entry_digest(NEW.prev_hash, NEW.seq, NEW.id, NEW.at, NEW.kind, NEW.payload);
  -- A NULL kind or payload leaves the digest NULL; the NOT NULL of that
  -- column refuses the row, and the head stays.
  IF NEW.hash IS NOT NULL THEN
    UPDATE public.log_chain_head SET seq = NEW.seq, hash = NEW.hash;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER log_entry_chain BEFORE INSERT ON public.log_entry
  FOR EACH ROW EXECUTE FUNCTION public.log_entry_chain();
ALTER TABLE public.log_entry ENABLE ALWAYS TRIGGER log_entry_chain;

-- The head moves only from the insert trigger (trigger depth 2) and only one
-- step on; it is never added, removed or emptied.
CREATE FUNCTION public.log_chain_head_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_catalog.pg_trigger_depth() OPERATOR(pg_catalog.>) 1
     AND NEW.only_row AND OLD.only_row
     AND NEW.seq OPERATOR(pg_catalog.=) (OLD.seq OPERATOR(pg_catalog.+) 1) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'log_chain_head moves only with an append: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER log_chain_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.log_chain_head
  FOR EACH ROW EXECUTE FUNCTION public.log_chain_head_guard();
CREATE TRIGGER log_chain_head_no_truncate BEFORE TRUNCATE ON public.log_chain_head
  FOR EACH STATEMENT EXECUTE FUNCTION public.log_chain_head_guard();
ALTER TABLE public.log_chain_head ENABLE ALWAYS TRIGGER log_chain_head_guard;
ALTER TABLE public.log_chain_head ENABLE ALWAYS TRIGGER log_chain_head_no_truncate;

ALTER TABLE public.log_chain_head ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
-- The insert trigger runs as the owner and reads and moves the head.
CREATE POLICY log_chain_head_chain_read ON public.log_chain_head FOR SELECT TO ductus_logs_migrator
  USING (true);
CREATE POLICY log_chain_head_chain_move ON public.log_chain_head FOR UPDATE TO ductus_logs_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY log_chain_head_read ON public.log_chain_head FOR SELECT TO ductus_logs_reader
  USING (true);

REVOKE ALL ON public.log_chain_head FROM PUBLIC;
REVOKE INSERT, DELETE, TRUNCATE ON public.log_chain_head FROM ductus_logs_migrator;
GRANT SELECT ON public.log_chain_head TO ductus_logs_reader;

-- Every break of the chain, one row per place and kind, ordered; an intact
-- chain gives none. hash: the row's digest is not its content's; link: its
-- prev_hash is not the digest of the row before; gap: its seq does not follow
-- the one before (or the first is not 1); head: the head is not the last row.
CREATE FUNCTION public.log_chain_verify() RETURNS TABLE (seq bigint, problem text)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
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

REVOKE ALL ON FUNCTION public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_entry_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_chain_head_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_chain_verify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb) TO ductus_logs_reader;
GRANT EXECUTE ON FUNCTION public.log_chain_verify() TO ductus_logs_reader;

-- migrate:down
DROP FUNCTION public.log_chain_verify();
DROP TABLE public.log_chain_head;
DROP FUNCTION public.log_chain_head_guard();
DROP TRIGGER log_entry_chain ON public.log_entry;
DROP FUNCTION public.log_entry_chain();
DROP FUNCTION public.log_entry_digest(bytea, bigint, bigint, timestamptz, text, jsonb);
ALTER TABLE public.log_entry
  DROP CONSTRAINT log_entry_prev_hash_unique,
  DROP CONSTRAINT log_entry_seq_unique,
  DROP COLUMN hash,
  DROP COLUMN prev_hash,
  DROP COLUMN seq;
