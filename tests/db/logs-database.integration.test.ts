// S-1F-c (DAN-779) acceptance against real PostgreSQL clusters: the logs
// database in a cluster of its own (CI: 127.0.0.1:54330, as compose
// postgres-logs), provisioned by db/logs/local/migrator.sql and migrated by
// scripts/db/migrate-locked.ts --database logs, next to the migrated main
// database (127.0.0.1:54329). Every case that changes a role runs in a
// transaction that is rolled back; the logins the connection cases need have
// random synthetic names and are dropped at the end. With no database it
// fails, it never skips.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkDatabaseAccess,
  databasePolicy,
  type AccessPolicy,
  type GrantRow,
  type RoleRow,
} from "./database-access.ts";
import { isLoopbackDatabaseUrl, requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const MAIN_URL = requireLoopbackDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
  "The logs database test runs only against a loopback main database (DATABASE_URL).",
);
const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The logs database test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATION = `${ROOT}db/logs/migrations/20261115120000_roles.sql`;
const BOOTSTRAP = `${ROOT}db/logs/local/migrator.sql`;
const LOGS_ROLES = [
  "ductus_logs_migrator",
  "ductus_logs_writer",
  "ductus_logs_reader",
  "ductus_logs_retention",
] as const;
const GROUPS = LOGS_ROLES.slice(1);
const ATTRIBUTES = [
  "LOGIN",
  "SUPERUSER",
  "CREATEDB",
  "CREATEROLE",
  "REPLICATION",
  "BYPASSRLS",
] as const;
const MAIN_POLICY: AccessPolicy = {
  "database:ductus": {
    connect: ["ductus_migrator", "ductus_app", "ductus_worker", "ductus_retention", "ductus_auth"],
    create: ["ductus_migrator"],
    temporary: ["ductus_migrator"],
  },
};
const LOGS_POLICY = databasePolicy("ductus_logs", "ductus_logs_migrator", GROUPS);

const suffix = randomBytes(4).toString("hex");
const password = randomBytes(18).toString("base64url");
const main = new pg.Pool({ connectionString: MAIN_URL, max: 1 });
const logs = new pg.Pool({ connectionString: LOGS_URL, max: 1 });
const made: { pool: pg.Pool; role: string }[] = [];

afterAll(async () => {
  for (const { pool, role } of made) await pool.query(`DROP ROLE IF EXISTS ${role}`);
  await Promise.all([main.end(), logs.end()]);
});

function upSection(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const up = sql.indexOf("-- migrate:up");
  const down = sql.indexOf("-- migrate:down");
  if (up < 0 || down <= up) throw new Error("the logs roles migration has no up and down section");
  return sql.slice(up, down);
}

