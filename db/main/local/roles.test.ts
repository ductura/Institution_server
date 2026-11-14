// S-0.14 (DAN-727) acceptance: the provisioning files make the same roles as
// Ductus at d52a92c3. The list is roles.ts; this reads the SQL files, so a role
// added, dropped, renamed or given another attribute or membership in a file
// fails here. tests/db/local-roles.integration.test.ts checks the same list against a
// real PostgreSQL brought up by `pnpm db:up:native`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

import { GROUP_ROLES, LOGIN_ROLES, MIGRATOR_ROLE } from "./roles.ts";

const read = (file: string): string => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
/** The SQL without comment lines. */
const code = (file: string): string =>
  read(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

test("the Ductus role list: migrator, six group roles, three logins", () => {
  assert.equal(MIGRATOR_ROLE, "ductus_migrator");
  assert.deepEqual(
    [...GROUP_ROLES],
    [
      "ductus_app",
      "ductus_worker",
      "ductus_retention",
      "ductus_evidence",
      "ductus_identity",
      "ductus_auth",
    ],
  );
  assert.deepEqual(
    LOGIN_ROLES.map(({ login, group }) => [login, group]),
    [
      ["ductus_app_local", "ductus_app"],
      ["ductus_worker_local", "ductus_worker"],
      ["ductus_auth_local", "ductus_auth"],
    ],
  );
});

test("migrator.sql makes the migrator with CREATEROLE only, and exactly the group roles of the list", () => {
  const sql = code("migrator.sql");
  assert.match(
    sql,
    /CREATE ROLE ductus_migrator NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;/,
  );
  const array = /group_roles CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(sql);
  assert.ok(array, "migrator.sql declares group_roles");
  const named = [...(array[1] ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(named, [...GROUP_ROLES]);
  assert.match(
    sql,
    /'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'/,
  );
  assert.match(
    sql,
    /SET ROLE ductus_migrator;[\s\S]*FOREACH role_name IN ARRAY group_roles[\s\S]*RESET ROLE;/,
  );
  // No file other than the login files makes a login or sets a password.
  assert.doesNotMatch(sql, /\bPASSWORD\b|ALTER ROLE/);
});

test("each login file makes its one login, a plain member of exactly one group role", () => {
  for (const { login, file, group } of LOGIN_ROLES) {
    const sql = code(file);
    assert.match(sql, new RegExp(`CREATE ROLE ${login};`), `${file} creates ${login}`);
    assert.match(
      sql,
      new RegExp(
        `ALTER ROLE ${login}\\s+LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      ),
      `${file}: ${login} is a plain login`,
    );
    const grants = [...sql.matchAll(/^GRANT (\S+) TO (\S+) (.*);$/gm)].map((match) =>
      match.slice(1),
    );
    assert.deepEqual(
      grants,
      [[group, login, "WITH INHERIT TRUE, SET FALSE"]],
      `${file}: the one membership`,
    );
    const created = [...sql.matchAll(/CREATE ROLE (\w+)/g)].map((match) => match[1]);
    assert.deepEqual(created, [login], `${file} creates no other role`);
  }
});

test("only app-login.sql holds a password, and it is marked local-only", () => {
  assert.match(code("app-login.sql"), /PASSWORD 'ductus-app-local-only';/);
  for (const file of ["worker-login.sql", "auth-login.sql", "migrator.sql"]) {
    assert.doesNotMatch(code(file), /PASSWORD\s+'/, `${file} has no password literal`);
  }
});
