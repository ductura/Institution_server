-- migrate:up
-- SRV-1814: extend the existing report store and keep its shared hourly quota.
SET LOCAL ROLE ductus_migrator;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ductus_problem_report_reader') THEN
    CREATE ROLE ductus_problem_report_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ductus_problem_report_reader'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role ductus_problem_report_reader already exists with LOGIN or an elevated attribute';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ductus_problem_report_reader', current_database());
END
$$;

GRANT USAGE ON SCHEMA identity TO ductus_problem_report_reader;
SET LOCAL ROLE ductus_identity;

ALTER TABLE identity.problem_report DROP CONSTRAINT problem_report_description_check;
ALTER TABLE identity.problem_report ADD CONSTRAINT problem_report_description_check CHECK (
  char_length(description) BETWEEN 1 AND 2000
  AND description !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]'
  AND description ~ '[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]'
);

CREATE POLICY problem_report_own_read ON identity.problem_report FOR SELECT TO ductus_app
  USING ((user_id, institution_id) = (SELECT a.user_id, a.institution_id FROM app.current_actor() a));
CREATE POLICY problem_report_operator_read ON identity.problem_report FOR SELECT
  TO ductus_problem_report_reader USING (true);
GRANT SELECT ON identity.problem_report TO ductus_app, ductus_problem_report_reader;

SET LOCAL ROLE ductus_migrator;

-- migrate:down
-- Local only. If longer reports exist, validation refuses the rollback without changing them.
SET LOCAL ROLE ductus_identity;

ALTER TABLE identity.problem_report DROP CONSTRAINT problem_report_description_check;
ALTER TABLE identity.problem_report ADD CONSTRAINT problem_report_description_check CHECK (
  char_length(description) BETWEEN 1 AND 1000
  AND description !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]'
  AND description ~ '[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]'
);

REVOKE SELECT ON identity.problem_report FROM ductus_app, ductus_problem_report_reader;
DROP POLICY problem_report_operator_read ON identity.problem_report;
DROP POLICY problem_report_own_read ON identity.problem_report;

SET LOCAL ROLE ductus_migrator;
REVOKE USAGE ON SCHEMA identity FROM ductus_problem_report_reader;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM ductus_problem_report_reader', current_database());
END
$$;
DROP ROLE ductus_problem_report_reader;
