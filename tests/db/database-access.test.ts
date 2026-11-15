// S-1F-c (DAN-779): the access validator against catalogues that are wrong in
// one way each. tests/db/logs-database.integration.test.ts runs it on a real
// cluster; here every rule must fail on its own.
import assert from "node:assert/strict";

import { test } from "vitest";

import {
  checkDatabaseAccess,
  databasePolicy,
  privilegesOf,
  type GrantRow,
  type RoleRow,
} from "./database-access.ts";

const policy = databasePolicy("db_x", "x_migrator", ["x_writer"]);
const roles: RoleRow[] = [
  { role: "admin", superuser: true, inherits: ["admin"] },
  { role: "x_migrator", superuser: false, inherits: ["x_migrator"] },
  { role: "x_writer", superuser: false, inherits: ["x_writer"] },
  { role: "x_writer_login", superuser: false, inherits: ["x_writer_login", "x_writer"] },
  { role: "main_app", superuser: false, inherits: ["main_app"] },
  { role: "pg_database_owner", superuser: false, inherits: ["pg_database_owner"] },
  { role: "pg_read_all_data", superuser: false, inherits: ["pg_read_all_data"] },
  { role: "pg_write_all_data", superuser: false, inherits: ["pg_write_all_data"] },
];
const HOLDS: Record<string, string[]> = {
  "database:db_x|CONNECT": ["x_migrator", "x_writer", "x_writer_login"],
  "database:db_x|CREATE": ["x_migrator"],
  "database:db_x|TEMPORARY": ["x_migrator"],
  "schema:db_x.public|USAGE": [
    "x_migrator",
    "x_writer",
    "x_writer_login",
    "pg_database_owner",
    "pg_read_all_data",
    "pg_write_all_data",
  ],
  "schema:db_x.public|CREATE": ["x_migrator", "pg_database_owner"],
};

/** The full, correct catalogue: every role × object × privilege. */
function catalogue(): GrantRow[] {
  return Object.keys(policy).flatMap((object) =>
    privilegesOf(object).flatMap((privilege) =>
      roles.map(({ role }) => ({
        role,
        object,
        privilege,
        granted: role === "admin" || (HOLDS[`${object}|${privilege}`] ?? []).includes(role),
      })),
    ),
  );
}

function flip(rows: GrantRow[], role: string, object: string, privilege: string): GrantRow[] {
  return rows.map((row) =>
    row.role === role && row.object === object && row.privilege === privilege
      ? { ...row, granted: !row.granted }
      : row,
  );
}

test("the right catalogue passes and every row counts", () => {
  const result = checkDatabaseAccess(roles, catalogue(), policy);
  assert.deepEqual(result.errors, []);
  assert.equal(result.checked, roles.length * 5);
});

test("a role of another database that can connect fails", () => {
  const rows = flip(catalogue(), "main_app", "database:db_x", "CONNECT");
  assert.match(
    checkDatabaseAccess(roles, rows, policy).errors.join("\n"),
    /main_app has CONNECT on database:db_x and must not/,
  );
});

test("CREATE or TEMPORARY for anyone but the owner fails, in the database and in public", () => {
  for (const [object, privilege] of [
    ["database:db_x", "CREATE"],
    ["database:db_x", "TEMPORARY"],
    ["schema:db_x.public", "CREATE"],
  ] as const) {
    const rows = flip(catalogue(), "x_writer", object, privilege);
    assert.match(
      checkDatabaseAccess(roles, rows, policy).errors.join("\n"),
      new RegExp(`x_writer has ${privilege} on ${object.replace(".", "\\.")} and must not`),
    );
  }
});

test("a named role that lacks its privilege fails, also through inheritance", () => {
  const direct = flip(catalogue(), "x_writer", "schema:db_x.public", "USAGE");
  assert.match(
    checkDatabaseAccess(roles, direct, policy).errors.join("\n"),
    /x_writer lacks USAGE/,
  );
  const inherited = flip(catalogue(), "x_writer_login", "database:db_x", "CONNECT");
  assert.match(
    checkDatabaseAccess(roles, inherited, policy).errors.join("\n"),
    /x_writer_login lacks CONNECT/,
  );
});

test("a missing row, a duplicated row, an unknown role or an unknown object fails", () => {
  const rows = catalogue();
  const missing = rows.filter((row) => !(row.role === "main_app" && row.privilege === "CONNECT"));
  assert.match(
    checkDatabaseAccess(roles, missing, policy).errors.join("\n"),
    /main_app CONNECT on database:db_x is missing/,
  );
  assert.match(
    checkDatabaseAccess(roles, [...rows, rows[0] as GrantRow], policy).errors.join("\n"),
    /in the input twice/,
  );
  const ghost = { role: "ghost", object: "database:db_x", privilege: "CONNECT", granted: false };
  assert.match(
    checkDatabaseAccess(roles, [...rows, ghost], policy).errors.join("\n"),
    /ghost has a privilege row but is not a role/,
  );
  const other = { role: "main_app", object: "database:other", privilege: "CONNECT", granted: true };
  assert.match(
    checkDatabaseAccess(roles, [...rows, other], policy).errors.join("\n"),
    /CONNECT on database:other is not in the policy/,
  );
});

test("an empty catalogue, or a policy role that does not exist, never passes", () => {
  assert.match(checkDatabaseAccess([], [], policy).errors.join("\n"), /no privilege was checked/);
  const noWriter = roles.filter((row) => row.role !== "x_writer");
  const rows = catalogue().filter((row) => row.role !== "x_writer");
  assert.match(
    checkDatabaseAccess(noWriter, rows, policy).errors.join("\n"),
    /x_writer is in the policy but not a role/,
  );
});

test("a superuser is the one role outside the policy", () => {
  const rows = catalogue().map((row) => (row.role === "admin" ? { ...row, granted: true } : row));
  assert.deepEqual(checkDatabaseAccess(roles, rows, policy).errors, []);
});
