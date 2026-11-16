-- S-1K.2-a (DAN-813): public.log_entry, the log table of the logs database,
-- is append-only for every role, the owner and a superuser included. This
-- file holds its row of the access matrix (role x right, read from the
-- catalogue, nothing to PUBLIC, to the retention role or to the role of the
-- main application), the refusals of UPDATE, DELETE and TRUNCATE, the
-- writer's columns (no forged id or time, no reading the history) and the
-- shape of a row. Plan of attack: ductura/server#114. The chain over the rows
-- (S-1K.2-b, DAN-816) is in 020-log-chain.sql. Rows other tests left (the
-- concurrent appends of pnpm test:database commit) may be there: the rows of
-- this file are those after the last id found.
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


SELECT plan(88);

CREATE TABLE pg_temp.found_before AS SELECT coalesce(max(id), 0) AS id FROM public.log_entry;

-- Runs `sql` as `who` (NULL: the session's superuser), with
-- session_replication_role = replica when asked, and gives back the SQLSTATE
-- it fails with, or 'ok'. A failure undoes the statement; a success is kept.
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

-- Every right on the table held by a role that is not a superuser, or by
-- PUBLIC, inherited or by SET ROLE (as the ledger check of
-- 000-rls-everywhere.sql reads it); a column right counts as the right.
CREATE VIEW pg_temp.entry_right AS
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
  WHERE has_table_privilege(g.rolname, 'public.log_entry'::regclass, p.privilege)
     OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(g.rolname, 'public.log_entry'::regclass, p.privilege));

-- The matrix: the owner keeps what it cannot give up (it made the table), the
-- writer only appends; nobody else holds anything. The reader (the operator)
-- reads only through operator_log, which masks the IP (DAN-835-4), so it holds
-- no right on the table.
CREATE TABLE pg_temp.expected_entry_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_entry_right VALUES
  ('ductus_logs_migrator: SELECT'), ('ductus_logs_migrator: INSERT'),
  ('ductus_logs_migrator: REFERENCES'), ('ductus_logs_migrator: TRIGGER'),
  ('ductus_logs_writer: INSERT');
INSERT INTO pg_temp.expected_entry_right
  SELECT 'ductus_logs_migrator: MAINTAIN' WHERE current_setting('server_version_num')::int >= 170000;
CREATE VIEW pg_temp.entry_drift AS
  (SELECT '+' || x.found AS found FROM (
     SELECT found FROM pg_temp.entry_right EXCEPT SELECT found FROM pg_temp.expected_entry_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (
     SELECT found FROM pg_temp.expected_entry_right EXCEPT SELECT found FROM pg_temp.entry_right) x);

-- 1. The table as migrated.
SELECT ok(EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '20261116160000'),
  'the log table migration is in the ledger');
SELECT is(
  (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                     || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
                     || CASE WHEN a.attidentity = 'a' THEN ' identity always' ELSE '' END, ', ' ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid = 'public.log_entry'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'id bigint not null identity always, at timestamp with time zone not null, kind text not null, payload jsonb not null, '
  || 'seq bigint not null, prev_hash bytea not null, hash bytea not null',
  'log_entry has id (identity always), at, kind, payload and the chain (seq, prev_hash, hash, S-1K.2-b), none of them nullable');
SELECT is((SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.log_entry'::regclass),
  'ductus_logs_migrator', 'the migrator owns the table');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.log_entry'::regclass),
  'RLS is enabled and forced');
SELECT set_eq(
  $$ SELECT polname || ' ' || polcmd::text || ' ' || polpermissive::text || ' '
            || array_to_string(ARRAY(SELECT r::regrole::text FROM unnest(polroles) r ORDER BY 1), ',')
            || ' using ' || coalesce(pg_get_expr(polqual, polrelid), '-')
            || ' check ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
     FROM pg_policy WHERE polrelid = 'public.log_entry'::regclass $$,
  ARRAY['log_entry_append a true ductus_logs_writer using - check true',
        'log_entry_owner_read r true ductus_logs_migrator using true check -'],
  'two policies: INSERT for the writer, SELECT for the owner (the SECURITY DEFINER reads); none for the reader');
SELECT is_empty('SELECT found FROM pg_temp.entry_drift',
  'the access matrix: the writer only INSERTs, the reader holds nothing, the owner has no UPDATE, DELETE or TRUNCATE, nobody else (PUBLIC, retention, any other role) holds a right, directly, by membership or SET ROLE');
SELECT set_eq(
  $$ SELECT a.attname::text FROM pg_attribute a
     WHERE a.attrelid = 'public.log_entry'::regclass AND a.attnum > 0
       AND has_column_privilege('ductus_logs_writer', 'public.log_entry'::regclass, a.attnum, 'INSERT') $$,
  ARRAY['kind', 'payload'], 'the writer may INSERT only kind and payload');
SELECT set_eq(
  $$ SELECT t.tgname || ' ' || t.tgenabled::text || ' ' || t.tgtype::text FROM pg_trigger t
     WHERE t.tgrelid = 'public.log_entry'::regclass AND NOT t.tgisinternal $$,
  -- tgtype: 27 = ROW | BEFORE | DELETE | UPDATE, 34 = BEFORE | TRUNCATE (per statement),
  -- 7 = ROW | BEFORE | INSERT (the chain, S-1K.2-b; 020-log-chain.sql).
  ARRAY['log_entry_no_change A 27', 'log_entry_no_truncate A 34', 'log_entry_chain A 7'],
  'the refusing triggers fire ALWAYS: before UPDATE or DELETE of each row, and before TRUNCATE; so does the chain before INSERT');
SELECT is(
  (SELECT array_to_string(p.proconfig, ',') || ' ' || p.prosecdef::text || ' '
          || (NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.grantee <> p.proowner))::text
   FROM pg_proc p WHERE p.oid = 'public.log_entry_refuse_change()'::regprocedure),
  'search_path=pg_catalog false true',
  'the trigger function has a fixed search path, is not SECURITY DEFINER and is executable by nobody but its owner');

