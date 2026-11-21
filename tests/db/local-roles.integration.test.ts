// S-0.14 (DAN-727) acceptance against a real PostgreSQL: after
// `pnpm db:up:native` the cluster holds exactly the ductus_* roles of Ductus at
// d52a92c3, with their attributes, and each local login inherits exactly its
// one group role. It reads the database that db:up:native made, through the
// same loopback login and stored password as `pnpm test:db:native`
// (DUCTUS_NATIVE_PGPORT and friends). CI runs `pnpm db:up:native` on its own
// cluster in the job `database` before this file; with no database it fails,
// it never skips.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { test } from "vitest";

import {
  GROUP_ATTRIBUTES,
  GROUP_ROLES,
  LOGIN_ATTRIBUTES,
  LOGIN_ROLES,
  MIGRATION_ROLES,
  MIGRATOR_ATTRIBUTES,
  MIGRATOR_ROLE,
  type RoleAttributes,
} from "../../db/main/local/index.ts";
import {
  childEnv,
  fileStore,
  loginPassword,
  nativeConfig,
  passwordFile,
} from "../../scripts/db/index.ts";

/** Rows of `sql` from the native database, columns split on "|". */
function query(sql: string): string[][] {
  const config = nativeConfig(process.env);
  const password = loginPassword(process.env, fileStore(passwordFile(process.env)), {
    create: false,
  });
  const result = spawnSync(
    "psql",
    [
      "-h",
      config.host,
      "-p",
      config.port,
      "-U",
      config.user,
      "-d",
      config.database,
      "-X",
      "-q",
      "-A",
      "-t",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8", env: childEnv(process.env, password) },
  );
  assert.equal(result.status, 0, `psql failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("|"));
}

const flags = (attributes: RoleAttributes): string =>
  [
    attributes.login,
    attributes.superuser,
    attributes.inherit,
    attributes.createRole,
    attributes.createDb,
    attributes.replication,
    attributes.bypassRls,
  ]
    .map((value) => (value ? "t" : "f"))
    .join("");

test("the cluster holds exactly the expected ductus_* roles, with their attributes", () => {
  const expected = new Map<string, string>([
    [MIGRATOR_ROLE, flags(MIGRATOR_ATTRIBUTES)],
    ...GROUP_ROLES.map((role): [string, string] => [role, flags(GROUP_ATTRIBUTES)]),
    ...MIGRATION_ROLES.map((role): [string, string] => [role, flags(GROUP_ATTRIBUTES)]),
    ["ductus_problem_report_reader", flags(GROUP_ATTRIBUTES)],
    ...LOGIN_ROLES.map(({ login }): [string, string] => [login, flags(LOGIN_ATTRIBUTES)]),
  ]);
  const rows = query(
    "SELECT rolname, concat_ws('', CASE WHEN rolcanlogin THEN 't' ELSE 'f' END, CASE WHEN rolsuper THEN 't' ELSE 'f' END," +
      " CASE WHEN rolinherit THEN 't' ELSE 'f' END, CASE WHEN rolcreaterole THEN 't' ELSE 'f' END," +
      " CASE WHEN rolcreatedb THEN 't' ELSE 'f' END, CASE WHEN rolreplication THEN 't' ELSE 'f' END," +
      " CASE WHEN rolbypassrls THEN 't' ELSE 'f' END) FROM pg_catalog.pg_roles WHERE rolname LIKE 'ductus\\_%' ORDER BY rolname",
  );
  assert.deepEqual(
    new Map(rows.map(([role, value]) => [role as string, value as string])),
    new Map([...expected].sort()),
  );
});

test("the migrator administers every group role it made", () => {
  const rows = query(
    "SELECT r.rolname FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid" +
      " WHERE m.member = 'ductus_migrator'::regrole AND m.admin_option ORDER BY r.rolname",
  );
  const administered = rows.map(([role]) => role);
  for (const role of GROUP_ROLES)
    assert.ok(administered.includes(role), `ductus_migrator administers ${role}`);
});

test("each local login inherits exactly its one group role, without SET or ADMIN", () => {
  for (const { login, group } of LOGIN_ROLES) {
    const rows = query(
      "SELECT r.rolname, m.inherit_option, m.set_option, m.admin_option FROM pg_catalog.pg_auth_members m" +
        ` JOIN pg_catalog.pg_roles r ON r.oid = m.roleid WHERE m.member = '${login}'::regrole`,
    );
    assert.deepEqual(rows, [[group, "t", "f", "f"]], login);
  }
});
