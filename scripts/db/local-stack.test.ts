// S-0.14 (DAN-727): the local stack scripts in package.json and compose.yaml.
// The db:migrate assertions are Ductus scripts/engineering/migrate-locked.test.mjs
// "pnpm db:migrate applies migrations only through the locked runner" at
// d52a92c3, which S-0.13 (#17) left for the script's port; .mjs became .ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

const { scripts } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  scripts: Record<string, string>;
};
const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");

// S-1F-c (DAN-779): the main chain moved, unchanged, to db:migrate:main;
// scripts/db/databases.test.ts holds db:migrate to the list of databases.
test("pnpm db:migrate:main applies migrations only through the locked runner", () => {
  assert.match(
    scripts["db:migrate:main"] ?? "",
    /node scripts\/db\/migrate-locked\.ts --url "[^"]+role=ductus_migrator"/,
  );
  for (const name of ["db:migrate", "db:migrate:main", "db:migrate:logs", "db:migrate:legal"]) {
    assert.doesNotMatch(scripts[name] ?? "", /\bdbmate\b[^&]*\sup\b/);
  }
});

test("pnpm db:migrate:main provisions in the Ductus order: migrator, migrations, app, worker and auth logins", () => {
  const steps = (scripts["db:migrate:main"] ?? "").split(" && ");
  assert.deepEqual(
    steps.map((step) => (step.split(" ")[0] === "pnpm" ? step : "migrate-locked")),
    [
      "pnpm db:provision",
      "migrate-locked",
      "pnpm db:provision:app",
      "pnpm db:provision:worker",
      "pnpm db:provision:auth",
    ],
  );
  assert.match(
    scripts["db:provision"] ?? "",
    /postgres-main psql .* < db\/main\/local\/migrator\.sql$/,
  );
  assert.match(
    scripts["db:provision:app"] ?? "",
    /postgres-main psql .* < db\/main\/local\/app-login\.sql$/,
  );
});

test("pnpm db:up starts the main and the logs database services, then migrates", () => {
  assert.equal(
    scripts["db:up"],
    "docker compose up -d --build --wait postgres-main postgres-logs && pnpm db:migrate",
  );
});

test("compose binds every port to 127.0.0.1 and uses only local-only passwords", () => {
  const ports = [...compose.matchAll(/^\s+- "([^"]+:\d+)"$/gm)].map((match) => match[1] ?? "");
  assert.ok(ports.length > 0);
  for (const port of ports) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/);
  const passwords = [...compose.matchAll(/PASSWORD: (\S+)$/gm)].map((match) => match[1] ?? "");
  assert.ok(passwords.length > 0);
  for (const password of passwords) assert.match(password, /-local-only$/);
  assert.match(scripts["db:migrate:main"] ?? "", /ductus:ductus-local-only@127\.0\.0\.1:54329\//);
  assert.match(
    scripts["db:migrate:logs"] ?? "",
    /ductus:ductus-logs-local-only@127\.0\.0\.1:54330\/ductus_logs\?/,
  );
});
