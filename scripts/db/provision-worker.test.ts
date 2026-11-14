// Ported from Ductus scripts/db/provision-worker.test.mjs at d52a92c3 (S-0.14,
// DAN-727): same assertions, node:test replaced by vitest, .mjs by .ts and
// db/local by db/main/local.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

import { workerProvisionInvocation } from "./provision-worker.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("worker provisioning script does not rely on shell variable expansion (cmd.exe does not expand $VAR)", () => {
  const script = pkg.scripts["db:provision:worker"];
  assert.doesNotMatch(script ?? "$", /\$/);
  assert.equal(script, "node scripts/db/provision-worker.ts");
});

test("worker password reaches psql as a literal argv element, whatever characters it holds", () => {
  const password = 'pa ss$DUCTUS"%PATH%&|word-0123456789';
  const { command, args, stdinFile } = workerProvisionInvocation({
    DUCTUS_WORKER_LOCAL_PASSWORD: password,
  });
  assert.equal(command, "docker");
  assert.ok(args.includes(`worker_password=${password}`));
  assert.match(stdinFile, /worker-login\.sql$/);
});

test("worker provisioning refuses a missing or short password instead of setting a literal one", () => {
  assert.throws(() => workerProvisionInvocation({}), /at least 16/);
  assert.throws(
    () => workerProvisionInvocation({ DUCTUS_WORKER_LOCAL_PASSWORD: "short" }),
    /at least 16/,
  );
});

test("worker-login.sql takes the password only from the psql variable, never a literal (QA c.6647487396)", () => {
  const sql = readFileSync(
    new URL("../../db/main/local/worker-login.sql", import.meta.url),
    "utf8",
  );
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(code, /PASSWORD\s+'/i);
  assert.match(code, /PASSWORD %L',\n\s*:'worker_password'\n\) \\gexec/);
  assert.match(code, /\\if :\{\?worker_password\}/);
});
