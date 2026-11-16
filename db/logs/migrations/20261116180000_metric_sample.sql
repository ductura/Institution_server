-- migrate:up
-- S-1K.4-a (DAN-833): the metric samples of the logs database, append-only as
-- public.log_entry is (S-1K.2-a). One row per sample: the metric, its value
-- and its labels, each from a closed list, so no free text and no personal
-- data has a column to land in. The writer of the samples is S-1K.4-b;
-- deletion by retention is S-1K.8.
--
-- - metric: the names of the event metrics.collected (server/log/events/catalog.ts);
-- - value: a count, 0 to 2^53 - 1, as COUNT of that catalogue;
-- - labels: a JSON object with at most the keys database (the databases of
--   scripts/db/databases.ts) and service (SERVICE of that catalogue), each a
--   string of its list; {} for none. Which key goes with which metric is the
--   writer's (S-1K.4-b).
--
-- Rights, RLS and the refusing triggers are those of log_entry: the writer
-- may only INSERT metric, value and labels; the reader (the operator's read
-- role) may only SELECT; the retention role, PUBLIC and every other role hold
-- nothing; nobody, a superuser included, changes or deletes a row.
DO $$
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;
END
$$;

CREATE TABLE public.metric_sample (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  metric text NOT NULL CONSTRAINT metric_sample_metric_listed CHECK (
    metric OPERATOR(pg_catalog.=) ANY (ARRAY[
      'request_count', 'error_count', 'latency_p95_ms', 'active_sessions',
      'queue_depth', 'disk_free_percent', 'database_connections'
    ])
  ),
  value bigint NOT NULL CONSTRAINT metric_sample_value_count CHECK (
    value OPERATOR(pg_catalog.>=) 0 AND value OPERATOR(pg_catalog.<=) 9007199254740991
  ),
  -- The closed list of labels. A value that is not a string never equals one
  -- of the list (jsonb compares type and value); a non-object is refused
  -- before an operator that fails on a scalar is reached.
  labels jsonb NOT NULL DEFAULT '{}' CONSTRAINT metric_sample_labels_listed CHECK (
    CASE WHEN pg_catalog.jsonb_typeof(labels) OPERATOR(pg_catalog.=) 'object' THEN
      labels OPERATOR(pg_catalog.-) ARRAY['database', 'service'] OPERATOR(pg_catalog.=) '{}'::jsonb
      AND coalesce(labels OPERATOR(pg_catalog.->) 'database' OPERATOR(pg_catalog.=) ANY (
        ARRAY['"main"', '"logs"', '"legal"']::jsonb[]), true)
      AND coalesce(labels OPERATOR(pg_catalog.->) 'service' OPERATOR(pg_catalog.=) ANY (
        ARRAY['"srce_auth"', '"storage"', '"keys"', '"email"']::jsonb[]), true)
    ELSE false END
  )
);

CREATE FUNCTION public.metric_sample_refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'metric_sample is append-only: % refused', TG_OP USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION public.metric_sample_refuse_change() FROM PUBLIC;

CREATE TRIGGER metric_sample_no_change BEFORE UPDATE OR DELETE ON public.metric_sample
  FOR EACH ROW EXECUTE FUNCTION public.metric_sample_refuse_change();
CREATE TRIGGER metric_sample_no_truncate BEFORE TRUNCATE ON public.metric_sample
  FOR EACH STATEMENT EXECUTE FUNCTION public.metric_sample_refuse_change();
ALTER TABLE public.metric_sample ENABLE ALWAYS TRIGGER metric_sample_no_change;
ALTER TABLE public.metric_sample ENABLE ALWAYS TRIGGER metric_sample_no_truncate;

ALTER TABLE public.metric_sample ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_sample_append ON public.metric_sample FOR INSERT TO ductus_logs_writer
  WITH CHECK (true);
CREATE POLICY metric_sample_read ON public.metric_sample FOR SELECT TO ductus_logs_reader
  USING (true);

REVOKE ALL ON public.metric_sample FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.metric_sample FROM ductus_logs_migrator;
GRANT INSERT (metric, value, labels) ON public.metric_sample TO ductus_logs_writer;
GRANT SELECT ON public.metric_sample TO ductus_logs_reader;

-- migrate:down
DROP TABLE public.metric_sample;
DROP FUNCTION public.metric_sample_refuse_change();
