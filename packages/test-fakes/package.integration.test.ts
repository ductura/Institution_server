import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// U9 (DAN-741): the package as another package sees it, through
// node_modules/@ductura/test-fakes, in a fresh process.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const NAME = "@ductura/test-fakes";
const ENTRIES = [
  "",
  "/oidc",
  "/fake-server",
  "/clock",
  "/services",
  "/fido2",
  "/hostile-inputs",
  "/invented-works",
  "/pglite",
  "/dev-server",
  "/tsa",
];

function load(specifier: string, nodeEnv: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const code = `import(${JSON.stringify(specifier)}).then((m) => console.log(Object.keys(m).sort().join(",")));`;
  const run = spawnSync(TSX, ["--eval", code], { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
}

describe("@ductura/test-fakes as a package", () => {
  it("exports exactly the root and the ten modules", () => {
    const own = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(Object.keys(own.exports).sort()).toEqual(ENTRIES.map((entry) => `.${entry}`).sort());
  });

  it.each(ENTRIES)(
    "loads %j in a test process",
    (entry) => {
      const result = load(`${NAME}${entry}`, "test");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toBe("");
    },
    30_000,
  );

  it("the root re-exports every module", () => {
    const root = load(NAME, undefined).stdout.split(",");
    for (const entry of ENTRIES.slice(1)) {
      for (const name of load(`${NAME}${entry}`, "development").stdout.split(","))
        expect(root, `${entry} ${name}`).toContain(name);
    }
  }, 60_000);

  it.each([
    `${NAME}/oidc/server.ts`,
    `${NAME}/oidc/guard.ts`,
    `${NAME}/guard`,
    `${NAME}/clock/clock.ts`,
    `${NAME}/pglite/log.ts`,
    `${NAME}/pglite/database.ts`,
    `${NAME}/package.json`,
    `${NAME}/boundary.test.ts`,
  ])(
    "refuses the path %s that it does not export",
    (specifier) => {
      const result = load(specifier, "test");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|not exported/u);
    },
    30_000,
  );

  // D-09: in production the package does not load at all, through any entry.
  it.each(
    ENTRIES.flatMap((entry) =>
      ["production", "Production", " production", "staging"].map(
        (nodeEnv) => [entry, nodeEnv] as const,
      ),
    ),
  )(
    "refuses to load %j with NODE_ENV=%j",
    (entry, nodeEnv) => {
      const result = load(`${NAME}${entry}`, nodeEnv);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/fake OIDC runs only locally and in CI/u);
    },
    30_000,
  );
});
