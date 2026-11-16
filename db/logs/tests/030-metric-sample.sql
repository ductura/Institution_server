-- S-1K.4-a (DAN-833): public.metric_sample, the metric samples of the logs
-- database. Its row of the access matrix (the writer only appends, only the
-- reader, the operator's read role, reads; nothing to PUBLIC, to the
-- retention role or to the role of the main application), the refusals of
-- UPDATE, DELETE and TRUNCATE for every role, a superuser included, and the
-- closed lists: a metric, a label key or a label value outside them is
-- refused, so no free text has a column to land in. Rows other tests left
-- may be there: the rows of this file are those after the last id found.
--
-- The search path and the guard against planted functions are those of
-- 000-rls-everywhere.sql. The file rolls back, so nothing stays.
BEGIN;
-- Nothing below resolves through the caller's search path: "$user" or any
-- schema before pgTAP's could hold a planted is_empty, ok or operator. The
-- path is pg_catalog, pg_temp (so the helper views below, which are also
-- named with pg_temp., come before anything in pgTAP's schema), then the
-- schema pgTAP lives in, and nothing else. pg_temp is never searched for
-- functions or operators.
SET LOCAL search_path TO pg_catalog, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA public;
SET LOCAL lc_messages TO 'C';
-- pgTAP's schema can also hold objects that are not pgTAP's (the migrator
-- owns each database and may create in public): a function there that is not
-- part of an extension and carries the name of a pgTAP or pg_catalog
-- function, or any such operator, could change what the assertions compute.
-- This raises rather than asserts, as a planted object could bend the
-- assertion itself.
DO $$
DECLARE
  tap_schema name;
  planted text;
BEGIN
  SELECT n.nspname INTO STRICT tap_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
  WHERE e.extname OPERATOR(pg_catalog.=) 'pgtap';
  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('pg_catalog, pg_temp, %I', tap_schema), true);

  SELECT pg_catalog.string_agg(x.found, ', ') INTO planted FROM (
    SELECT p.oid::pg_catalog.regprocedure::text AS found FROM pg_catalog.pg_proc p
    WHERE p.pronamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND p.pronamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) p.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                  WHERE q.proname OPERATOR(pg_catalog.=) p.proname
                    AND (q.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
                         OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                                    WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                                      AND d.objid OPERATOR(pg_catalog.=) q.oid
                                      AND d.deptype OPERATOR(pg_catalog.=) 'e')))
    UNION ALL
    SELECT o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND o.oprnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) o.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
  ) x;
  IF planted IS NOT NULL THEN
    RAISE EXCEPTION 'a function or operator beside pgTAP shadows pgTAP or pg_catalog: %', planted;
  END IF;
END
$$;

SELECT plan(109);

CREATE TABLE pg_temp.found_before AS SELECT coalesce(max(id), 0) AS id FROM public.metric_sample;
CREATE VIEW pg_temp.mine AS
  SELECT * FROM public.metric_sample WHERE id > (SELECT id FROM pg_temp.found_before);

-- As in 010-log-entry.sql: runs `sql` as `who` (NULL: the superuser), with
-- session_replication_role = replica when asked; the SQLSTATE, or 'ok'.
CREATE FUNCTION pg_temp.try_as(who text, sql text, replica boolean DEFAULT false) RETURNS text
  LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF replica THEN SET LOCAL session_replication_role = replica; END IF;
    IF who IS NOT NULL THEN EXECUTE pg_catalog.format('SET LOCAL ROLE %I', who); END IF;
    EXECUTE sql;
    RESET ROLE;
    SET LOCAL session_replication_role = origin;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
  END;
END
$$;

