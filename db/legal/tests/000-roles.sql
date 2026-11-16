-- S-1F-d (DAN-797): the roles of the legal texts database and the rights between the
-- databases of the server. Every role of this database exists, may not log in
-- or act above itself and is a member of nothing; the database and its public
-- schema grant exactly the rights below and nothing to PUBLIC or to a role of
-- another database; no role of this database reaches another database of the
-- server, directly, through PUBLIC or by membership; and no role reaches both
-- this database and another one (a login in both would carry data across).
-- db/logs/tests/000-roles.sql holds the same for the logs database. The legal
-- database shares its cluster with the main one (S-1F-c a2), so every role of
-- the main database exists here and the cross checks run against the real
-- main database; see server/database/README.md.
--
-- Rights are read from the catalogue (the ACL of each database and of the
-- public schema), never from a list of what a migration meant to grant.
-- Superusers are left out: they reach everything by design and only B0.1 makes
-- them. The negative controls are made inside the transaction, seen, and
-- taken back; the file rolls back, so nothing stays.
--
-- The search path and the guard against planted functions are those of
-- 000-rls-everywhere.sql.
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


SELECT plan(21);

-- The roles of this database, and the other databases of the server: a right
-- that crosses between them is what this file looks for. Only the databases
-- that exist in this cluster are seen: the main one does (checked below), the
-- logs one has a cluster of its own.
CREATE TABLE pg_temp.own_role (name text PRIMARY KEY);
INSERT INTO pg_temp.own_role VALUES ('ductus_legal_migrator'), ('ductus_legal_app');
CREATE TABLE pg_temp.other_database (name text PRIMARY KEY);
INSERT INTO pg_temp.other_database VALUES ('ductus'), ('ductus_logs');

-- The rights each database grants, read from its ACL. A NULL ACL is the
-- default one, which gives PUBLIC CONNECT and TEMPORARY, so it is expanded.
-- The public schema is owned by pg_database_owner, which stands for the owner
-- of the database, the migrator.
CREATE TABLE pg_temp.expected_database_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_database_right VALUES
  ('ductus_legal_migrator: OWNER'), ('ductus_legal_migrator: CREATE'), ('ductus_legal_migrator: TEMPORARY'), ('ductus_legal_migrator: CONNECT'),
  ('ductus_legal_app: CONNECT');
CREATE TABLE pg_temp.expected_schema_right (found text PRIMARY KEY);
INSERT INTO pg_temp.expected_schema_right VALUES
  ('pg_database_owner: OWNER'), ('pg_database_owner: USAGE'), ('pg_database_owner: CREATE'), ('ductus_legal_app: USAGE');

-- Ownership counts as a right (an owner may grant itself anything, or drop
-- the database), and so does a grant option (its holder may open the database
-- to anyone).
CREATE VIEW pg_temp.database_right AS
  SELECT d.datname::text AS database, a.grantee,
         a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END AS privilege,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee_name
  FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  UNION ALL
  SELECT d.datname::text, d.datdba, 'OWNER', d.datdba::regrole::text FROM pg_database d;

-- A role of this database that is missing, may log in, has an elevated
-- attribute, or is a member of another role.
CREATE VIEW pg_temp.role_gap AS
  SELECT o.name || ': missing' AS found FROM pg_temp.own_role o
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = o.name)
  UNION ALL SELECT r.rolname || ': LOGIN or an elevated attribute'
  FROM pg_roles r JOIN pg_temp.own_role o ON o.name = r.rolname
  WHERE r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
  UNION ALL SELECT m.member::regrole::text || ': member of ' || m.roleid::regrole::text
  FROM pg_auth_members m JOIN pg_temp.own_role o ON o.name = m.member::regrole::text;

