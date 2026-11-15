-- S-1F-b (DAN-786): every table of this database has ENABLE and FORCE ROW
-- LEVEL SECURITY and at least one policy. The same file runs in each database
-- (db/main/tests, db/logs/tests, db/legal/tests); see server/database/README.md.
--
-- The tables are read from the catalogue, never from a list, so a table that a
-- later migration adds, in any schema, is covered once that migration runs.
-- relkind r is an ordinary table, UNLOGGED and partitions included (a query
-- straight on a partition does not pass through the RLS of its parent, so each
-- partition is held on its own); p is a partitioned parent; f is a foreign
-- table, which cannot carry RLS and so always fails here: none is allowed.
-- Tables that an extension brings are not left out either.
--
-- Exceptions, each named with its reason. The count of exceptions that exist
-- is fixed below, so a new exception changes this file and shows in review.
--   * the system's own tables (pg_catalog, information_schema), made by initdb:
--     they are left out by oid (below FirstNormalObjectId, 16384), not by
--     schema name, so a table a superuser later puts into a system schema is
--     still caught. Toast tables are another relkind.
--   * temporary tables: they live only in the session that made them.
--   * public.schema_migrations: the dbmate ledger, written by the migrator
--     alone. It holds only while it is a plain table of the database owner
--     that no partition, inheritance, view or rule reaches, and while no role
--     but its owner and the superusers, nor PUBLIC, holds any right on it,
--     inherited or reachable by SET ROLE
--     (checked below; 011 holds more in main).
-- A function or operator on the search path that would shadow pg_catalog
-- stops the file before any test (the DO block); everything else runs with
-- the search path pinned to pg_catalog.
--
-- The negative controls are made inside the transaction, seen, and dropped;
-- the file rolls back, so nothing stays.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL lc_messages TO 'C';

SELECT plan(20);
-- pgTAP itself resolves through the search path, so a function or operator
-- planted there (the migrator owns each database and may create in public)
-- could change what it computes: none may exist outside an extension that is
-- an operator or carries the name of a pg_catalog function. This raises
-- rather than asserts, as a planted operator could bend the assertion itself.
DO $$
DECLARE
  planted text;
BEGIN
  SELECT pg_catalog.string_agg(x.found, ', ') INTO planted FROM (
    SELECT p.oid::pg_catalog.regprocedure::text AS found FROM pg_catalog.pg_proc p
    WHERE p.pronamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND p.pronamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                  WHERE q.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
                    AND q.proname OPERATOR(pg_catalog.=) p.proname)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) p.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
    UNION ALL
    SELECT o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace OPERATOR(pg_catalog.=) ANY (pg_catalog.current_schemas(false)::pg_catalog.regnamespace[])
      AND o.oprnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_operator'::pg_catalog.regclass
                        AND d.objid OPERATOR(pg_catalog.=) o.oid AND d.deptype OPERATOR(pg_catalog.=) 'e')
  ) x;
  IF planted IS NOT NULL THEN
    RAISE EXCEPTION 'a function or operator on the search path shadows pg_catalog: %', planted;
  END IF;
END
$$;

-- The views resolve functions and operators once, here, from pg_catalog only.
SET LOCAL search_path TO pg_catalog, pg_temp;

CREATE TEMP VIEW checked_table AS
  SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'f')
    AND c.oid >= 16384 AND c.relpersistence <> 't'
    AND (n.nspname, c.relname) NOT IN (('public', 'schema_migrations'));

CREATE TEMP VIEW rls_gap AS
  SELECT name AS found FROM checked_table WHERE NOT (relrowsecurity AND relforcerowsecurity);

CREATE TEMP VIEW policy_gap AS
  SELECT name AS found FROM checked_table t
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = t.oid);

-- The negative controls below look only at the objects they make, so a real
-- gap fails the checks of section 1 and the last one, not every control.
CREATE TEMP VIEW probe_rls_gap AS
  SELECT found FROM rls_gap WHERE found LIKE '%test\_rls\_probe%';
CREATE TEMP VIEW probe_policy_gap AS
  SELECT found FROM policy_gap WHERE found LIKE '%test\_rls\_probe%';