-- 2. Appending as the writer.
SELECT is(pg_temp.try_as('ductus_logs_writer',
  $$ INSERT INTO public.log_entry (kind, payload) VALUES ('authn.login_started', '{"time": "2026-11-16T05:00:00.000Z"}'),
                                                        ('authn.login_succeeded', '{"accountKind": "student"}') $$),
  'ok', 'the writer appends rows of kind and payload');
SELECT is((SELECT count(*)::int FROM public.log_entry WHERE id > (SELECT id FROM pg_temp.found_before)), 2, 'both rows are there');
SELECT ok((SELECT bool_and(at IS NOT NULL AND at <= clock_timestamp()) AND count(DISTINCT id) = 2 FROM public.log_entry
           WHERE id > (SELECT id FROM pg_temp.found_before)),
  'the database gives each row its id and time');
SELECT is(pg_temp.try_as('ductus_logs_migrator',
  $$ DO $d$ BEGIN
       IF (SELECT array_agg(kind ORDER BY id) FROM public.log_entry WHERE id > $$ || (SELECT id FROM pg_temp.found_before) || $$)
          IS DISTINCT FROM ARRAY['authn.login_started', 'authn.login_succeeded'] THEN
         RAISE EXCEPTION 'unexpected rows' USING ERRCODE = 'P0001';
       END IF;
     END $d$ $$),
  'ok', 'the owner reads the rows as written');
-- DAN-835-4: the reader no longer reads the table (the payload holds the full
-- IP); directly or through membership, every form of read is refused.
CREATE ROLE ductus_app NOLOGIN IN ROLE ductus_logs_reader;
SELECT is(pg_temp.try_as(w.who, r.sql), '42501', w.who || ' may not read the log table: ' || r.sql)
FROM unnest(ARRAY['ductus_logs_reader', 'ductus_app']) w (who)
CROSS JOIN unnest(ARRAY[
  'SELECT payload FROM public.log_entry',
  'SELECT count(*) FROM public.log_entry',
  'TABLE public.log_entry',
  'SELECT id FROM public.log_entry FOR SHARE',
  'SELECT 1 FROM public.log_entry WHERE payload -> ''fields'' ->> ''ip'' = ''192.0.2.17'''
]) r (sql);
DROP ROLE ductus_app;
-- Nor through the planner's statistics: pg_stats shows a column only to a
-- role that may read it.
ANALYZE public.log_entry;
SELECT is(pg_temp.try_as('ductus_logs_reader',
  $$ DO $d$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_catalog.pg_stats WHERE schemaname = 'public' AND tablename = 'log_entry') THEN
         RAISE EXCEPTION 'statistics of log_entry are visible' USING ERRCODE = 'P0001';
       END IF;
     END $d$ $$),
  'ok', 'the reader sees no statistics of the log table (pg_stats)');

