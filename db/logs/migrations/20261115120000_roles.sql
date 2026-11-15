-- migrate:up
-- The roles of the logs database (S-1F-c, DAN-779). They are made before the
-- first migration (db/logs/local/migrator.sql locally, B0.1 in staging and
-- production); this migration makes none, it checks them and opens the
-- database to exactly them. Tables, their RLS and their grants come with the
-- migrations that create them.
DO $$
DECLARE
  logs_roles CONSTANT text[] := ARRAY[
    'ductus_logs_migrator', 'ductus_logs_writer', 'ductus_logs_reader', 'ductus_logs_retention'
  ];
  role_name text;
BEGIN
  IF current_user <> 'ductus_logs_migrator' OR current_database() <> 'ductus_logs' THEN
    RAISE EXCEPTION 'logs migrations run only as ductus_logs_migrator in ductus_logs (current: % in %)',
      current_user, current_database();
  END IF;

  FOREACH role_name IN ARRAY logs_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'role % is missing; it is provisioned before the first migration', role_name;
    END IF;
  END LOOP;

  -- No role of this database may log in, act as a superuser, bypass RLS or
  -- make roles or databases. Only a superuser could take that away again, so
  -- the migration stops instead.
  SELECT rolname INTO role_name FROM pg_catalog.pg_roles
  WHERE rolname = ANY (logs_roles)
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % has LOGIN or an elevated attribute', role_name;
  END IF;
  -- A membership could hand on another role's rights, or SET ROLE to a
  -- superuser; these roles are members of nothing.
  SELECT m.member::regrole::text INTO role_name FROM pg_catalog.pg_auth_members m
  WHERE m.member::regrole::text = ANY (logs_roles)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % is a member of another role', role_name;
  END IF;

  IF (SELECT datdba::regrole::text FROM pg_catalog.pg_database WHERE datname = current_database())
     <> 'ductus_logs_migrator' THEN
    RAISE EXCEPTION 'ductus_logs is not owned by ductus_logs_migrator';
  END IF;

  -- Nobody reaches the database by default; the three group roles connect.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ductus_logs_writer, ductus_logs_reader, ductus_logs_retention',
    current_database()
  );
END
$$;

-- Only the migrator (the owner) creates in the public schema; the group roles
-- may use it, PUBLIC may not.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ductus_logs_writer, ductus_logs_reader, ductus_logs_retention;
-- Functions the migrator makes are not executable by PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE ductus_logs_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- migrate:down
ALTER DEFAULT PRIVILEGES FOR ROLE ductus_logs_migrator GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
REVOKE USAGE ON SCHEMA public FROM ductus_logs_writer, ductus_logs_reader, ductus_logs_retention;
GRANT USAGE ON SCHEMA public TO PUBLIC;
DO $$
BEGIN
  EXECUTE format(
    'REVOKE ALL ON DATABASE %I FROM ductus_logs_writer, ductus_logs_reader, ductus_logs_retention',
    current_database()
  );
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END
$$;
