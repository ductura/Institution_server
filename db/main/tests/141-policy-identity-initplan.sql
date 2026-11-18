-- DAN-1066 (M2.15b): no policy reads the session once per row. A function
-- that reads the session (an identity function) may sit in USING or WITH CHECK
-- only as the whole of its own scalar subquery over constants,
-- (SELECT app.current_user_id()), which the planner runs once per statement
-- as an InitPlan: the shape of DAN-51 (118-actor-scope-initplan.sql).
--
-- Read from the catalogue, never from a list, so a later migration is covered
-- once it runs:
--   * identity functions: pg_catalog.current_setting and pg_show_all_settings,
--     and every function of the database (oid at least 16384) whose body names
--     an identity function or a view that reads the session (pg_settings, or
--     a view of the database whose definition names either), closed over, so
--     app.current_actor and whatever calls it, at any depth and through views,
--     are in. A name counts as a whole word, with or without "(" after it,
--     so a comment between a name and its bracket, (r).name or a name in a
--     comment are caught too (more is caught, never less).
--   * the calls: every function (funcid) and operator (opno, by its oprcode)
--     in the stored node tree of pg_policy.polqual and polwithcheck, by oid,
--     whatever the search path, quoting or overloading. Each call counts.
--   * the shape that is allowed: an EXPR sublink whose query has no range
--     table, no WHERE and no other clause, and whose one target is the
--     function over constants only. Anything else is a call per row.
--   * what a node tree does not show: an operator, cast or domain CHECK that
--     reads the session, or a view read by a policy; none may exist (4).
-- Left to review: a name built at run time for EXECUTE, SHOW, C functions,
-- a name written with U& escapes or quotes around a part of it.
-- Stricter than the planner: (SELECT g(app.current_user_id())) and
-- (SELECT (app.current_actor()).user_id) are InitPlans but are caught.
--
-- Exception, with its reason; the list is fixed below, so a new one changes
-- this file and shows in review:
--   * institution.work_accommodation_read calls institution.work_accommodation
--     (assignment_id, student_id) once per row, a plpgsql reader of the row
--     left out of DAN-51 (20261108140000_actor_scope_initplan); its rewrite
--     needs a migration and a proof of equal rows, a task of its own.
--
-- The databases logs and legal have no identity function; their policies are
-- by role. The negative controls are made inside the transaction and roll back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lc_messages TO 'C';
SET LOCAL client_min_messages TO warning;

SELECT plan(9);

-- The scratch functions of 1 come first, so the closure is read once.
CREATE SCHEMA test_dan1066;
GRANT USAGE ON SCHEMA test_dan1066 TO ductus_app;
CREATE FUNCTION test_dan1066.f1() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT user_id FROM app.current_actor() $$;
CREATE FUNCTION test_dan1066.f2() RETURNS uuid LANGUAGE plpgsql STABLE
  AS $$ BEGIN RETURN test_dan1066.f1(); END $$;