-- Every right on the table of a role that is not a superuser, or of PUBLIC,
-- inherited or by SET ROLE; a column right counts as the right.
CREATE VIEW pg_temp.sample_right AS
  SELECT DISTINCT r.rolname || ': ' || p.privilege
         || CASE WHEN g.rolname = r.rolname THEN '' ELSE ' via ' || g.rolname END AS found
  FROM (SELECT x.oid, x.rolname::text FROM pg_catalog.pg_roles x
        WHERE NOT x.rolsuper AND x.rolname NOT LIKE 'pg\_%'
        UNION ALL SELECT 0, 'public') AS r (oid, rolname)
  JOIN LATERAL (SELECT y.rolname::text FROM pg_catalog.pg_roles y
                WHERE r.oid = 0 AND y.oid = 0
                   OR r.oid <> 0 AND pg_has_role(r.oid, y.oid, 'MEMBER')
                UNION ALL SELECT 'public' WHERE r.oid = 0) AS g (rolname) ON true
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
              || CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p (privilege)
  WHERE has_table_privilege(g.rolname, 'public.metric_sample'::regclass, p.privilege)
     OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(g.rolname, 'public.metric_sample'::regclass, p.privilege));
CREATE TABLE pg_temp.expected_sample_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_sample_right VALUES
  ('ductus_logs_migrator: SELECT'), ('ductus_logs_migrator: INSERT'),
  ('ductus_logs_migrator: REFERENCES'), ('ductus_logs_migrator: TRIGGER'),
  ('ductus_logs_writer: INSERT'),
  ('ductus_logs_reader: SELECT');
INSERT INTO pg_temp.expected_sample_right
  SELECT 'ductus_logs_migrator: MAINTAIN' WHERE current_setting('server_version_num')::int >= 170000;
CREATE VIEW pg_temp.sample_drift AS
  (SELECT '+' || x.found AS found FROM (
     SELECT found FROM pg_temp.sample_right EXCEPT SELECT found FROM pg_temp.expected_sample_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (
     SELECT found FROM pg_temp.expected_sample_right EXCEPT SELECT found FROM pg_temp.sample_right) x);

-- 1. Refused first: nobody changes or deletes a row. Two rows to refuse on.
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.metric_sample (metric, value, labels)
     VALUES ('queue_depth', 3, '{}'), ('database_connections', 7, '{"database": "logs"}') $$),
  'ok', 'the writer appends samples of metric, value and labels');
SELECT is(pg_temp.try_as(w.who, s.sql), '42501', w.who || ' is refused: ' || s.sql)
FROM unnest(ARRAY['ductus_logs_writer', 'ductus_logs_migrator', 'ductus_logs_reader', 'ductus_logs_retention']) w (who)
CROSS JOIN unnest(ARRAY['UPDATE public.metric_sample SET value = 0', 'DELETE FROM public.metric_sample',
                        'TRUNCATE public.metric_sample']) s (sql);
SELECT is(pg_temp.try_as(NULL, s.sql, r.replica), '55000',
  'the superuser' || CASE WHEN r.replica THEN ' with session_replication_role = replica' ELSE '' END
  || ' is refused: ' || s.sql)
FROM unnest(ARRAY['UPDATE public.metric_sample SET labels = ''{}''', 'DELETE FROM public.metric_sample',
                  'TRUNCATE public.metric_sample']) s (sql)
CROSS JOIN unnest(ARRAY[false, true]) r (replica);
SELECT is(pg_temp.try_as('ductus_logs_writer', w.sql), '42501', 'the writer is refused: ' || w.sql)
FROM unnest(ARRAY[
  'SELECT 1 FROM public.metric_sample',
  'INSERT INTO public.metric_sample (metric, value) VALUES (''queue_depth'', 1) RETURNING id',
  'INSERT INTO public.metric_sample (id, metric, value) OVERRIDING SYSTEM VALUE VALUES (-5, ''queue_depth'', 1)',
  'INSERT INTO public.metric_sample (at, metric, value) VALUES (''1999-01-01'', ''queue_depth'', 1)',
  'INSERT INTO public.metric_sample (metric, value) VALUES (''queue_depth'', 1) ON CONFLICT (id) DO UPDATE SET value = 0',
  'MERGE INTO public.metric_sample m USING (SELECT 1 AS id) s ON m.id = s.id WHEN MATCHED THEN DELETE',
  'ALTER TABLE public.metric_sample DISABLE TRIGGER metric_sample_no_change',
  'ALTER TABLE public.metric_sample NO FORCE ROW LEVEL SECURITY',
  'ALTER TABLE public.metric_sample DROP CONSTRAINT metric_sample_labels_listed'
]) w (sql);
SELECT pg_temp.try_as('ductus_logs_writer', 'GRANT UPDATE, DELETE, TRUNCATE, SELECT ON public.metric_sample TO ductus_logs_writer');
SELECT is_empty('SELECT found FROM pg_temp.sample_drift', 'a GRANT by the writer to itself gives it nothing');
SELECT is((SELECT array_agg(metric || ' ' || value || ' ' || labels::text ORDER BY id) FROM pg_temp.mine),
  ARRAY['queue_depth 3 {}', 'database_connections 7 {"database": "logs"}'],
  'after every attempt the two samples stay, unchanged');

