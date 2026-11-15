// S-1F-c a2 (DAN-779) acceptance against a real PostgreSQL: the legal texts
// database ductus_legal next to the main database in one cluster (CI:
// 127.0.0.1:54329), made by db/legal/local/create-database.sql, provisioned by
// db/legal/local/migrator.sql and migrated by scripts/db/migrate-locked.ts
// --database legal. The main roles are cluster-wide, so they exist here and
// only the database's grants keep them out. Every case that changes a role
// runs in a transaction that is rolled back; the logins of the connection
// cases have random synthetic names and are dropped at the end.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { catalogue, connectAs, migrateInRollback, upSection } from "./cluster.ts";
import { checkDatabaseAccess, databasePolicy, type AccessPolicy } from "./database-access.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const MAIN_URL = requireLoopbackDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
  "The legal database test runs only against a loopback main database (DATABASE_URL).",
);
const LEGAL_URL = (() => {
  const url = new URL(MAIN_URL);
  url.pathname = "/ductus_legal";
  return requireLoopbackDatabaseUrl(url.toString(), "The legal database is in the main cluster.");
})();
const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The legal database test reads the logs cluster only on loopback (LOGS_DATABASE_URL).",
);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATION = `${ROOT}db/legal/migrations/20261115130000_roles.sql`;
const BOOTSTRAP = `${ROOT}db/legal/local/migrator.sql`;
const CREATE = `${ROOT}db/legal/local/create-database.sql`;
const LEGAL_ROLES = ["ductus_legal_migrator", "ductus_legal_app"] as const;
const MAIN_GROUPS = [
  "ductus_app",
  "ductus_worker",
  "ductus_retention",
  "ductus_evidence",
  "ductus_identity",
  "ductus_auth",
  "ductus_queue",
  "ductus_migrator",
] as const;
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
const LEGAL_POLICY = databasePolicy("ductus_legal", "ductus_legal_migrator", ["ductus_legal_app"]);

const suffix = randomBytes(4).toString("hex");
const password = randomBytes(18).toString("base64url");
const main = new pg.Pool({ connectionString: MAIN_URL, max: 1 });
const legal = new pg.Pool({ connectionString: LEGAL_URL, max: 1 });
const made: string[] = [];

afterAll(async () => {
  for (const role of made) await main.query(`DROP ROLE IF EXISTS ${role}`);
  await Promise.all([main.end(), legal.end()]);
});

const migrate = (steps: string[], migrator: string | null = "ductus_legal_migrator") =>
  migrateInRollback(legal, MIGRATION, migrator, steps);

/** A login of the main cluster that inherits exactly `group` (or nothing). */
async function login(label: string, group?: string): Promise<string> {
  const role = `w779_${label}_${suffix}`;
  await main.query(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}'`);
  made.push(role);
  if (group) await main.query(`GRANT ${group} TO ${role}`);
  return role;
}

