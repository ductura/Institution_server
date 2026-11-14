// Ported from Ductus scripts/db/provision-auth.test.mjs at d52a92c3 (S-0.14,
// DAN-727): same assertions, node:test replaced by vitest, .mjs by .ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

import { authProvisionInvocation } from "./provision-auth.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("auth provisioning script does not rely on shell variable expansion (cmd.exe does not expand $VAR)", () => {
  const script = pkg.scripts["db:provision:auth"];
  assert.doesNotMatch(script ?? "$", /\$/);
  assert.equal(script, "node scripts/db/provision-auth.ts");
});

test("auth password reaches psql as a literal argv element, whatever characters it holds", () => {
  const password = 'pa ss$DUCTUS"%PATH%&|word-0123456789';
  const { command, args, stdinFile } = authProvisionInvocation({
    DUCTUS_AUTH_LOCAL_PASSWORD: password,
  });
  assert.equal(command, "docker");
  assert.ok(args.includes(`auth_password=${password}`));
  assert.match(stdinFile, /auth-login\.sql$/);
});

test("auth provisioning refuses a missing or short password instead of setting a literal one", () => {
  assert.throws(() => authProvisionInvocation({}), /at least 16/);
  assert.throws(
    () => authProvisionInvocation({ DUCTUS_AUTH_LOCAL_PASSWORD: "short" }),
    /at least 16/,
  );
});