-- 2. Read only by the operator's read role.
SELECT is(pg_temp.try_as(w.who, 'SELECT 1 FROM public.metric_sample'), '42501', w.who || ' cannot read')
FROM unnest(ARRAY['ductus_logs_writer', 'ductus_logs_retention']) w (who);
SELECT is(pg_temp.try_as('ductus_logs_reader',
  'INSERT INTO public.metric_sample (metric, value) VALUES (''queue_depth'', 1)'), '42501', 'the reader cannot append');
SELECT is(pg_temp.try_as('ductus_logs_reader',
  $$ DO $d$ BEGIN
       IF (SELECT pg_catalog.array_agg(metric ORDER BY id) FROM public.metric_sample
           WHERE id > $$ || (SELECT id FROM pg_temp.found_before) || $$)
          IS DISTINCT FROM ARRAY['queue_depth', 'database_connections'] THEN
         RAISE EXCEPTION 'unexpected rows' USING ERRCODE = 'P0001';
       END IF;
     END $d$ $$),
  'ok', 'the reader reads the samples as written');
SELECT is_empty('SELECT found FROM pg_temp.sample_drift',
  'the access matrix: the writer only INSERTs, the reader only SELECTs, the owner has no UPDATE, DELETE or TRUNCATE, nobody else (PUBLIC, retention, any other role) holds a right, directly, by membership or SET ROLE');

SELECT set_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polpermissive::text || ' '
            || array_to_string(ARRAY(SELECT r::regrole::text FROM unnest(polroles) r ORDER BY 1), ',')
     FROM pg_policy WHERE polrelid = 'public.metric_sample'::regclass $$,
  ARRAY['metric_sample_append a true ductus_logs_writer', 'metric_sample_read r true ductus_logs_reader'],
  'RLS has two policies: INSERT for the writer, SELECT for the reader');

-- 3. The closed lists, as the writer. Raw control characters inside a JSON
-- string never reach the check (the JSON is invalid, 22P02); escaped ones do.
SELECT is(pg_temp.try_as('ductus_logs_writer', format(
  'INSERT INTO public.metric_sample (metric, value, labels) VALUES (%L, %s, %L::jsonb)',
  c.metric, coalesce(c.value::text, 'NULL'), c.labels)), c.expected, c.what)