/** Runs `steps` then the up section in one transaction that is always rolled back. */
async function migrateInRollback(steps: string[], asMigrator = true): Promise<void> {
  const client = await logs.connect();
  try {
    await client.query("BEGIN");
    for (const step of steps) await client.query(step);
    if (asMigrator) await client.query("SET LOCAL ROLE ductus_logs_migrator");
    await client.query(upSection());
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** A login that inherits exactly `group` (or nothing), with a random name. */
async function login(pool: pg.Pool, label: string, group?: string): Promise<string> {
  const role = `w779_${label}_${suffix}`;
  await pool.query(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}'`);
  made.push({ pool, role });
  if (group) await pool.query(`GRANT ${group} TO ${role}`);
  return role;
}

/** Connects as `role` to `database` of the cluster behind `adminUrl`; the error message or null. */
async function connectAs(adminUrl: string, role: string, database: string): Promise<string | null> {
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

type Queryable = Pick<pg.Pool, "query">;

/**
 * Every role (the built-in pg_* ones included), and PUBLIC as a role of its
 * own, × every database of `databases` and, with `withSchemas`, every schema
 * of the connected database but the system ones. A role reaches what it
 * inherits or may SET ROLE to. PUBLIC's rows come from the ACL itself, so a
 * grant to PUBLIC fails even where no other role would show it.
 */
async function catalogue(
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

/** The logs catalogue checked inside a transaction after `steps`, always rolled back. */
async function logsErrorsAfter(steps: string[]): Promise<string[]> {
  const client = await logs.connect();
  try {
    await client.query("BEGIN");
    for (const step of steps) await client.query(step);
    const { roles, grants } = await catalogue(client, ["ductus_logs"], true);
    return checkDatabaseAccess(roles, grants, LOGS_POLICY).errors;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("who reaches which database (whole catalogue)", () => {
  it("the logs cluster: only the four logs roles reach ductus_logs, and every database is in the policy", async () => {
    // Every database but the maintenance ones (postgres, templates; B0.1, known limit).
    const { rows } = await logs.query<{ datname: string }>(
      "SELECT datname FROM pg_catalog.pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1')",
    );
    const { roles, grants } = await catalogue(
      logs,
      rows.map((row) => row.datname),
      true,
    );
    const result = checkDatabaseAccess(roles, grants, LOGS_POLICY);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(roles.length * 5);
  });

  // Attack run, finding 3: what the catalogue alone would not show.
  it("the logs cluster has one superuser, no other role with an elevated attribute or login, and no member of a built-in role", async () => {
    const { rows } = await logs.query<{ rolname: string; rolsuper: boolean }>(
      `SELECT rolname, rolsuper FROM pg_catalog.pg_roles
       WHERE rolname !~ '^pg_'
         AND (rolsuper OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)`,
    );
    expect(rows).toEqual([{ rolname: "ductus", rolsuper: true }]);
    const { rows: builtin } = await logs.query(
      `SELECT m.member::regrole::text AS member, m.roleid::regrole::text AS builtin
       FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
       WHERE r.rolname ~ '^pg_' AND m.member::regrole::text !~ '^pg_'`,
    );
    expect(builtin).toEqual([]);
  });

  it.each([
    [
      "a grant to a built-in role",
      "GRANT CONNECT, TEMPORARY ON DATABASE ductus_logs TO pg_signal_backend",
      /pg_signal_backend has CONNECT/,
    ],
    [
      "CREATE in public for a built-in role",
      "GRANT CREATE ON SCHEMA public TO pg_write_all_data",
      /pg_write_all_data has CREATE on schema:ductus_logs\.public/,
    ],
    [
      "a schema besides public",
      "CREATE SCHEMA w779_extra",
      /on schema:ductus_logs\.w779_extra is not in the policy/,
    ],
    [
      "a schema open to PUBLIC",
      "CREATE SCHEMA w779_open; GRANT USAGE ON SCHEMA w779_open TO PUBLIC",
      /USAGE on schema:ductus_logs\.w779_open is not in the policy/,
    ],
  ])("the catalogue check fails on %s", async (_label, step, error) => {
    expect((await logsErrorsAfter([step])).join("\n")).toMatch(error);
  });

  it("the catalogue check fails on a login that may SET ROLE to the migrator without inheriting it", async () => {
    const role = `w779_setonly_${suffix}`;
    const errors = await logsErrorsAfter([
      `CREATE ROLE ${role} LOGIN`,
      `GRANT ductus_logs_migrator TO ${role} WITH INHERIT FALSE, SET TRUE`,
    ]);
    expect(errors.join("\n")).toMatch(new RegExp(`${role} lacks CREATE on database:ductus_logs`));
  });

  it("the main cluster: the main database stays closed to everyone but its roles", async () => {
    const { roles, grants } = await catalogue(main, ["ductus"], false);
    const result = checkDatabaseAccess(roles, grants, MAIN_POLICY);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(roles.length * 3);
  });

  it("the logs cluster holds exactly the logs roles of ductus_*, none of the main database", async () => {
    const { rows } = await logs.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ductus\\_%' ORDER BY rolname",
    );
    expect(rows.map((row) => row.rolname)).toEqual([...LOGS_ROLES].sort());
    const { rows: leak } = await main.query(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ductus\\_logs\\_%'",
    );
    expect(leak).toEqual([]);
  });

  it("no logs role logs in, has an elevated attribute or is a member of any role", async () => {
    const { rows } = await logs.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
              (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships
       FROM pg_catalog.pg_roles r WHERE rolname = ANY ($1) ORDER BY rolname`,
      [[...LOGS_ROLES]],
    );
    expect(rows).toHaveLength(LOGS_ROLES.length);
    for (const row of rows) {
      expect(row).toEqual({
        rolname: row.rolname,
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        memberships: 0,
      });
    }
  });
});

describe("real connections", () => {
  it("a member of each logs group role connects to ductus_logs but cannot create there", async () => {
    for (const group of GROUPS) {
      const role = await login(logs, group.replace("ductus_logs_", "l"), group);
      expect(await connectAs(LOGS_URL, role, "ductus_logs")).toBeNull();
      const url = new URL(LOGS_URL);
      url.username = role;
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await expect(client.query("CREATE TABLE public.w779_probe (x int)")).rejects.toThrow(
          /permission denied for schema public/,
        );
        await expect(client.query("CREATE TEMP TABLE w779_probe (x int)")).rejects.toThrow(
          /permission denied to create temporary tables/,
        );
        await expect(client.query("CREATE SCHEMA w779_probe")).rejects.toThrow(
          /permission denied for database/,
        );
      } finally {
        await client.end();
      }
    }
  });

  it("a login without a logs role is refused by ductus_logs", async () => {
    const role = await login(logs, "none");
    expect(await connectAs(LOGS_URL, role, "ductus_logs")).toMatch(
      /permission denied for database "ductus_logs"/,
    );
  });

  it("a member of ductus_app reaches the main database and nothing of the logs database", async () => {
    const role = await login(main, "app", "ductus_app");
    expect(await connectAs(MAIN_URL, role, "ductus")).toBeNull();
    // The logs cluster does not know the role at all.
    expect(await connectAs(LOGS_URL, role, "ductus_logs")).toMatch(
      /password authentication failed|does not exist/,
    );
  });
});

describe("the logs roles migration refuses a wrong cluster", () => {
  it("passes as ductus_logs_migrator on the provisioned database (and changes nothing)", async () => {
    await expect(migrateInRollback([])).resolves.toBeUndefined();
  });

  it.each(ATTRIBUTES.flatMap((attribute) => LOGS_ROLES.map((role) => [role, attribute])))(
    "stops when %s has %s",
    async (role, attribute) => {
      await expect(migrateInRollback([`ALTER ROLE ${role} ${attribute}`])).rejects.toThrow(
        /has LOGIN or an elevated attribute/,
      );
    },
  );

  it("stops when a logs role is a member of another role (a superuser included)", async () => {
    for (const role of LOGS_ROLES) {
      await expect(migrateInRollback([`GRANT ductus TO ${role}`])).rejects.toThrow(
        /is a member of another role/,
      );
    }
  });

  it("stops when a logs role is missing", async () => {
    await expect(
      migrateInRollback([`ALTER ROLE ductus_logs_reader RENAME TO w779_gone_${suffix}`]),
    ).rejects.toThrow(/role ductus_logs_reader is missing/);
  });

  it("stops when it runs as anyone but ductus_logs_migrator, or the migrator does not own the database", async () => {
    await expect(migrateInRollback([], false)).rejects.toThrow(/run only as ductus_logs_migrator/);
    await expect(migrateInRollback(["SET LOCAL ROLE ductus_logs_writer"], false)).rejects.toThrow(
      /run only as ductus_logs_migrator/,
    );
    await expect(migrateInRollback(["ALTER DATABASE ductus_logs OWNER TO ductus"])).rejects.toThrow(
      /not owned by ductus_logs_migrator/,
    );
  });
});

describe("no escalation from the logs roles", () => {
  it("ductus_logs_migrator cannot make roles or databases, change a role or join a superuser", async () => {
    const client = await logs.connect();
    try {
      await client.query("SET ROLE ductus_logs_migrator");
      for (const [sql, error] of [
        [`CREATE ROLE w779_new_${suffix}`, /permission denied to create role/],
        [`CREATE DATABASE w779_new_${suffix}`, /permission denied to create database/],
        ["ALTER ROLE ductus_logs_writer BYPASSRLS", /permission denied|must be superuser/],
        ["ALTER ROLE ductus_logs_migrator CREATEDB", /permission denied|must be superuser/],
        ["GRANT ductus TO ductus_logs_migrator", /permission denied|must have admin option/],
        [
          "GRANT ductus_logs_writer TO ductus_logs_reader",
          /permission denied|must have admin option/,
        ],
      ] as const) {
        await expect(client.query(sql), sql).rejects.toThrow(error);
      }
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });
});

describe("migrating twice and the provisioning file", () => {
  it("a second provisioning and a second locked run change nothing; a wrong URL is refused", async () => {
    const before = await logs.query(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    expect(before.rows.length).toBeGreaterThan(0);
    await logs.query(readFileSync(BOOTSTRAP, "utf8"));
    expect((await logs.query("SHOW search_path")).rows[0]).not.toEqual({
      search_path: "pg_catalog",
    });
    const runner = (args: string[]): number | null =>
      spawnSync(process.execPath, [`${ROOT}scripts/db/migrate-locked.ts`, ...args], {
        cwd: ROOT,
        stdio: "ignore",
        timeout: 60_000,
      }).status;
    const url = `${LOGS_URL}?sslmode=disable&role=ductus_logs_migrator`;
    expect(runner(["--database", "logs", "--url", url])).toBe(0);
    expect(
      runner([
        "--database",
        "logs",
        "--url",
        `${MAIN_URL}?sslmode=disable&role=ductus_logs_migrator`,
      ]),
    ).toBe(1);
    expect(runner(["--url", url])).toBe(1);
    const after = await logs.query("SELECT version FROM public.schema_migrations ORDER BY version");
    expect(after.rows).toEqual(before.rows);
    const { roles, grants } = await catalogue(logs, ["ductus_logs"], true);
    expect(checkDatabaseAccess(roles, grants, LOGS_POLICY).errors).toEqual([]);
  });

  it("the provisioning file refuses any database but ductus_logs", async () => {
    await expect(main.query(readFileSync(BOOTSTRAP, "utf8"))).rejects.toThrow(
      /runs only in ductus_logs/,
    );
  });

  // Attack run, finding 2: a database owner could shadow current_database()
  // in public and point search_path at it; the file resolves nothing there.
  it("the provisioning file cannot be fooled by a function in public on the search path", async () => {
    const client = await main.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = public, pg_catalog");
      await client.query(
        "CREATE FUNCTION public.current_database() RETURNS name LANGUAGE sql AS $f$ SELECT 'ductus_logs'::name $f$",
      );
      await expect(client.query(readFileSync(BOOTSTRAP, "utf8"))).rejects.toThrow(
        /runs only in ductus_logs \(current: ductus\)/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the loopback rule takes the logs port and refuses a query or another host", () => {
    expect(isLoopbackDatabaseUrl(LOGS_URL)).toBe(true);
    expect(isLoopbackDatabaseUrl(`${LOGS_URL}?sslmode=disable`)).toBe(false);
    expect(isLoopbackDatabaseUrl(LOGS_URL.replace("127.0.0.1", "10.0.0.1"))).toBe(false);
    expect(isLoopbackDatabaseUrl(LOGS_URL.replace("54330", "54331"))).toBe(false);
  });
});