CREATE FUNCTION test_dan1066.mine(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT $1 = app.current_user_id() AND $2 IS NOT NULL $$;
CREATE OPERATOR test_dan1066.=== (FUNCTION = test_dan1066.mine, LEFTARG = uuid, RIGHTARG = uuid);
CREATE FUNCTION test_dan1066.shout(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper($1) $$;
CREATE FUNCTION test_dan1066.token() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT setting FROM pg_catalog.pg_settings WHERE name = 'app.session_token' $$;
CREATE FUNCTION test_dan1066.via_token() RETURNS text LANGUAGE sql STABLE AS $$ SELECT test_dan1066.token() $$;
CREATE VIEW test_dan1066.actor_v AS SELECT app.current_user_id() AS id;
CREATE FUNCTION test_dan1066.via_view() RETURNS uuid LANGUAGE plpgsql STABLE
  AS $$ BEGIN RETURN (SELECT id FROM test_dan1066.actor_v); END $$;
CREATE FUNCTION test_dan1066.cmt() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT app.current_user_id/* /* */ */() $$;
CREATE FUNCTION test_dan1066.cr() RETURNS uuid LANGUAGE sql STABLE AS E'SELECT app.current_user_id -- x\r()';
CREATE FUNCTION test_dan1066.loud() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT APP.CURRENT_USER_ID() $$;
CREATE FUNCTION test_dan1066.show_all() RETURNS int LANGUAGE sql STABLE AS $$ SELECT count(*)::int FROM pg_show_all_settings() $$;
CREATE FUNCTION test_dan1066."who[1]"() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT app.current_user_id() $$;
CREATE FUNCTION test_dan1066.bracket() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT test_dan1066."who[1]"() $$;
CREATE TYPE test_dan1066.tag AS (v uuid);
CREATE TABLE test_dan1066.tagged (v uuid);
CREATE FUNCTION test_dan1066.pick(r test_dan1066.tagged) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT app.current_user_id() $$;
CREATE FUNCTION test_dan1066.wrap(r test_dan1066.tag) RETURNS uuid LANGUAGE sql STABLE SET search_path = test_dan1066
  AS $$ SELECT t.pick FROM test_dan1066.tagged t WHERE t.v = r.v $$;
CREATE FUNCTION test_dan1066.to_tag(text) RETURNS test_dan1066.tag LANGUAGE sql STABLE
  AS $$ SELECT ROW(app.current_user_id())::test_dan1066.tag $$;
CREATE CAST (text AS test_dan1066.tag) WITH FUNCTION test_dan1066.to_tag(text);
CREATE DOMAIN test_dan1066.mine_id AS uuid CHECK (VALUE = app.current_user_id());
CREATE FUNCTION test_dan1066.is_me(a uuid, b uuid DEFAULT app.current_user_id()) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT $1 = $2 $$;
CREATE FUNCTION test_dan1066.sf(boolean, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE
  AS $$ SELECT coalesce($1, false) OR $2 IS NOT NULL $$;
CREATE FUNCTION test_dan1066.ff(boolean) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT $1 AND app.current_user_id() IS NOT NULL $$;
CREATE AGGREGATE test_dan1066.any_mine(uuid) (SFUNC = test_dan1066.sf, STYPE = boolean, FINALFUNC = test_dan1066.ff);

-- Readers are functions and views, each matched by its name as a whole word.
-- A function's text is its body, its argument defaults and, for an
-- aggregate, its support functions.
CREATE TEMP TABLE identity_reader AS
  WITH RECURSIVE obj (kind, oid, name, body) AS (
    SELECT 'f', p.oid, p.proname::text,
           concat_ws(' ', coalesce(pg_get_function_sqlbody(p.oid), p.prosrc), pg_get_function_arguments(p.oid),
                     (SELECT string_agg(s.proname || '()', ' ') FROM pg_aggregate a, pg_proc s
                      WHERE a.aggfnoid = p.oid AND s.oid IN (a.aggtransfn, a.aggfinalfn, a.aggcombinefn,
                        a.aggserialfn, a.aggdeserialfn, a.aggmtransfn, a.aggminvtransfn, a.aggmfinalfn)))
    FROM pg_proc p WHERE p.oid >= 16384
    UNION ALL
    SELECT 'v', c.oid, c.relname::text, pg_get_viewdef(c.oid) FROM pg_class c WHERE c.oid >= 16384 AND c.relkind = 'v'
  ), r (kind, oid, name) AS (
    SELECT 'f', p.oid, p.proname::text FROM pg_proc p
    WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname IN ('current_setting', 'pg_show_all_settings')
    UNION SELECT 'v', 'pg_catalog.pg_settings'::regclass::oid, 'pg_settings'
    UNION
    SELECT o.kind, o.oid, o.name FROM obj o, r
    WHERE o.body ~* ('(^|[^\w$])' || regexp_replace(r.name, '(\W)', '\\\1', 'g') || '($|[^\w$])')
  )
  SELECT kind, oid FROM r;
CREATE TEMP VIEW identity_fn AS SELECT oid FROM identity_reader WHERE kind = 'f';

-- Calls the node tree of a policy does not show: an operator, cast or domain
-- CHECK that reads the session, and a policy that reads a view.
CREATE TEMP VIEW hidden_reader AS
  SELECT 'operator ' || o.oid::regoperator::text AS found FROM pg_operator o
  WHERE o.oid >= 16384 AND o.oprcode::oid IN (SELECT oid FROM identity_fn)
  UNION ALL
  SELECT 'cast ' || k.castsource::regtype || ' as ' || k.casttarget::regtype FROM pg_cast k
  WHERE k.oid >= 16384 AND k.castfunc IN (SELECT oid FROM identity_fn)
  UNION
  SELECT 'domain ' || d.contypid::regtype FROM pg_constraint d, regexp_matches(d.conbin::text, ':funcid (\d+)', 'g') m
  WHERE d.contypid <> 0 AND m[1]::oid IN (SELECT oid FROM identity_fn)
  UNION ALL
  SELECT 'policy ' || p.polname FROM pg_policy p
  WHERE coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, '') ~ ':relkind v ';

-- One InitPlan: {SUBLINK} of type 4 (EXPR) over a {QUERY} that holds no
-- other node than its one target, a {FUNCEXPR} whose args are {CONST}s.
CREATE TEMP VIEW per_row_call AS
  SELECT c.relnamespace::regnamespace::text AS nsp, c.relname::text AS tbl, format('%s.%s: %s', c.relname, p.polname,
                string_agg(x.fn::regprocedure::text, ', ' ORDER BY x.fn::regprocedure::text)) AS found
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  CROSS JOIN LATERAL regexp_replace(
    coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, ''),
    '\{SUBLINK :subLinkType 4 :subLinkId 0 :testexpr <> :operName <> :subselect \{QUERY :commandType 1 [^{}]*'
    ':rtable <> [^{}]*:jointree \{FROMEXPR :fromlist <> :quals <>\} [^{}]*'
    ':targetList \(\{TARGETENTRY :expr \{FUNCEXPR :funcid \d+ [^{}]*:args (<>|\((\{CONST [^{}]*\} ?)+\)) [^{}]*\}'
    ' [^{}]*\}\) [^{}]*\} [^{}]*\}',
    '', 'g') AS rest
  CROSS JOIN LATERAL (
    SELECT m[1]::oid AS fn FROM regexp_matches(rest, ':(?:funcid|aggfnoid|winfnoid) (\d+)', 'g') m
    UNION ALL
    SELECT o.oprcode::oid FROM regexp_matches(rest, ':opno (\d+)', 'g') m JOIN pg_operator o ON o.oid = m[1]::oid
  ) x
  WHERE x.fn IN (SELECT oid FROM identity_fn)
  GROUP BY c.relnamespace, c.relname, p.polname;

-- 1. Negative controls, each on its own table t1066_<case>: n_ is a call per
-- row and must be caught, p_ is an allowed shape and must not be.
CREATE TEMP TABLE probe_case (name text PRIMARY KEY, kind text NOT NULL, expr text NOT NULL);
INSERT INTO probe_case VALUES
  ('n_direct', 'USING', 'owner = app.current_user_id()'),
  ('n_check', 'WITH CHECK', 'owner = app.current_user_id()'),
  ('n_bare', 'USING', 'institution.actor_has_role(''admin'')'),
  ('n_row_arg', 'USING', '(SELECT institution.actor_has_role(label))'),
  ('n_correlated', 'USING', 'owner = (SELECT app.current_user_id() WHERE label IS NOT NULL)'),
  ('n_union', 'USING', 'owner = (SELECT app.current_user_id() UNION SELECT owner)'),
  ('n_in', 'USING', 'owner IN (SELECT app.current_user_id())'),
  ('n_exists', 'USING', 'EXISTS (SELECT 1 FROM app.current_actor() a WHERE a.user_id = owner)'),
  ('n_setting', 'USING', 'label = current_setting(''app.session_token'', true)'),
  ('n_coalesce', 'USING', 'owner = coalesce(app.current_user_id(), owner)'),
  ('n_case', 'USING', 'CASE WHEN label = ''x'' THEN owner = app.current_institution_id() END'),
  ('n_depth', 'USING', 'owner = test_dan1066.f2()'),
  ('n_view', 'USING', 'owner = test_dan1066.via_view()'),
  ('n_comment', 'USING', 'owner = test_dan1066.cmt()'),
  ('n_field', 'USING', 'owner = test_dan1066.wrap(ROW(owner)::test_dan1066.tag)'),
  ('n_window', 'USING', '(SELECT bool_or(m) FROM (SELECT test_dan1066.any_mine(x) OVER () AS m FROM unnest(ARRAY[owner]) x) s)'),
  ('n_default', 'USING', 'test_dan1066.is_me(owner)'),
  ('n_aggregate', 'USING', '(SELECT test_dan1066.any_mine(x) FROM unnest(ARRAY[owner]) x)'),
  ('n_having', 'USING', 'owner = (SELECT app.current_user_id() HAVING label IS NOT NULL)'),
  ('n_limit', 'USING', 'owner = (SELECT app.current_user_id() LIMIT CASE WHEN label IS NULL THEN 0 END)'),
  ('n_offset', 'USING', 'owner = (SELECT app.current_user_id() OFFSET CASE WHEN label IS NULL THEN 1 END)'),
  ('n_cte', 'USING', 'owner = (WITH w AS (SELECT label) SELECT app.current_user_id())'),
  ('n_operator', 'USING', 'owner OPERATOR(test_dan1066.===) owner'),
  ('n_restrictive', 'AS RESTRICTIVE USING', 'owner = app.current_user_id()'),
  ('n_twice', 'USING', 'owner = (SELECT app.current_user_id()) OR owner = app.current_user_id()'),
  ('p_initplan', 'USING', 'owner = (SELECT app.current_user_id())'),
  ('p_any', 'USING', 'owner = ANY ((SELECT institution.actor_course_ids(''{teacher}''))::uuid[])'),
  ('p_check', 'WITH CHECK', '(SELECT institution.actor_has_role(''admin'')) AND label IS NOT NULL'),
  ('p_plain', 'USING', 'test_dan1066.shout(label) = ''X''');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM probe_case LOOP
    EXECUTE format('CREATE TABLE test_dan1066.%I (owner uuid, label text)', 't1066_' || r.name);
    EXECUTE format('ALTER TABLE test_dan1066.%I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', 't1066_' || r.name);
    EXECUTE format('GRANT SELECT, INSERT ON test_dan1066.%I TO ductus_app', 't1066_' || r.name);
    EXECUTE format('CREATE POLICY %I ON test_dan1066.%I %s (%s)', r.name, 't1066_' || r.name, r.kind, r.expr);
  END LOOP;
END
$$;
-- A temporary table is caught as well.
CREATE TEMP TABLE t1066_n_temp (owner uuid);
CREATE POLICY n_temp ON t1066_n_temp USING (owner = app.current_user_id());

SELECT set_eq(
  $$ SELECT found FROM per_row_call WHERE tbl LIKE 't1066\_%' $$,
  ARRAY['t1066_n_direct.n_direct: app.current_user_id()',
        't1066_n_check.n_check: app.current_user_id()',
        't1066_n_bare.n_bare: institution.actor_has_role(text)',
        't1066_n_row_arg.n_row_arg: institution.actor_has_role(text)',
        't1066_n_correlated.n_correlated: app.current_user_id()',
        't1066_n_union.n_union: app.current_user_id()',
        't1066_n_in.n_in: app.current_user_id()',
        't1066_n_exists.n_exists: app.current_actor()',
        't1066_n_setting.n_setting: current_setting(text,boolean)',
        't1066_n_coalesce.n_coalesce: app.current_user_id()',
        't1066_n_case.n_case: app.current_institution_id()',
        't1066_n_depth.n_depth: test_dan1066.f2()',
        't1066_n_view.n_view: test_dan1066.via_view()',
        't1066_n_comment.n_comment: test_dan1066.cmt()',
        't1066_n_field.n_field: test_dan1066.wrap(test_dan1066.tag)',
        't1066_n_window.n_window: test_dan1066.any_mine(uuid)',
        't1066_n_default.n_default: test_dan1066.is_me(uuid,uuid)',
        't1066_n_aggregate.n_aggregate: test_dan1066.any_mine(uuid)',
        't1066_n_having.n_having: app.current_user_id()',
        't1066_n_limit.n_limit: app.current_user_id()',
        't1066_n_offset.n_offset: app.current_user_id()',
        't1066_n_cte.n_cte: app.current_user_id()',
        't1066_n_operator.n_operator: test_dan1066.mine(uuid,uuid)',
        't1066_n_restrictive.n_restrictive: app.current_user_id()',
        't1066_n_twice.n_twice: app.current_user_id()',
        't1066_n_temp.n_temp: app.current_user_id()'],
  'every call per row is caught, once per call, and none of the InitPlan shapes or a plain function is'
);

CREATE TABLE test_dan1066.t1066_hv (owner uuid);
CREATE POLICY hv_view ON test_dan1066.t1066_hv USING (owner IN (SELECT id FROM test_dan1066.actor_v));
SELECT set_eq(
  $$ SELECT found FROM hidden_reader WHERE found ~ '(test_dan1066|hv_view)' $$,
  ARRAY['operator test_dan1066.===(uuid,uuid)', 'cast text as test_dan1066.tag', 'domain test_dan1066.mine_id',
        'policy hv_view'],
  'an operator, a cast and a domain CHECK that read the session, and a policy that reads a view, are caught'
);

-- 2. The closure: the functions that read the session, also through others.
SELECT ok(
  (SELECT array_agg(oid::regprocedure::text) FROM identity_fn) @> ARRAY[
    'app.current_actor()', 'app.current_user_id()', 'app.current_institution_id()',
    'institution.actor_has_role(text)', 'institution.actor_course_ids(text[])',
    'institution.actor_assignment_ids(text[])', 'institution.work_accommodation(uuid,uuid)',
    'test_dan1066.f1()', 'test_dan1066.f2()', 'test_dan1066.mine(uuid,uuid)',
    'test_dan1066.token()', 'test_dan1066.via_token()', 'test_dan1066.via_view()',
    'test_dan1066.cmt()', 'test_dan1066.is_me(uuid,uuid)', 'test_dan1066.any_mine(uuid)', 'test_dan1066.cr()',
    'test_dan1066.loud()', 'test_dan1066.show_all()', 'test_dan1066.bracket()', 'test_dan1066.wrap(test_dan1066.tag)'],
  'the identity functions include the session readers and whatever calls them, at any depth'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM identity_fn WHERE oid = 'test_dan1066.shout(text)'::regprocedure),
  'a function that does not read the session is not an identity function'
);