-- What this database and its public schema grant, against what they should:
-- + a right that should not be there, - one that is missing.
CREATE VIEW pg_temp.database_drift AS
  (SELECT '+' || x.found AS found FROM (
     SELECT grantee_name || ': ' || privilege AS found FROM pg_temp.database_right
     WHERE database = current_database()
     EXCEPT SELECT found FROM pg_temp.expected_database_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (
     SELECT found FROM pg_temp.expected_database_right
     EXCEPT SELECT grantee_name || ': ' || privilege FROM pg_temp.database_right
     WHERE database = current_database()) x);
CREATE VIEW pg_temp.schema_right AS
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ': ' || a.privilege_type
         || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END AS found
  FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
  WHERE n.nspname = 'public'
  UNION ALL SELECT n.nspowner::regrole::text || ': OWNER' FROM pg_namespace n WHERE n.nspname = 'public';
CREATE VIEW pg_temp.schema_drift AS
  (SELECT '+' || x.found AS found FROM (
     SELECT found FROM pg_temp.schema_right EXCEPT SELECT found FROM pg_temp.expected_schema_right) x)
  UNION ALL
  (SELECT '-' || x.found FROM (
     SELECT found FROM pg_temp.expected_schema_right EXCEPT SELECT found FROM pg_temp.schema_right) x);

-- A right on another database of the server that a role of this database
-- reaches: granted to it, to PUBLIC, or to a role it may become (MEMBER:
-- inherited or by SET ROLE).
CREATE VIEW pg_temp.own_elsewhere AS
  SELECT o.name || ' reaches ' || r.database || ': ' || r.privilege
         || CASE WHEN r.grantee_name = o.name THEN '' ELSE ' via ' || r.grantee_name END AS found
  FROM pg_temp.database_right r
  JOIN pg_temp.other_database x ON x.name = r.database
  CROSS JOIN pg_temp.own_role o
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = o.name)
    AND (r.grantee = 0 OR pg_has_role(o.name, r.grantee, 'MEMBER'));

-- A role, a login above all, that may become both a grantee of this database
-- and a grantee of another database of the server.
CREATE VIEW pg_temp.bridge AS
  SELECT DISTINCT m.rolname || ': ' || h.database || ' via ' || h.grantee_name
         || ' and ' || e.database || ' via ' || e.grantee_name AS found
  FROM pg_roles m
  JOIN pg_temp.database_right h
    ON h.database = current_database() AND h.grantee <> 0 AND pg_has_role(m.oid, h.grantee, 'MEMBER')
  JOIN pg_temp.database_right e
    ON e.database IN (SELECT name FROM pg_temp.other_database) AND e.grantee <> 0
   AND pg_has_role(m.oid, e.grantee, 'MEMBER')
  WHERE NOT m.rolsuper;

-- 1. The database as migrated.
SELECT ok(EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ductus'),
  'the main database shares this cluster, so the cross checks below are not empty');
SELECT is_empty('SELECT found FROM pg_temp.role_gap',
  'every role of the legal database exists, has no LOGIN or elevated attribute and is a member of nothing');
SELECT is((SELECT datdba::regrole::text FROM pg_database WHERE datname = current_database()),
  'ductus_legal_migrator', 'the legal database is owned by its migrator');
SELECT is_empty('SELECT found FROM pg_temp.database_drift',
  'the legal database grants exactly its own roles, nothing to PUBLIC or to a role of the main database');
SELECT is_empty('SELECT found FROM pg_temp.schema_drift',
  'the public schema: owned by pg_database_owner, CREATE only for the owner, USAGE only for the app');
SELECT is_empty('SELECT found FROM pg_temp.own_elsewhere',
  'no role of the legal database reaches the main database or another database of the server');
SELECT is_empty('SELECT found FROM pg_temp.bridge',
  'no role, no login of the main database either, reaches both the legal database and another one');
SELECT ok(EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '20261115130000'),
  'the roles migration of the legal database is in its ledger');

-- 2. Negative controls: each break of the rules is caught.
ALTER ROLE ductus_legal_app LOGIN;
SELECT set_eq('SELECT found FROM pg_temp.role_gap', ARRAY['ductus_legal_app: LOGIN or an elevated attribute'],
  'a role of the database that may log in is caught');
ALTER ROLE ductus_legal_app NOLOGIN;

CREATE ROLE test_roles_probe NOLOGIN;
GRANT CONNECT ON DATABASE ductus_legal TO test_roles_probe;
SELECT set_eq('SELECT found FROM pg_temp.database_drift', ARRAY['+test_roles_probe: CONNECT'],
  'CONNECT granted to a role that is not of this database is caught');
REVOKE CONNECT ON DATABASE ductus_legal FROM test_roles_probe;
DROP ROLE test_roles_probe;

GRANT TEMPORARY ON DATABASE ductus_legal TO PUBLIC;
SELECT set_eq('SELECT found FROM pg_temp.database_drift', ARRAY['+PUBLIC: TEMPORARY'],
  'a right granted to PUBLIC is caught');
