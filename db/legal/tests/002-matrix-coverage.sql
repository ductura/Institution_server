-- DAN-1564: every table of this database has a row in the list below, which
-- names the pgTAP file that holds the table's access tests. A table that a
-- later migration adds, in any schema, fails this file until it gets a row;
-- scripts/db/matrix-coverage.test.ts then holds the row to a file that exists
-- and names the table. The same file runs in each database (db/main/tests,
-- db/logs/tests, db/legal/tests) and differs only in the list.
--
-- The tables are read from the catalogue exactly as 000-rls-everywhere.sql
-- reads them (ordinary, partitioned and foreign tables of every schema, the
-- system's own and temporary ones left out), with the same single exception:
-- public.schema_migrations, the dbmate ledger, which 000-rls-everywhere.sql
-- (and 011 in main) holds. The preamble is that file's as well.
--
-- What this proves: no table is missing from the list. It does not prove that
-- the named file tests every role and every operation on the table.
--
-- The negative controls are made inside the transaction, seen, and dropped;
-- the file rolls back, so nothing stays.
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

SELECT plan(9);

CREATE VIEW pg_temp.matrix_row AS
  SELECT v.schema_name, v.table_name, v.matrix_file FROM (VALUES
    ('legal', 'text_version', '010-legal-text-version.sql')
  ) AS v (schema_name, table_name, matrix_file);

CREATE VIEW pg_temp.catalogue_table AS
  SELECT n.nspname::text AS schema_name, c.relname::text AS table_name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'f')
    AND c.oid >= 16384 AND c.relpersistence <> 't'
    AND (n.nspname, c.relname) NOT IN (('public', 'schema_migrations'));

CREATE VIEW pg_temp.matrix_gap AS
  SELECT t.schema_name || '.' || t.table_name AS found FROM pg_temp.catalogue_table t
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.matrix_row r
                    WHERE r.schema_name = t.schema_name AND r.table_name = t.table_name);

CREATE VIEW pg_temp.matrix_stale AS
  SELECT r.schema_name || '.' || r.table_name AS found FROM pg_temp.matrix_row r
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.catalogue_table t
                    WHERE t.schema_name = r.schema_name AND t.table_name = r.table_name);

-- 1. The database as migrated.
SELECT is_empty('SELECT found FROM pg_temp.matrix_gap', 'every table has a row in the list of access tests');
SELECT is_empty('SELECT found FROM pg_temp.matrix_stale', 'every row of the list names a table that exists');
SELECT is((SELECT count(*)::int FROM pg_temp.matrix_row), 1, 'the list has the expected number of rows');
SELECT is_empty(
  'SELECT schema_name, table_name FROM pg_temp.matrix_row GROUP BY 1, 2 HAVING count(*) > 1',
  'no table has two rows');

-- 2. Negative controls: each table without a row is caught.
CREATE SCHEMA test_matrix_probe;
CREATE TABLE test_matrix_probe.plain (id int);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['test_matrix_probe.plain'],
  'a table without a row, in a new schema, is caught');
DROP TABLE test_matrix_probe.plain;

CREATE TABLE public.test_matrix_probe_plain (id int);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['public.test_matrix_probe_plain'],
  'a table without a row in public is caught');
DROP TABLE public.test_matrix_probe_plain;

CREATE TABLE test_matrix_probe.schema_migrations (version text);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap', ARRAY['test_matrix_probe.schema_migrations'],
  'the exception holds for public.schema_migrations only, not for the name in another schema');
DROP TABLE test_matrix_probe.schema_migrations;

CREATE TABLE test_matrix_probe.parent (id int) PARTITION BY RANGE (id);
CREATE TABLE test_matrix_probe.part PARTITION OF test_matrix_probe.parent FOR VALUES FROM (0) TO (10);
SELECT set_eq('SELECT found FROM pg_temp.matrix_gap',
  ARRAY['test_matrix_probe.parent', 'test_matrix_probe.part'],
  'a partitioned table and its partition each need a row of their own');
DROP TABLE test_matrix_probe.parent;
DROP SCHEMA test_matrix_probe;

SELECT is_empty('SELECT found FROM pg_temp.matrix_gap UNION ALL SELECT found FROM pg_temp.matrix_stale',
  'the list is whole again once the controls are taken back');

SELECT * FROM finish();
ROLLBACK;