/** The legal catalogue checked inside a transaction after `steps`, always rolled back. */
async function legalErrorsAfter(steps: string[]): Promise<string[]> {
  const client = await legal.connect();
  try {
    await client.query("BEGIN");
    for (const step of steps) await client.query(step);
    const { roles, grants } = await catalogue(client, ["ductus_legal"], true);
    return checkDatabaseAccess(roles, grants, LEGAL_POLICY).errors;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("who reaches which database of the main cluster (whole catalogue)", () => {
  it("only the legal roles reach ductus_legal, and every schema of it is in the policy", async () => {
    const { roles, grants } = await catalogue(legal, ["ductus_legal"], true);
    const result = checkDatabaseAccess(roles, grants, LEGAL_POLICY);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBeGreaterThanOrEqual(roles.length * 5);
  });

  it("the main database stays closed to the legal roles", async () => {
    const { roles, grants } = await catalogue(main, ["ductus"], false);
    const result = checkDatabaseAccess(roles, grants, MAIN_POLICY);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(roles.length * 3);
  });

  // Attack run on a2, finding 4: inheriting a main role would be "allowed" by
  // MAIN_POLICY, so the legal roles are asked directly.
  it("no legal role can connect to ductus, directly or through a membership", async () => {
    const { rows } = await main.query(
      `SELECT r.rolname, pg_catalog.has_database_privilege(r.oid, 'ductus', 'CONNECT') AS connect
       FROM pg_catalog.pg_roles r WHERE r.rolname = ANY ($1) ORDER BY r.rolname`,
      [[...LEGAL_ROLES]],
    );
    expect(rows).toEqual([...LEGAL_ROLES].sort().map((rolname) => ({ rolname, connect: false })));
  });

  // Attack run on a2, findings 1 and 2: what the privilege catalogue cannot show.
  it("nobody administers a legal role or is a member of the migrator, and no role of the cluster is a member of a built-in role", async () => {
    const { rows: grants } = await main.query(
      `SELECT m.roleid::regrole::text AS role, m.member::regrole::text AS member, m.admin_option
       FROM pg_catalog.pg_auth_members m WHERE m.roleid::regrole::text = ANY ($1)`,
      [[...LEGAL_ROLES]],
    );
    expect(
      grants.filter((row) => row.admin_option || row.role === "ductus_legal_migrator"),
    ).toEqual([]);
    const { rows: builtin } = await main.query(
      `SELECT m.member::regrole::text AS member, m.roleid::regrole::text AS builtin
       FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
       WHERE r.rolname ~ '^pg_' AND m.member::regrole::text !~ '^pg_'`,
    );
    expect(builtin).toEqual([]);
  });

  it.each([
    [
      "CONNECT for a main role",
      "GRANT CONNECT ON DATABASE ductus_legal TO ductus_app",
      /ductus_app has CONNECT on database:ductus_legal/,
    ],
    [
      "CONNECT for PUBLIC",
      "GRANT CONNECT ON DATABASE ductus_legal TO PUBLIC",
      /PUBLIC has CONNECT on database:ductus_legal/,
    ],
    [
      "USAGE of public for a main role",
      "GRANT USAGE ON SCHEMA public TO ductus_worker",
      /ductus_worker has USAGE on schema:ductus_legal\.public/,
    ],
    [
      "CREATE in public for the app",
      "GRANT CREATE ON SCHEMA public TO ductus_legal_app",
      /ductus_legal_app has CREATE on schema:ductus_legal\.public/,
    ],
    [
      "a schema besides public",
      "CREATE SCHEMA w779_extra",
      /schema:ductus_legal\.w779_extra is not in the policy/,
    ],
  ])("the catalogue check fails on %s", async (_label, step, error) => {
    expect((await legalErrorsAfter([step])).join("\n")).toMatch(error);
  });

  it("the legal roles exist only in the main cluster, with no attribute and no membership", async () => {
    const { rows } = await main.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
              (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships
       FROM pg_catalog.pg_roles r WHERE rolname LIKE 'ductus\\_legal\\_%' ORDER BY rolname`,
    );
    expect(rows.map((row) => row.rolname)).toEqual([...LEGAL_ROLES].sort());
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
    const logs = new pg.Client({ connectionString: LOGS_URL });
    await logs.connect();
    try {
      const { rows: leak } = await logs.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ductus\\_legal\\_%'",
      );
      expect(leak).toEqual([]);
    } finally {
      await logs.end();
    }
  });
});

describe("real connections in the shared cluster", () => {
  it("a member of ductus_legal_app reaches ductus_legal but not ductus, and cannot create", async () => {
    const role = await login("legal_app", "ductus_legal_app");
    expect(await connectAs(MAIN_URL, role, password, "ductus_legal")).toBeNull();
    expect(await connectAs(MAIN_URL, role, password, "ductus")).toMatch(
      /permission denied for database "ductus"/,
    );
    const url = new URL(LEGAL_URL);
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
      await expect(client.query("SET ROLE ductus_legal_migrator")).rejects.toThrow(
        /permission denied to set role/,
      );
    } finally {
      await client.end();
    }
  });

  it.each(MAIN_GROUPS.map((group) => [group]))(
    "a member of %s is refused by ductus_legal",
    async (group) => {
      const role = await login(group.replace("ductus_", "m"), group);
      expect(await connectAs(MAIN_URL, role, password, "ductus_legal")).toMatch(
        /permission denied for database "ductus_legal"/,
      );
    },
  );

  it("a login without a role is refused by ductus_legal", async () => {
    const role = await login("none");
    expect(await connectAs(MAIN_URL, role, password, "ductus_legal")).toMatch(
      /permission denied for database "ductus_legal"/,
    );
  });
});

describe("the legal roles migration refuses a wrong cluster", () => {
  it("passes as ductus_legal_migrator on the provisioned database (and changes nothing)", async () => {
    await expect(migrate([])).resolves.toBeUndefined();
  });

  it.each(ATTRIBUTES.flatMap((attribute) => LEGAL_ROLES.map((role) => [role, attribute])))(
    "stops when %s has %s",
    async (role, attribute) => {
      await expect(migrate([`ALTER ROLE ${role} ${attribute}`])).rejects.toThrow(
        /has LOGIN or an elevated attribute/,
      );
    },
  );

  it.each([
    ["ductus_legal_app", "ductus"],
    ["ductus_legal_app", "ductus_app"],
    ["ductus_legal_migrator", "ductus_migrator"],
  ])("stops when %s is a member of %s", async (role, other) => {
    await expect(migrate([`GRANT ${other} TO ${role}`])).rejects.toThrow(
      /is a member of another role/,
    );
  });

  // Attack run on a2, finding 1: ductus_migrator (CREATEROLE) holds ADMIN
  // on a role it made, or is handed it.
  it.each([
    [
      "ADMIN on the app",
      "GRANT ductus_legal_app TO ductus_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ductus",
    ],
    [
      "ADMIN on the migrator",
      "GRANT ductus_legal_migrator TO ductus_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ductus",
    ],
    ["a member of the migrator", "GRANT ductus_legal_migrator TO ductus_app"],
    ["a group role in the app", "GRANT ductus_legal_app TO ductus_worker"],
  ])("stops on %s", async (_label, step) => {
    await expect(migrate([step])).rejects.toThrow(/is not allowed: no ADMIN/);
  });

  it("stops when ductus_migrator made the legal roles itself", async () => {
    await expect(
      migrate([
        `ALTER ROLE ductus_legal_app RENAME TO w779_old_app_${suffix}`,
        `ALTER ROLE ductus_legal_migrator RENAME TO w779_old_migrator_${suffix}`,
        "SET LOCAL ROLE ductus_migrator",
        "CREATE ROLE ductus_legal_migrator NOLOGIN",
        "CREATE ROLE ductus_legal_app NOLOGIN",
        "RESET ROLE",
        "ALTER DATABASE ductus_legal OWNER TO ductus_legal_migrator",
      ]),
    ).rejects.toThrow(/is not allowed: no ADMIN/);
  });

  // Finding 4: the main migrator may put a legal role into a main group.
  it("stops when ductus_migrator made a legal role a member of a main role", async () => {
    await expect(
      migrate([
        "SET LOCAL ROLE ductus_migrator",
        "GRANT ductus_app TO ductus_legal_app",
        "RESET ROLE",
      ]),
    ).rejects.toThrow(/is a member of another role/);
  });

  // Finding 5: a grant made before the migration does not survive it.
  it("takes back every grant on the database and on public that is not the app's", async () => {
    const client = await legal.connect();
    try {
      await client.query("BEGIN");
      await client.query("GRANT CONNECT, TEMPORARY ON DATABASE ductus_legal TO ductus_app");
      await client.query("GRANT CREATE, USAGE ON SCHEMA public TO ductus_worker");
      // Codex on #57: a role whose name needs quoting is revoked too.
      await client.query(`CREATE ROLE "W779 Legal ${suffix}" NOLOGIN`);
      await client.query(`GRANT CONNECT ON DATABASE ductus_legal TO "W779 Legal ${suffix}"`);
      await client.query(`GRANT USAGE ON SCHEMA public TO "W779 Legal ${suffix}"`);
      await client.query("SET LOCAL ROLE ductus_legal_migrator");
      await client.query(upSection(MIGRATION));
      await client.query("RESET ROLE");
      const { roles, grants } = await catalogue(client, ["ductus_legal"], true);
      expect(checkDatabaseAccess(roles, grants, LEGAL_POLICY).errors).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("stops when a legal role is missing", async () => {
    await expect(
      migrate([`ALTER ROLE ductus_legal_app RENAME TO w779_gone_${suffix}`]),
    ).rejects.toThrow(/role ductus_legal_app is missing/);
  });

  it("stops as the superuser, as ductus_migrator, as the app, and when another role owns the database", async () => {
    await expect(migrate([], null)).rejects.toThrow(/run only as ductus_legal_migrator/);
    await expect(migrate([], "ductus_migrator")).rejects.toThrow(
      /run only as ductus_legal_migrator/,
    );
    await expect(migrate([], "ductus_legal_app")).rejects.toThrow(
      /run only as ductus_legal_migrator/,
    );
    await expect(migrate(["ALTER DATABASE ductus_legal OWNER TO ductus_migrator"])).rejects.toThrow(
      /not owned by ductus_legal_migrator/,
    );
  });

  it("stops in the main database", async () => {
    await expect(migrateInRollback(main, MIGRATION, null, [])).rejects.toThrow(
      /run only as ductus_legal_migrator in ductus_legal/,
    );
  });
});

describe("no escalation between the main and the legal roles", () => {
  it("ductus_migrator (CREATEROLE) cannot take, change or drop a legal role", async () => {
    const client = await main.connect();
    try {
      await client.query("SET ROLE ductus_migrator");
      for (const [sql, error] of [
        ["GRANT ductus_legal_app TO ductus_migrator", /permission denied to grant role/],
        ["GRANT ductus_legal_migrator TO ductus_app", /permission denied to grant role/],
        ["ALTER ROLE ductus_legal_app CREATEDB", /permission denied to alter role/],
        ["ALTER ROLE ductus_legal_migrator LOGIN", /permission denied to alter role/],
        ["DROP ROLE ductus_legal_app", /permission denied to drop role/],
        ["GRANT CONNECT ON DATABASE ductus_legal TO ductus_app", /permission denied for database/],
      ] as const) {
        await expect(client.query(sql), sql).rejects.toThrow(error);
      }
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });

  it("ductus_legal_migrator cannot make roles or databases, change a role or join a main role", async () => {
    const client = await legal.connect();
    try {
      await client.query("SET ROLE ductus_legal_migrator");
      for (const [sql, error] of [
        [`CREATE ROLE w779_new_${suffix}`, /permission denied to create role/],
        [`CREATE DATABASE w779_new_${suffix}`, /permission denied to create database/],
        ["ALTER ROLE ductus_legal_app BYPASSRLS", /permission denied/],
        ["GRANT ductus_app TO ductus_legal_migrator", /permission denied/],
        ["GRANT ductus TO ductus_legal_migrator", /permission denied/],
      ] as const) {
        await expect(client.query(sql), sql).rejects.toThrow(error);
      }
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });
});

describe("migrating twice and the provisioning files", () => {
  it("a second creation, provisioning and locked run change nothing; a wrong URL is refused", async () => {
    const before = await legal.query(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    expect(before.rows.length).toBeGreaterThan(0);
    await legal.query(readFileSync(BOOTSTRAP, "utf8"));
    const runner = (args: string[]): number | null =>
      spawnSync(process.execPath, [`${ROOT}scripts/db/migrate-locked.ts`, ...args], {
        cwd: ROOT,
        stdio: "ignore",
        timeout: 60_000,
      }).status;
    const url = `${LEGAL_URL}?sslmode=disable&role=ductus_legal_migrator`;
    expect(runner(["--database", "legal", "--url", url])).toBe(0);
    expect(
      runner([
        "--database",
        "legal",
        "--url",
        `${MAIN_URL}?sslmode=disable&role=ductus_legal_migrator`,
      ]),
    ).toBe(1);
    expect(runner(["--url", url])).toBe(1);
    const after = await legal.query(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    expect(after.rows).toEqual(before.rows);
    const { roles, grants } = await catalogue(legal, ["ductus_legal"], true);
    expect(checkDatabaseAccess(roles, grants, LEGAL_POLICY).errors).toEqual([]);
  });

  it("create-database.sql creates the database only where it is missing, and runs twice", async () => {
    const sql = readFileSync(CREATE, "utf8");
    expect(sql.trimEnd().endsWith("\\gexec")).toBe(true);
    // What psql's \gexec runs: each row of the query as a statement.
    const query = sql.replace(/\\gexec\s*$/, "");
    for (let run = 0; run < 2; run += 1) {
      const { rows } = await main.query<Record<string, string>>(query);
      expect(rows).toEqual([]);
    }
    // Where the database is missing, the query yields the one statement.
    const missing = `w779_missing_${suffix}`;
    const { rows } = await main.query<Record<string, string>>(
      query.replaceAll("ductus_legal", missing),
    );
    expect(rows.map((row) => Object.values(row)[0])).toEqual([`CREATE DATABASE ${missing}`]);
  });

  it("the provisioning file refuses any database but ductus_legal, also behind a shadowing function", async () => {
    await expect(main.query(readFileSync(BOOTSTRAP, "utf8"))).rejects.toThrow(
      /runs only in ductus_legal/,
    );
    const client = await main.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = public, pg_catalog");
      await client.query(
        "CREATE FUNCTION public.current_database() RETURNS name LANGUAGE sql AS $f$ SELECT 'ductus_legal'::name $f$",
      );
      await expect(client.query(readFileSync(BOOTSTRAP, "utf8"))).rejects.toThrow(
        /runs only in ductus_legal \(current: ductus\)/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