REVOKE TEMPORARY ON DATABASE ductus_legal FROM PUBLIC;

GRANT CONNECT ON DATABASE ductus_legal TO ductus_legal_app WITH GRANT OPTION;
SELECT set_eq('SELECT found FROM pg_temp.database_drift',
  ARRAY['+ductus_legal_app: CONNECT WITH GRANT OPTION', '-ductus_legal_app: CONNECT'],
  'a right with GRANT OPTION, which would let its holder open the database to anyone, is caught');
REVOKE GRANT OPTION FOR CONNECT ON DATABASE ductus_legal FROM ductus_legal_app;

ALTER SCHEMA public OWNER TO ductus_legal_app;
SELECT isnt_empty($$ SELECT found FROM pg_temp.schema_drift WHERE found = '+ductus_legal_app: OWNER' $$,
  'the public schema owned by a role other than pg_database_owner is caught');
ALTER SCHEMA public OWNER TO pg_database_owner;
-- The owner change folded ductus_legal_app's USAGE into the owner's entry; it is given back.
GRANT USAGE ON SCHEMA public TO ductus_legal_app;

GRANT CREATE ON SCHEMA public TO ductus_legal_app;
SELECT set_eq('SELECT found FROM pg_temp.schema_drift', ARRAY['+ductus_legal_app: CREATE'],
  'CREATE on the public schema for the app is caught');
REVOKE CREATE ON SCHEMA public FROM ductus_legal_app;

-- A role of the main database let into the legal one.
GRANT CONNECT ON DATABASE ductus_legal TO ductus_app;
SELECT set_eq('SELECT found FROM pg_temp.database_drift', ARRAY['+ductus_app: CONNECT'],
  'CONNECT on the legal database for the main web role is caught');
SELECT set_eq($$ SELECT found FROM pg_temp.bridge WHERE found LIKE 'ductus\_app:%' $$,
  ARRAY['ductus_app: ductus_legal via ductus_app and ductus via ductus_app'],
  'the main web role then reaches both databases, and is caught as a bridge');
REVOKE CONNECT ON DATABASE ductus_legal FROM ductus_app;

-- A role of the legal database let into the main one.
GRANT CONNECT ON DATABASE ductus TO ductus_legal_app;
SELECT set_eq('SELECT found FROM pg_temp.own_elsewhere', ARRAY['ductus_legal_app reaches ductus: CONNECT'],
  'CONNECT on the main database for the legal app is caught');
REVOKE CONNECT ON DATABASE ductus FROM ductus_legal_app;
GRANT CONNECT ON DATABASE ductus TO PUBLIC;
SELECT set_eq('SELECT found FROM pg_temp.own_elsewhere',
  ARRAY['ductus_legal_migrator reaches ductus: CONNECT via PUBLIC', 'ductus_legal_app reaches ductus: CONNECT via PUBLIC'],
  'the main database open to PUBLIC is caught for every role of the legal database');
REVOKE CONNECT ON DATABASE ductus FROM PUBLIC;

-- The legal migrator owning the main database.
ALTER DATABASE ductus OWNER TO ductus_legal_migrator;
SELECT isnt_empty($$ SELECT found FROM pg_temp.own_elsewhere WHERE found = 'ductus_legal_migrator reaches ductus: OWNER' $$,
  'the legal migrator owning the main database is caught');
ALTER DATABASE ductus OWNER TO ductus_migrator;

-- A login of the legal app that is also a login of the main web role.
CREATE ROLE test_roles_login LOGIN IN ROLE ductus_legal_app, ductus_app;
SELECT set_eq($$ SELECT found FROM pg_temp.bridge WHERE found LIKE 'test\_roles\_login:%' $$,
  ARRAY['test_roles_login: ductus_legal via ductus_legal_app and ductus via ductus_app'],
  'a login that is a member of the legal app and of the main web role is caught');
DROP ROLE test_roles_login;

SELECT is_empty($$
  SELECT found FROM pg_temp.role_gap UNION ALL SELECT found FROM pg_temp.database_drift
  UNION ALL SELECT found FROM pg_temp.schema_drift UNION ALL SELECT found FROM pg_temp.own_elsewhere
  UNION ALL SELECT found FROM pg_temp.bridge $$,
  'the database is clean again once the controls are taken back');

SELECT * FROM finish();
ROLLBACK;