-- 3. The text matches the plan: the call per row is in the Filter, the
-- allowed shape is an InitPlan.
CREATE FUNCTION pg_temp.plan(p_tbl text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_plan text := '';
  r record;
BEGIN
  SET LOCAL ROLE ductus_app;
  FOR r IN EXECUTE format('EXPLAIN (COSTS OFF) SELECT * FROM test_dan1066.%I', p_tbl) LOOP
    v_plan := v_plan || r."QUERY PLAN" || E'\n';
  END LOOP;
  RESET ROLE;
  RETURN v_plan;
END
$$;
SELECT ok(
  pg_temp.plan('t1066_n_direct') ~ 'Filter: [^\n]*current_user_id\(\)' AND pg_temp.plan('t1066_n_direct') !~ 'InitPlan',
  'the plan of a direct call runs it in the Filter, per row'
);
SELECT ok(
  pg_temp.plan('t1066_p_initplan') ~ 'InitPlan' AND pg_temp.plan('t1066_p_initplan') !~ 'Filter: [^\n]*current_user_id\(\)',
  'the plan of the allowed shape runs it as an InitPlan, once'
);
DROP SCHEMA test_dan1066 CASCADE;
DROP TABLE t1066_n_temp;

-- 4. The database as migrated: one named exception with exactly one call
-- per row, and the check has something to read.
SELECT set_eq(
  $$ SELECT nsp || '.' || found FROM per_row_call $$,
  ARRAY['institution.work_accommodation.work_accommodation_read: institution.work_accommodation(uuid,uuid)'],
  'no policy of the database calls an identity function per row, but the one named exception'
);
SELECT cmp_ok(
  (SELECT count(DISTINCT p.oid)::int FROM pg_policy p,
          regexp_matches(coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, ''), ':funcid (\d+)', 'g') m
   WHERE m[1]::oid IN (SELECT oid FROM identity_fn)),
  '>=', 30,
  'at least 30 policies of the database read the session, all as InitPlans but the exception'
);
SELECT is_empty('SELECT found FROM hidden_reader',
  'no operator, cast or domain CHECK of the database reads the session, and no policy reads a view');

SELECT * FROM finish();
ROLLBACK;
