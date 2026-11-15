-- Local and CI stack only (compose.yaml, service postgres-main); `pnpm
-- db:migrate:legal` runs it in ductus_legal, after create-database.sql and
-- before dbmate. It stands in for the provisioning staging and production get
-- in B0.1 (S-1F-c a2, DAN-779), as db/logs/local/migrator.sql does for the
-- logs database: the roles of the legal database exist before the first
-- migration and the migrator owns the database. Run it again at any time: a
-- role that is already right stays.
--
-- Unlike ductus_migrator, no role here has CREATEROLE: the roles are made
-- only here (B0.1), and the migrations only check them. No role has LOGIN;
-- logins join a group role later, so no password lives in this file.
--
-- It runs as a superuser in a database the migrator owns, and an owner can
-- set the database's search_path and put functions in public. So nothing
-- here resolves through search_path: it is pg_catalog only for this one
-- transaction (SET LOCAL, so the session keeps its own), and every call is
-- qualified.
BEGIN;
SET LOCAL search_path = pg_catalog;
DO $$
DECLARE
  legal_roles CONSTANT text[] := ARRAY[
    'ductus_legal_migrator', -- the one role with DDL; owns ductus_legal
    'ductus_legal_app'       -- the web process reads and records legal texts
  ];
  role_name text;
BEGIN
  IF pg_catalog.current_database() <> 'ductus_legal' THEN
    RAISE EXCEPTION 'db/legal/local/migrator.sql runs only in ductus_legal (current: %)', pg_catalog.current_database();
  END IF;

  FOREACH role_name IN ARRAY legal_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        role_name
      );
    END IF;
  END LOOP;

  -- A role left over with LOGIN or an elevated attribute, or one that is a
  -- member of another role, is not repaired: B0.1 stops the same way.
  SELECT rolname INTO role_name FROM pg_catalog.pg_roles
  WHERE rolname = ANY (legal_roles)
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % already exists with LOGIN or an elevated attribute', role_name;
  END IF;
  SELECT m.member::regrole::text INTO role_name FROM pg_catalog.pg_auth_members m
  WHERE m.member::regrole::text = ANY (legal_roles)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % is a member of another role', role_name;
  END IF;
  -- Nobody may administer a legal role (in PostgreSQL 16 a CREATEROLE role
  -- that made one does, ductus_migrator among them), nobody may be a member
  -- of the migrator, and only logins may join the app: a group role would
  -- hand the app's rights to all its members.
  SELECT m.roleid::regrole::text || ' by ' || m.member::regrole::text INTO role_name
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid OPERATOR(pg_catalog.=) m.member
  WHERE m.roleid::regrole::text = ANY (legal_roles)
    AND (m.admin_option OR m.roleid::regrole::text = 'ductus_legal_migrator' OR NOT r.rolcanlogin)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'grant of % is not allowed: no ADMIN, no member of the migrator, only logins in the app', role_name;
  END IF;

  EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO ductus_legal_migrator', pg_catalog.current_database());
  -- A database migrated before this file ran keeps its ledger.
  IF pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL THEN
    ALTER TABLE public.schema_migrations OWNER TO ductus_legal_migrator;
  END IF;
END
$$;
COMMIT;