-- 3. Nobody changes a row: each of the four roles, the superuser, and the
-- superuser with session_replication_role = replica (which skips ordinary
-- triggers, not ALWAYS ones).
CREATE TABLE pg_temp.attempt (who text, sql text, replica boolean, expected text);
INSERT INTO pg_temp.attempt
  SELECT w.who, s.sql, false, '42501'
  FROM unnest(ARRAY['ductus_logs_migrator', 'ductus_logs_writer', 'ductus_logs_reader', 'ductus_logs_retention']) w (who)
  CROSS JOIN unnest(ARRAY['UPDATE public.log_entry SET kind = ''authn.changed''',
                          'DELETE FROM public.log_entry',
                          'TRUNCATE public.log_entry']) s (sql);
INSERT INTO pg_temp.attempt
  SELECT NULL, s.sql, r.replica, '55000'
  FROM unnest(ARRAY['UPDATE public.log_entry SET payload = ''{}''',
                    'DELETE FROM public.log_entry WHERE id = (SELECT min(id) FROM public.log_entry)',
                    'TRUNCATE public.log_entry']) s (sql)
  CROSS JOIN unnest(ARRAY[false, true]) r (replica);
SELECT is(pg_temp.try_as(who, sql, replica), expected,
  coalesce(who, 'the superuser') || CASE WHEN replica THEN ' with session_replication_role = replica' ELSE '' END
  || ' is refused: ' || sql)
FROM pg_temp.attempt ORDER BY who NULLS LAST, replica, sql;

-- 4. Other ways round, as the writer.
SELECT is(pg_temp.try_as('ductus_logs_writer', w.sql), '42501', 'the writer is refused: ' || w.sql)
FROM unnest(ARRAY[
  'SELECT 1 FROM public.log_entry',
  'INSERT INTO public.log_entry (kind, payload) VALUES (''authn.login_started'', ''{}'') RETURNING id',
  'INSERT INTO public.log_entry (id, kind, payload) OVERRIDING SYSTEM VALUE VALUES (-5, ''authn.login_started'', ''{}'')',
  'INSERT INTO public.log_entry (at, kind, payload) VALUES (''1999-01-01'', ''authn.login_started'', ''{}'')',
  'INSERT INTO public.log_entry (kind, payload) VALUES (''authn.login_started'', ''{}'') ON CONFLICT (id) DO UPDATE SET kind = ''authn.changed''',
  'MERGE INTO public.log_entry e USING (SELECT 1 AS id) s ON e.id = s.id WHEN MATCHED THEN DELETE',
  'SELECT setval(pg_get_serial_sequence(''public.log_entry'', ''id''), 1)',
  'ALTER TABLE public.log_entry DISABLE TRIGGER log_entry_no_change',
  'DROP TRIGGER log_entry_no_truncate ON public.log_entry',
  'ALTER TABLE public.log_entry NO FORCE ROW LEVEL SECURITY',
  'DROP POLICY log_entry_owner_read ON public.log_entry',
  'DROP TABLE public.log_entry'
]) w (sql);
SELECT is(pg_temp.try_as('ductus_logs_reader',
  'INSERT INTO public.log_entry (kind, payload) VALUES (''authn.login_started'', ''{}'')'),
  '42501', 'the reader cannot append');
SELECT is(pg_temp.try_as('ductus_logs_retention', 'SELECT 1 FROM public.log_entry'),
  '42501', 'the retention role cannot read');
SELECT pg_temp.try_as('ductus_logs_writer', 'GRANT UPDATE, DELETE, TRUNCATE, SELECT ON public.log_entry TO ductus_logs_writer');
SELECT is_empty('SELECT found FROM pg_temp.entry_drift', 'a GRANT by the writer to itself gives it nothing');
SELECT is((SELECT count(*)::int FROM public.log_entry WHERE id > (SELECT id FROM pg_temp.found_before)), 2,
  'after every attempt the two rows stay');
SELECT is((SELECT array_agg(kind || ' ' || payload::text ORDER BY id) FROM public.log_entry
           WHERE id > (SELECT id FROM pg_temp.found_before)),
  ARRAY['authn.login_started {"time": "2026-11-16T05:00:00.000Z"}', 'authn.login_succeeded {"accountKind": "student"}'],
  'and are unchanged');

-- 5. The shape of a row, as the writer.
SELECT is(pg_temp.try_as('ductus_logs_writer',
  format('INSERT INTO public.log_entry (kind, payload) VALUES (%L, %L)', b.kind, b.payload)), b.expected,
  b.what)
