// S-0.14 (DAN-727): the local stack files keep LF on every platform. A CRLF
// checkout (core.autocrlf=true on Windows) would hand psql "\r" at the end of
// every \if and \gexec line and the image a shell script that sh cannot run.
// The first test fails when .gitattributes loses or narrows the rule, the
// second when a checkout or an edit brought a CR in anyway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SQL = readdirSync(join(ROOT, "db", "main", "local"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ["db", "main", "local", name].join("/"));
const FILES = [
  ...SQL,
  "infra/postgres/assert-pg-version.sh",
  "infra/postgres/Dockerfile",
  "compose.yaml",
];

test("the local stack files are all there", () => {
  assert.deepEqual(SQL, [
    "db/main/local/app-login.sql",
    "db/main/local/auth-login.sql",
    "db/main/local/demo-k3.sql",
    "db/main/local/evidence-signing-key.sql",
    "db/main/local/migrator.sql",
    "db/main/local/provision-demo-teacher.sql",
    "db/main/local/seed.sql",
    "db/main/local/worker-login.sql",
  ]);
});

test("git checks every local stack file out as text with eol=lf", () => {
  const out = execFileSync("git", ["check-attr", "text", "eol", "--", ...FILES], {
    cwd: ROOT,
    encoding: "utf8",
  });
  for (const file of FILES) {
    assert.ok(out.includes(`${file}: text: set\n`), `${file}: text`);
    assert.ok(out.includes(`${file}: eol: lf\n`), `${file}: eol=lf`);
  }
});

test("no local stack file holds a carriage return", () => {
  for (const file of FILES) {
    assert.ok(!readFileSync(join(ROOT, file)).includes(0x0d), `${file} contains \\r`);
  }
});
