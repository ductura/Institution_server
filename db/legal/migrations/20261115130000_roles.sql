-- migrate:up
-- The roles of the legal texts database (S-1F-c a2, DAN-779). They are made
-- before the first migration (db/legal/local/migrator.sql locally, B0.1 in
-- staging and production); this migration makes none, it checks them and
-- opens the database to exactly them. The database shares its cluster with
-- the main database, so every main role exists here too and only these
-- grants keep it out. Tables (S-1N-a), their RLS and their grants come with
-- the migrations that create them.
DO $$
DECLARE
  legal_roles CONSTANT text[] := ARRAY['ductus_legal_migrator', 'ductus_legal_app'];
  role_name text;
BEGIN
  IF current_user <> 'ductus_legal_migrator' OR current_database() <> 'ductus_legal' THEN
    RAISE EXCEPTION 'legal migrations run only as ductus_legal_migrator in ductus_legal (current: % in %)',
      current_user, current_database();
  END IF;

  FOREACH role_name IN ARRAY legal_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'role % is missing; it is provisioned before the first migration', role_name;
    END IF;
  END LOOP;

  -- No role of this database may log in, act as a superuser, bypass RLS or
  -- make roles or databases. Only a superuser could take that away again, so
  -- the migration stops instead.
  SELECT rolname INTO role_name FROM pg_catalog.pg_roles
  WHERE rolname = ANY (legal_roles)
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role % has LOGIN or an elevated attribute', role_name;
  END IF;
  -- A membership could hand on another role's rights, or SET ROLE to a
  -- superuser; these roles are members of nothing.
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

  IF (SELECT datdba::regrole::text FROM pg_catalog.pg_database WHERE datname = current_database())
     <> 'ductus_legal_migrator' THEN
    RAISE EXCEPTION 'ductus_legal is not owned by ductus_legal_migrator';
  END IF;

  -- Nobody reaches the database or the public schema by default, no main role
  -- either: every grant to anyone but the owner is taken back, then the app
  -- connects. A grant made before this migration (B0.1, a stray hand) does
  -- not survive it.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  FOR role_name IN
    SELECT DISTINCT a.grantee::regrole::text
    FROM pg_catalog.pg_database d, aclexplode(d.datacl) a
    WHERE d.datname = current_database() AND a.grantee <> 0 AND a.grantee <> d.datdba
  LOOP
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), role_name);
  END LOOP;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT a.grantee::regrole::text
    FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
    WHERE n.nspname = 'public' AND a.grantee <> 0 AND a.grantee <> n.nspowner
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role_name);
  END LOOP;
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ductus_legal_app',
    current_database()
  );
END
$$;

-- Only the migrator (the owner) creates in the public schema; the app may use
-- it, PUBLIC may not.
GRANT USAGE ON SCHEMA public TO ductus_legal_app;
-- Functions the migrator makes are not executable by PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE ductus_legal_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- migrate:down
ALTER DEFAULT PRIVILEGES FOR ROLE ductus_legal_migrator GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
REVOKE USAGE ON SCHEMA public FROM ductus_legal_app;
GRANT USAGE ON SCHEMA public TO PUBLIC;
DO $$
BEGIN
  EXECUTE format(
    'REVOKE ALL ON DATABASE %I FROM ductus_legal_app',
    current_database()
  );
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END
$$;