FROM (VALUES
  ('', '{}', '23514', 'an empty kind is refused'),
  (NULL, '{}', '23502', 'a NULL kind is refused'),
  (' authn.login_started', '{}', '23514', 'a kind with a leading space is refused'),
  ('authn.login_started ', '{}', '23514', 'a kind with a trailing space is refused'),
  ('Authn.login_started', '{}', '23514', 'a kind in capitals is refused'),
  ('authn', '{}', '23514', 'a kind without an area is refused'),
  ('authn.login.started', '{}', '23514', 'a kind with two dots is refused'),
  ('authn:login_started', '{}', '23514', 'a kind with another separator than a literal dot is refused'),
  ('authnxlogin_started', '{}', '23514', 'a kind whose separator is any character but a dot is refused'),
  ('authn.login_started' || E'\n', '{}', '23514', 'a kind with a trailing newline is refused'),
  ('authn.prijava_é', '{}', '23514', 'a kind with a letter beyond a-z is refused'),
  ('authn.x''; DROP TABLE public.log_entry; --', '{}', '23514', 'a kind carrying SQL is refused'),
  ('a.' || repeat('b', 62), '{}', 'ok', 'a kind of 64 characters is accepted'),
  ('a.' || repeat('b', 63), '{}', '23514', 'a kind of 65 characters is refused'),
  ('authn.login_started', NULL, '23502', 'a NULL payload is refused'),
  ('authn.login_started', 'null', '23514', 'a JSON null payload is refused'),
  ('authn.login_started', '[]', '23514', 'a JSON array payload is refused'),
  ('authn.login_started', '1', '23514', 'a JSON number payload is refused'),
  ('authn.login_started', '"x"', '23514', 'a JSON string payload is refused'),
  ('authn.login_started', '{"a": "' || repeat('x', 16375) || '"}', 'ok', 'a payload of 16384 bytes is accepted'),
  ('authn.login_started', '{"a": "' || repeat('x', 16376) || '"}', '23514', 'a payload of 16385 bytes is refused')
) b (kind, payload, expected, what);

-- 6. Negative controls: each break of the matrix is caught.
CREATE ROLE ductus_app NOLOGIN;
GRANT SELECT ON public.log_entry TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.entry_drift', ARRAY['+ductus_app: SELECT'],
  'a right of the main application role on the log table is caught');
REVOKE SELECT ON public.log_entry FROM ductus_app;
GRANT ductus_logs_reader TO ductus_app;
SELECT is_empty('SELECT found FROM pg_temp.entry_drift', 'membership of the reader gives no right on the log table');
GRANT SELECT ON public.log_entry TO ductus_logs_reader;
SELECT set_eq('SELECT found FROM pg_temp.entry_drift', ARRAY['+ductus_logs_reader: SELECT', '+ductus_app: SELECT', '+ductus_app: SELECT via ductus_logs_reader'],
  'a SELECT given back to the reader is caught, with the membership that reaches it');
REVOKE SELECT ON public.log_entry FROM ductus_logs_reader;
REVOKE ductus_logs_reader FROM ductus_app;
DROP ROLE ductus_app;
GRANT SELECT (payload) ON public.log_entry TO ductus_logs_reader;
SELECT set_eq('SELECT found FROM pg_temp.entry_drift', ARRAY['+ductus_logs_reader: SELECT'],
  'a column SELECT given back to the reader is caught');
REVOKE SELECT (payload) ON public.log_entry FROM ductus_logs_reader;
GRANT DELETE ON public.log_entry TO ductus_logs_retention;
SELECT set_eq('SELECT found FROM pg_temp.entry_drift', ARRAY['+ductus_logs_retention: DELETE'],
  'DELETE for the retention role is caught');
REVOKE DELETE ON public.log_entry FROM ductus_logs_retention;
GRANT UPDATE (payload) ON public.log_entry TO ductus_logs_writer;
SELECT set_eq('SELECT found FROM pg_temp.entry_drift', ARRAY['+ductus_logs_writer: UPDATE'],
  'a column UPDATE for the writer is caught');
REVOKE UPDATE (payload) ON public.log_entry FROM ductus_logs_writer;
GRANT INSERT ON public.log_entry TO PUBLIC;
SELECT isnt_empty($$ SELECT found FROM pg_temp.entry_drift WHERE found = '+public: INSERT' $$,
  'INSERT for PUBLIC is caught');
REVOKE INSERT ON public.log_entry FROM PUBLIC;
ALTER TABLE public.log_entry ENABLE TRIGGER log_entry_no_change;
SELECT is(pg_temp.try_as(NULL, 'DELETE FROM public.log_entry', true), 'ok',
  'control: a trigger enabled only for origin lets a replica session delete, so ALWAYS is what holds');

SELECT * FROM finish();
ROLLBACK;