FROM (VALUES
  ('request_count', 1::numeric, '{"region": "eu"}', '23514', 'a label key outside the list is refused'),
  ('request_count', 1, '{"status_class": "5xx"}', '23514', 'a label key not on the list, however plausible, is refused'),
  ('request_count', 1, '{"database": "x"}', '23514', 'a database outside the list is refused'),
  ('request_count', 1, '{"service": "sms"}', '23514', 'a service outside the list is refused'),
  ('request_count', 1, '{"service": "ana@example.org"}', '23514', 'free text as a label value is refused'),
  ('request_count', 1, '{"email": "ana@example.org"}', '23514', 'personal data under its own key is refused'),
  ('request_count', 1, '{"database": "main", "user": "x"}', '23514', 'a listed label beside an unlisted key is refused'),
  ('request_count', 1, '{"database": "Main"}', '23514', 'a label value in capitals is refused'),
  ('request_count', 1, '{"Database": "main"}', '23514', 'a label key in capitals is refused'),
  ('request_count', 1, '{"database": " main"}', '23514', 'a label value with a leading space is refused'),
  ('request_count', 1, '{"database": "main "}', '23514', 'a label value with a trailing space is refused'),
  ('request_count', 1, '{"database": "main\r\n"}', '23514', 'a label value with an escaped CRLF is refused'),
  ('request_count', 1, '{"database": "main\t"}', '23514', 'a label value with an escaped tab is refused'),
  ('request_count', 1, E'{"database": "main\r\n"}', '22P02', 'a label value with a raw CRLF is invalid JSON'),
  ('request_count', 1, E'{"database": "main\t"}', '22P02', 'a label value with a raw tab is invalid JSON'),
  ('request_count', 1, '{"database": "main' || chr(160) || '"}', '23514', 'a label value with a NBSP is refused'),
  ('request_count', 1, '{"database": "main\u00a0"}', '23514', 'a label value with an escaped NBSP is refused'),
  ('request_count', 1, '{"database": "main' || chr(127) || '"}', '23514', 'a label value with a DEL is refused'),
  ('request_count', 1, '{"database": "main\u0000"}', '22P05', 'a label value with NUL is refused by jsonb'),
  ('request_count', 1, '{"database' || chr(160) || '": "main"}', '23514', 'a label key with a NBSP is refused'),
  ('request_count', 1, '{"toString": "main"}', '23514', 'an inherited key (toString) is refused'),
  ('request_count', 1, '{"__proto__": "main"}', '23514', 'an inherited key (__proto__) is refused'),
  ('request_count', 1, '{"constructor": "main"}', '23514', 'an inherited key (constructor) is refused'),
  ('request_count', 1, '{"database.main": "main"}', '23514', 'a key that is a path is refused'),
  ('request_count', 1, '{"../database": "main"}', '23514', 'a key with ../ is refused'),
  ('request_count', 1, '{"C:\\database": "main"}', '23514', 'a key that is a Windows path is refused'),
  ('request_count', 1, '{"database": "C:\\main"}', '23514', 'a value that is a Windows path is refused'),
  ('request_count', 1, '{"database": 1}', '23514', 'a number as a label value is refused'),
  ('request_count', 1, '{"database": null}', '23514', 'null as a label value is refused'),
  ('request_count', 1, '{"database": true}', '23514', 'a boolean as a label value is refused'),
  ('request_count', 1, '{"database": ["main"]}', '23514', 'an array as a label value is refused'),
  ('request_count', 1, '{"database": {"name": "main"}}', '23514', 'an object as a label value is refused'),
  ('request_count', 1, '{"database": "main", "database": "evil"}', '23514', 'a repeated key keeps its last value, which is checked'),
  ('request_count', 1, '["database"]', '23514', 'labels as an array are refused'),
  ('request_count', 1, '"main"', '23514', 'labels as a string are refused'),
  ('request_count', 1, '1', '23514', 'labels as a number are refused'),
  ('request_count', 1, 'null', '23514', 'labels as JSON null are refused'),
  ('request_count', 1, NULL, '23502', 'labels as NULL are refused'),
  ('login_count', 1, '{}', '23514', 'a metric outside the list is refused'),
  ('metrics.collected', 1, '{}', '23514', 'the event name as a metric is refused'),
  ('', 1, '{}', '23514', 'an empty metric is refused'),
  (NULL, 1, '{}', '23502', 'a NULL metric is refused'),
  ('Request_count', 1, '{}', '23514', 'a metric in capitals is refused'),
  (' request_count', 1, '{}', '23514', 'a metric with a leading space is refused'),
  ('request_count' || E'\r\n', 1, '{}', '23514', 'a metric with a CRLF is refused'),
  ('request_count' || E'\t', 1, '{}', '23514', 'a metric with a tab is refused'),
  ('request_count' || chr(160), 1, '{}', '23514', 'a metric with a NBSP is refused'),
  ('request_count' || chr(127), 1, '{}', '23514', 'a metric with a DEL is refused'),
  ('toString', 1, '{}', '23514', 'an inherited name (toString) as a metric is refused'),
  ('request_count', -1, '{}', '23514', 'a negative value is refused'),
  ('request_count', 9007199254740992, '{}', '23514', 'a value above 2^53 - 1 is refused'),
  ('request_count', NULL, '{}', '23502', 'a NULL value is refused'),
  ('request_count', 0, '{}', 'ok', 'the value 0 is accepted'),
  ('request_count', 9007199254740991, '{}', 'ok', 'the value 2^53 - 1 is accepted'),
  ('request_count', 1, '{"database": "main", "service": "srce_auth"}', 'ok', 'both keys together are accepted'),
  ('request_count', 1, '{"database": "evil", "database": "legal"}', 'ok', 'a repeated key keeps its last, listed value'),
  ('request_count', 1, '{"service": "\u0065mail"}', 'ok', 'a Unicode escape of a listed value is that value')
) c (metric, value, labels, expected, what);
SELECT is(pg_temp.try_as('ductus_logs_writer', format(
  'INSERT INTO public.metric_sample (metric, value, labels) VALUES (%L, 1, %L)', m.metric, l.labels)),
  'ok', 'accepted: ' || m.metric || ' ' || l.labels)