-- Every right on the ledger held by a role that is neither its owner nor a
-- superuser, or by PUBLIC. has_*_privilege resolves groups, PUBLIC and the
-- predefined roles (pg_read_all_data and the like), so a right reached through
-- membership shows on the member; the predefined roles themselves are left out.
CREATE TEMP VIEW ledger_right AS
  SELECT DISTINCT r.rolname || ': ' || p.privilege
         || CASE WHEN g.rolname = r.rolname THEN '' ELSE ' via ' || g.rolname END AS found
  FROM (SELECT x.oid, x.rolname::text FROM pg_catalog.pg_roles x
        WHERE NOT x.rolsuper AND x.rolname NOT LIKE 'pg\_%'
          AND x.oid <> (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.schema_migrations'::regclass)
        UNION ALL SELECT 0, 'public') AS r (oid, rolname)
  -- A right reached by SET ROLE counts as much as an inherited one: a
  -- NOINHERIT member of pg_read_all_data, or of the owner, reads the ledger
  -- after SET ROLE, and has_table_privilege on the member alone does not see
  -- it. So every role the member may become (MEMBER: direct or indirect, with
  -- or without INHERIT) is read too, the member itself included.
  JOIN LATERAL (SELECT y.rolname::text FROM pg_catalog.pg_roles y
                WHERE r.oid = 0 AND y.oid = 0
                   OR r.oid <> 0 AND pg_has_role(r.oid, y.oid, 'MEMBER')
                UNION ALL SELECT 'public' WHERE r.oid = 0) AS g (rolname) ON true
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
              -- PostgreSQL 17 (production, CI) adds MAINTAIN.
              || CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p (privilege)
  WHERE has_table_privilege(g.rolname, 'public.schema_migrations'::regclass, p.privilege)
     OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(g.rolname, 'public.schema_migrations'::regclass, p.privilege));

CREATE TEMP VIEW ledger_shape AS
  SELECT 'owner ' || c.relowner::regrole::text AS found FROM pg_class c
  WHERE c.oid = 'public.schema_migrations'::regclass
    AND c.relowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
  UNION ALL SELECT 'kind ' || c.relkind::text FROM pg_class c
  WHERE c.oid = 'public.schema_migrations'::regclass AND (c.relkind <> 'r' OR c.relispartition)
  UNION ALL SELECT 'inheritance ' || i.inhrelid::regclass::text || ' of ' || i.inhparent::regclass::text FROM pg_inherits i
  WHERE 'public.schema_migrations'::regclass::oid IN (i.inhrelid, i.inhparent)
  UNION ALL SELECT 'depends ' || pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_depend d
  WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.schema_migrations'::regclass
    AND NOT (d.classid = 'pg_type'::regclass AND d.deptype = 'i')
    AND NOT (d.classid = 'pg_class'::regclass AND d.deptype = 'i'
             AND d.objid = (SELECT reltoastrelid FROM pg_class WHERE oid = 'public.schema_migrations'::regclass))
    AND NOT (d.classid = 'pg_constraint'::regclass AND d.objid IN
             (SELECT oid FROM pg_constraint WHERE conrelid = 'public.schema_migrations'::regclass AND contype = 'p'))
    AND NOT (d.classid = 'pg_rewrite'::regclass AND EXISTS (
             SELECT 1 FROM pg_rewrite w JOIN pg_class v ON v.oid = w.ev_class
             WHERE w.oid = d.objid AND v.relpersistence = 't'));
RESET search_path;

-- 1. The database as migrated.
SELECT is_empty('SELECT found FROM rls_gap', 'every table has ENABLE and FORCE ROW LEVEL SECURITY');
SELECT is_empty('SELECT found FROM policy_gap', 'every table has at least one policy');
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE (n.nspname, c.relname) IN (('public', 'schema_migrations')) AND c.relkind IN ('r', 'p', 'f')),
  1, 'exactly one named exception exists: public.schema_migrations');
SELECT is_empty('SELECT found FROM ledger_shape', 'the ledger is a plain table of the database owner that nothing reads through');
SELECT is_empty('SELECT found FROM ledger_right', 'no role but the owner of the ledger and the superusers, nor PUBLIC, holds a right on it, inherited or by SET ROLE');

-- 2. Negative controls: each table that breaks the rule is caught.
CREATE SCHEMA test_rls_probe;
CREATE TABLE test_rls_probe.plain (id int);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.plain'],
  'a table without RLS in a new schema is caught');
DROP TABLE test_rls_probe.plain;

CREATE TABLE public.test_rls_probe_plain (id int);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['public.test_rls_probe_plain'],
  'a table without RLS in public is caught');
