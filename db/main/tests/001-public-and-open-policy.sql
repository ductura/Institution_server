-- DAN-949: two catalogue rules, read from pg_class and pg_policy, never from
-- a list, so whatever a later migration adds is covered once it runs.
--
-- A. No application relation lives in schema public: no table (also
--    partitioned or foreign), view, materialized view or sequence. Temporary
--    relations live in pg_temp.
-- B. No permissive policy, in any schema, public included, lets every row
--    through for a role that is not the owner of its table: its USING names no
--    column (no Var in the expression: true, 1 = 1, NOT false, a test of the
--    role or session alone, which C-23 forbids anyway), or the USING its
--    command needs is missing (every command but INSERT). A policy without a
--    role applies to PUBLIC, which is not the owner. A restrictive policy only
--    narrows and is not read. B is a sufficient rule, not a complete one: an
--    expression with a column that still passes every row (col IS NOT NULL) is
--    left to review, as are policies on another table's rows only (EXISTS with
--    no column of the row). WITH CHECK is held by 012. Who owns a table and
--    who is a member of an owner role is held by 010 and 012.
--
-- Exceptions, each with its reason; their count is fixed below, so a new one
-- changes this file and shows in review.
--   * A: public.schema_migrations, the dbmate ledger, only while the database
--     owner owns it (000-rls-everywhere.sql holds the rest of its shape).
--   * A: the views of the pgtap extension itself (tap_funky,
--     pg_all_foreign_keys), which the test runner installs into public. Only
--     members of pgtap are left out, so no other extension may put a relation
--     there.
--   * B: the policies of schema pgboss whose roles are exactly ductus_worker:
--     the worker uses the pg-boss queue directly and it holds identifiers only
--     (D-74); 106-pgboss-queue.sql pins them. The same definition as
--     open_policy in 012.
--   * B: SRV-1814 operators read all problem reports. 122-problem-report.sql
--     pins the one SELECT policy for the dedicated role.
--
-- The negative controls are made inside the transaction, seen and dropped;
-- the file rolls back, so nothing stays.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL lc_messages TO 'C';
SET LOCAL client_min_messages TO warning;

SELECT plan(13);

CREATE TEMP VIEW public_relation AS
  SELECT c.relname::text AS found
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND c.relpersistence <> 't'
    AND NOT (c.relname = 'schema_migrations' AND c.relkind = 'r'
             AND c.relowner = (SELECT datdba FROM pg_database WHERE datname = current_database()))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                      AND e.extname = 'pgtap');

-- polcmd: r SELECT, a INSERT, w UPDATE, d DELETE, * ALL.
CREATE TEMP VIEW open_policy AS
  SELECT p.polrelid::regclass::text || '.' || p.polname AS found
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polpermissive
    AND NOT p.polroles <@ ARRAY[c.relowner]
    AND p.polcmd <> 'a'
    AND (p.polqual IS NULL OR p.polqual::text NOT LIKE '%{VAR %')
    AND NOT coalesce(c.relnamespace = to_regnamespace('pgboss')::oid
                     AND p.polroles = ARRAY[to_regrole('ductus_worker')::oid], false)
    AND NOT coalesce(p.polrelid = 'identity.problem_report'::regclass
                     AND p.polname = 'problem_report_operator_read' AND p.polcmd = 'r'
                     AND p.polroles = ARRAY['ductus_problem_report_reader'::regrole::oid]
                     AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND p.polwithcheck IS NULL, false);

CREATE TEMP VIEW probe AS
  SELECT found FROM public_relation WHERE found LIKE 'test\_dan949%'
  UNION ALL SELECT found FROM open_policy WHERE found LIKE 'test\_dan949%';

-- 1. Negative controls: each object that breaks a rule is caught, and the
-- shapes the rules allow are not.
CREATE TABLE public.test_dan949_table (id int);
SELECT set_eq('SELECT found FROM probe', ARRAY['test_dan949_table'], 'a table in public is caught');
DROP TABLE public.test_dan949_table;
CREATE VIEW public.test_dan949_view AS SELECT 1 AS one;
SELECT set_eq('SELECT found FROM probe', ARRAY['test_dan949_view'], 'a view in public is caught');
DROP VIEW public.test_dan949_view;
CREATE SEQUENCE public.test_dan949_seq;
SELECT set_eq('SELECT found FROM probe', ARRAY['test_dan949_seq'], 'a sequence in public is caught');
DROP SEQUENCE public.test_dan949_seq;
CREATE SCHEMA test_dan949;
CREATE TABLE test_dan949.schema_migrations (version text);
SELECT is_empty('SELECT found FROM probe', 'a table outside public is not read by rule A');
SAVEPOINT ledger_owner;
ALTER TABLE public.schema_migrations OWNER TO ductus_app;
SELECT set_eq($$ SELECT found FROM public_relation WHERE found = 'schema_migrations' $$, ARRAY['schema_migrations'],
  'the ledger is an exception only while the database owner owns it');
