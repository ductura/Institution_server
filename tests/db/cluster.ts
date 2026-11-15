// S-1F-c (DAN-779): helpers the database tests share for the logs and the
// legal database: the migration's up section run in a transaction that is
// always rolled back, a connection attempt as a throwaway login, and the
// whole catalogue that tests/db/database-access.ts checks.
import { readFileSync } from "node:fs";

import pg from "pg";

import type { GrantRow, RoleRow } from "./database-access.ts";

/** The up section of a dbmate migration file. */
export function upSection(file: string): string {
  const sql = readFileSync(file, "utf8");
  const up = sql.indexOf("-- migrate:up");
  const down = sql.indexOf("-- migrate:down");
  if (up < 0 || down <= up) throw new Error(`${file} has no up and down section`);
  return sql.slice(up, down);
}

/** Runs `steps`, then the up section of `file` as `migrator` (or as is), always rolled back. */
export async function migrateInRollback(
  pool: pg.Pool,
  file: string,
  migrator: string | null,
  steps: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const step of steps) await client.query(step);
    if (migrator) await client.query(`SET LOCAL ROLE ${migrator}`);
    await client.query(upSection(file));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Connects as `role` to `database` of the cluster behind `adminUrl`; the error message or null. */
export async function connectAs(
  adminUrl: string,
  role: string,
  password: string,
  database: string,
): Promise<string | null> {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await client.end().catch(() => {});
  }
}

export type Queryable = Pick<pg.Pool, "query">;

/**
 * Every role (the built-in pg_* ones included), and PUBLIC as a role of its
 * own, × every database of `databases` and, with `withSchemas`, every schema
 * of the connected database but the system ones. A role reaches what it
 * inherits or may SET ROLE to. PUBLIC's rows come from the ACL itself, so a
 * grant to PUBLIC fails even where no other role would show it.
 */
export async function catalogue(
  pool: Queryable,
  databases: string[],
  withSchemas: boolean,
): Promise<{ roles: RoleRow[]; grants: GrantRow[] }> {
  const roles = await pool.query<RoleRow>(`
    SELECT r.rolname AS role, r.rolsuper AS superuser,
           ARRAY(SELECT g.rolname::text FROM pg_catalog.pg_roles g
                 WHERE pg_catalog.pg_has_role(r.oid, g.oid, 'USAGE')
                    OR pg_catalog.pg_has_role(r.oid, g.oid, 'SET')) AS inherits
    FROM pg_catalog.pg_roles r
    UNION ALL SELECT 'PUBLIC', false, ARRAY['PUBLIC']`);
  const grants = await pool.query<GrantRow>(
    `SELECT r.rolname AS role, 'database:' || d.datname AS object, p.privilege,
            pg_catalog.has_database_privilege(r.oid, d.oid, p.privilege) AS granted
     FROM pg_catalog.pg_roles r
     CROSS JOIN pg_catalog.pg_database d
     CROSS JOIN unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p(privilege)
     WHERE d.datname = ANY ($1)
     UNION ALL
     SELECT 'PUBLIC', 'database:' || d.datname, p.privilege,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                    WHERE a.grantee = 0 AND a.privilege_type = p.privilege)
     FROM pg_catalog.pg_database d
     CROSS JOIN unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p(privilege)
     WHERE d.datname = ANY ($1)`,
    [databases],
  );
  const rows = [...grants.rows];
  if (withSchemas) {
    const schemas = `FROM pg_catalog.pg_namespace n
       CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS p(privilege)
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname !~ '^pg_(toast_)?temp_'`;
    const schema = await pool.query<GrantRow>(
      `SELECT r.rolname AS role, 'schema:' || current_database() || '.' || n.nspname AS object,
              p.privilege, pg_catalog.has_schema_privilege(r.oid, n.oid, p.privilege) AS granted
       FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_namespace n
       CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS p(privilege)
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname !~ '^pg_(toast_)?temp_'
       UNION ALL
       SELECT 'PUBLIC', 'schema:' || current_database() || '.' || n.nspname, p.privilege,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = p.privilege)
       ${schemas}`,
    );
    rows.push(...schema.rows);
  }
  return { roles: roles.rows, grants: rows };
}