DROP TABLE public.test_rls_probe_plain;

CREATE TABLE test_rls_probe.schema_migrations (version text);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.schema_migrations'],
  'the exception holds for public.schema_migrations only, not for the name in another schema');
DROP TABLE test_rls_probe.schema_migrations;

CREATE TABLE test_rls_probe.not_forced (id int);
ALTER TABLE test_rls_probe.not_forced ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_own ON test_rls_probe.not_forced USING (false);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.not_forced'],
  'ENABLE without FORCE is caught');
DROP TABLE test_rls_probe.not_forced;

CREATE UNLOGGED TABLE test_rls_probe.unlogged (id int);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.unlogged'],
  'an UNLOGGED table without RLS is caught');
DROP TABLE test_rls_probe.unlogged;

CREATE TABLE test_rls_probe.parent (id int) PARTITION BY RANGE (id);
ALTER TABLE test_rls_probe.parent ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY test_own ON test_rls_probe.parent USING (false);
CREATE TABLE test_rls_probe.part PARTITION OF test_rls_probe.parent FOR VALUES FROM (0) TO (10);
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.part'],
  'a partition without RLS of its own is caught, its parent with RLS is not');
SELECT set_eq('SELECT found FROM probe_policy_gap', ARRAY['test_rls_probe.part'],
  'a partition without a policy of its own is caught');
DROP TABLE test_rls_probe.parent;

CREATE FOREIGN DATA WRAPPER test_rls_probe_fdw;
CREATE SERVER test_rls_probe_server FOREIGN DATA WRAPPER test_rls_probe_fdw;
CREATE FOREIGN TABLE test_rls_probe.remote (id int) SERVER test_rls_probe_server;
SELECT set_eq('SELECT found FROM probe_rls_gap', ARRAY['test_rls_probe.remote'],
  'a foreign table, which cannot carry RLS, is caught');
DROP FOREIGN TABLE test_rls_probe.remote;
DROP SERVER test_rls_probe_server;
DROP FOREIGN DATA WRAPPER test_rls_probe_fdw;

CREATE TABLE test_rls_probe.no_policy (id int);
ALTER TABLE test_rls_probe.no_policy ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
SELECT is_empty('SELECT found FROM probe_rls_gap', 'a table with ENABLE and FORCE passes the RLS check');
SELECT set_eq('SELECT found FROM probe_policy_gap', ARRAY['test_rls_probe.no_policy'],
  'a table with ENABLE and FORCE but no policy is caught');
CREATE POLICY test_own ON test_rls_probe.no_policy USING (false);
SELECT is_empty('SELECT found FROM probe_rls_gap UNION ALL SELECT found FROM probe_policy_gap',
  'a table with ENABLE, FORCE and a policy passes both checks');
DROP TABLE test_rls_probe.no_policy;
DROP SCHEMA test_rls_probe;

-- 3. The ledger exception stops holding once anyone else gets a right on it.
CREATE ROLE test_rls_probe_reader NOLOGIN;
GRANT SELECT ON public.schema_migrations TO test_rls_probe_reader;
SELECT set_eq('SELECT found FROM ledger_right', ARRAY['test_rls_probe_reader: SELECT'],
  'a right on the ledger granted to another role is caught');
REVOKE SELECT ON public.schema_migrations FROM test_rls_probe_reader;
DROP ROLE test_rls_probe_reader;
CREATE ROLE test_rls_probe_auditor NOLOGIN NOINHERIT IN ROLE pg_read_all_data;
SELECT set_eq('SELECT found FROM ledger_right', ARRAY['test_rls_probe_auditor: SELECT via pg_read_all_data'],
  'a NOINHERIT member of pg_read_all_data, who reads the ledger after SET ROLE, is caught');
DROP ROLE test_rls_probe_auditor;
GRANT SELECT (version) ON public.schema_migrations TO PUBLIC;
SELECT isnt_empty($$ SELECT found FROM ledger_right WHERE found = 'public: SELECT' $$,
  'a column right on the ledger granted to PUBLIC is caught');
REVOKE SELECT (version) ON public.schema_migrations FROM PUBLIC;

SELECT is_empty('SELECT found FROM rls_gap UNION ALL SELECT found FROM policy_gap UNION ALL SELECT found FROM ledger_right',
  'the database is clean again once the controls are taken back');

SELECT * FROM finish();
ROLLBACK;
