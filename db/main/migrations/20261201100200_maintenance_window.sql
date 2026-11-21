-- migrate:up
-- P-D5: the operator records planned work and confirmed outages outside the application.
GRANT CREATE ON SCHEMA identity TO ductus_identity;
SET LOCAL ROLE ductus_identity;

CREATE TABLE identity.maintenance_window (
  kind text NOT NULL CHECK (kind IN ('planned', 'outage')),
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (kind, starts_at, ends_at),
  CHECK (starts_at >= TIMESTAMPTZ '2000-01-01 00:00:00+00'
    AND ends_at < TIMESTAMPTZ '10000-01-01 00:00:00+00' AND starts_at < ends_at),
  CHECK (kind <> 'outage' OR ends_at <= recorded_at)
);
ALTER TABLE identity.maintenance_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.maintenance_window FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_read ON identity.maintenance_window FOR SELECT TO ductus_identity USING (true);
CREATE POLICY maintenance_record ON identity.maintenance_window FOR INSERT TO ductus_identity WITH CHECK (true);

CREATE FUNCTION identity.public_maintenance_windows()
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT w.starts_at, w.ends_at FROM identity.maintenance_window w
  WHERE w.kind = 'planned' AND w.ends_at > statement_timestamp()
  ORDER BY w.starts_at, w.ends_at
  LIMIT 50
$$;
REVOKE ALL ON FUNCTION identity.public_maintenance_windows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.public_maintenance_windows() TO ductus_app;

SET LOCAL ROLE ductus_migrator;
REVOKE CREATE ON SCHEMA identity FROM ductus_identity;

-- migrate:down
SET LOCAL ROLE ductus_identity;
DROP FUNCTION identity.public_maintenance_windows();
DROP TABLE identity.maintenance_window;
SET LOCAL ROLE ductus_migrator;