ROLLBACK TO SAVEPOINT ledger_owner;

CREATE TABLE test_dan949.t (id int);
ALTER TABLE test_dan949.t ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY test_dan949_true ON test_dan949.t FOR SELECT TO ductus_app USING (true);
CREATE POLICY test_dan949_one ON test_dan949.t FOR UPDATE TO ductus_app USING (1 = 1);
CREATE POLICY test_dan949_not ON test_dan949.t FOR DELETE TO ductus_app USING (NOT false);
CREATE POLICY test_dan949_case ON test_dan949.t TO ductus_app
  USING (CASE WHEN current_user = 'x' THEN true ELSE true END);
CREATE POLICY test_dan949_none ON test_dan949.t FOR SELECT TO ductus_app;
CREATE POLICY test_dan949_public ON test_dan949.t FOR SELECT USING (true);
CREATE POLICY test_dan949_mixed ON test_dan949.t FOR SELECT TO ductus_app, current_user USING (true);
SELECT set_eq('SELECT found FROM probe',
  ARRAY['test_dan949.t.test_dan949_true', 'test_dan949.t.test_dan949_one', 'test_dan949.t.test_dan949_not',
        'test_dan949.t.test_dan949_case', 'test_dan949.t.test_dan949_none', 'test_dan949.t.test_dan949_public',
        'test_dan949.t.test_dan949_mixed'],
  'USING (true), 1 = 1, NOT false, a CASE with no column, a missing USING, PUBLIC and owner plus another role are caught');
DROP TABLE test_dan949.t;

CREATE TABLE test_dan949.t (id int);
CREATE POLICY test_dan949_owner ON test_dan949.t TO current_user USING (true);
CREATE POLICY test_dan949_restrictive ON test_dan949.t AS RESTRICTIVE TO ductus_app USING (true);
CREATE POLICY test_dan949_insert ON test_dan949.t FOR INSERT TO ductus_app WITH CHECK (id > 0);
CREATE POLICY test_dan949_column ON test_dan949.t FOR SELECT TO ductus_app USING (id = 1);
CREATE POLICY test_dan949_public_column ON test_dan949.t FOR SELECT USING (id = 1);
SELECT is_empty('SELECT found FROM probe',
  'an owner policy, a restrictive policy, an INSERT policy and a USING with a column are not caught');
DROP TABLE test_dan949.t;

CREATE TABLE pgboss.test_dan949_job (id int);
CREATE POLICY test_dan949_worker ON pgboss.test_dan949_job TO ductus_worker USING (true);
CREATE POLICY test_dan949_app ON pgboss.test_dan949_job TO ductus_app USING (true);
CREATE POLICY test_dan949_both ON pgboss.test_dan949_job TO ductus_worker, ductus_app USING (true);
SELECT set_eq($$ SELECT found FROM open_policy WHERE found LIKE 'pgboss.test\_dan949%' $$,
  ARRAY['pgboss.test_dan949_job.test_dan949_app', 'pgboss.test_dan949_job.test_dan949_both'],
  'the pg-boss exception holds for ductus_worker alone, whatever the policy name');
DROP TABLE pgboss.test_dan949_job;
CREATE TABLE test_dan949.job (id int);
CREATE POLICY pgboss_worker ON test_dan949.job TO ductus_worker USING (true);
SELECT set_eq('SELECT found FROM probe', ARRAY['test_dan949.job.pgboss_worker'],
  'the pg-boss exception holds in schema pgboss only');
DROP SCHEMA test_dan949 CASCADE;

-- 2. The database as migrated.
SELECT is_empty('SELECT found FROM public_relation', 'no application relation lives in schema public');
SELECT is_empty('SELECT found FROM open_policy',
  'no permissive policy lets every row through outside the named exceptions');
SELECT is(
  (SELECT count(*)::int FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                     WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                       AND e.extname = 'pgtap')),
  1, 'exactly one exception to rule A exists beside pgtap: public.schema_migrations');
SELECT is(
  (SELECT count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'pgboss'::regnamespace AND p.polroles = ARRAY['ductus_worker'::regrole::oid]
     AND (p.polqual IS NULL OR p.polqual::text NOT LIKE '%{VAR %')),
  11, 'exactly eleven exceptions to rule B exist: the pg-boss worker policies of 106');

SELECT * FROM finish();
ROLLBACK;