FROM unnest(ARRAY['request_count', 'error_count', 'latency_p95_ms', 'active_sessions',
                  'queue_depth', 'disk_free_percent', 'database_connections']) WITH ORDINALITY m (metric, n)
JOIN unnest(ARRAY['{}', '{"database": "main"}', '{"database": "logs"}', '{"database": "legal"}',
                  '{"service": "srce_auth"}', '{"service": "storage"}', '{"service": "keys"}']) WITH ORDINALITY l (labels, n)
  USING (n);
SELECT is((SELECT array_agg(labels::text ORDER BY id) FROM pg_temp.mine WHERE metric = 'request_count' AND value = 1
           AND labels <> '{}'),
  ARRAY['{"service": "srce_auth", "database": "main"}', '{"database": "legal"}', '{"service": "email"}'],
  'the repeated key and the escape are stored as the listed values');
SELECT is((SELECT count(*)::int FROM pg_temp.mine), 2 + 5 + 7, 'every accepted row and no refused one is there');

-- 4. Negative controls: each break of the matrix and of the lists is caught.
CREATE ROLE ductus_app NOLOGIN;
GRANT SELECT ON public.metric_sample TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.sample_drift', ARRAY['+ductus_app: SELECT'],
  'a right of the main application role on the samples is caught');
REVOKE SELECT ON public.metric_sample FROM ductus_app;
GRANT ductus_logs_reader TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.sample_drift', ARRAY['+ductus_app: SELECT', '+ductus_app: SELECT via ductus_logs_reader'],
  'a right reached through membership of a logs role is caught');
REVOKE ductus_logs_reader FROM ductus_app;
DROP ROLE ductus_app;
GRANT DELETE ON public.metric_sample TO ductus_logs_retention;
SELECT set_eq('SELECT found FROM pg_temp.sample_drift', ARRAY['+ductus_logs_retention: DELETE'],
  'DELETE for the retention role is caught');
REVOKE DELETE ON public.metric_sample FROM ductus_logs_retention;
GRANT UPDATE (labels) ON public.metric_sample TO ductus_logs_writer;
SELECT set_eq('SELECT found FROM pg_temp.sample_drift', ARRAY['+ductus_logs_writer: UPDATE'],
  'a column UPDATE for the writer is caught');
REVOKE UPDATE (labels) ON public.metric_sample FROM ductus_logs_writer;
GRANT SELECT ON public.metric_sample TO PUBLIC;
SELECT isnt_empty($$ SELECT found FROM pg_temp.sample_drift WHERE found = '+public: SELECT' $$,
  'SELECT for PUBLIC is caught');
REVOKE SELECT ON public.metric_sample FROM PUBLIC;
ALTER TABLE public.metric_sample ENABLE TRIGGER metric_sample_no_change;
SELECT is(pg_temp.try_as(NULL, 'DELETE FROM public.metric_sample', true), 'ok',
  'control: a trigger enabled only for origin lets a replica session delete, so ALWAYS is what holds');
ALTER TABLE public.metric_sample DROP CONSTRAINT metric_sample_labels_listed;
SELECT is(pg_temp.try_as('ductus_logs_writer',
  'INSERT INTO public.metric_sample (metric, value, labels) VALUES (''queue_depth'', 1, ''{"region": "eu"}'')'),
  'ok', 'control: without the list''s constraint an unlisted label goes in, so the constraint is what refuses it');

SELECT * FROM finish();
ROLLBACK;
