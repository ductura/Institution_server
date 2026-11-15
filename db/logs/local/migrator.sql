-- Local and CI stack only (compose.yaml, service postgres-logs); `pnpm
-- db:migrate` runs it in ductus_logs before dbmate. It stands in for the
-- provisioning staging and production get in B0.1 (S-1F-c, DAN-779), as
-- db/main/local/migrator.sql does for the main database: the roles of the
-- logs database exist before the first migration and the migrator owns the
-- database. Run it again at any time: a role that is already right stays.
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
  logs_roles CONSTANT text[] := ARRAY[
    'ductus_logs_migrator',  -- the one role with DDL; owns ductus_logs
    'ductus_logs_writer',    -- appends log records
    'ductus_logs_reader',    -- reads log records
    'ductus_logs_retention'  -- deletes log records past their term
  ];
  role_name text;
BEGIN
  IF pg_catalog.current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'db/logs/local/migrator.sql runs only in ductus_logs (current: %)', pg_catalog.current_database();
  END IF;

  FOREACH role_name IN ARRAY logs_roles LOOP
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
  WHERE rolname = ANY (logs_roles)
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % already exists with LOGIN or an elevated attribute', role_name;
  END IF;
  SELECT m.member::regrole::text INTO role_name FROM pg_catalog.pg_auth_members m
  WHERE m.member::regrole::text = ANY (logs_roles)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % is a member of another role', role_name;
  END IF;

  EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO ductus_logs_migrator', pg_catalog.current_database());
  -- A database migrated before this file ran keeps its ledger.
  IF pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL THEN
    ALTER TABLE public.schema_migrations OWNER TO ductus_logs_migrator;
  END IF;
END
$$;
COMMIT;
