import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// As tests/lint/pg-import-boundary.test.ts: the root config with the native
// TypeScript config flag.
const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: fileURLToPath(new URL("../../eslint.config.ts", import.meta.url)),
  flags: ["unstable_native_nodejs_ts_config"],
});

beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "server/domain/example.ts" });
}, 60_000);

async function reported(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "local/no-fake-server-import").length;
}
const restricted = (filePath: string, spec: string) =>
  reported(
    filePath,
    `import { createFakeServer } from "${spec}";\nexport const x = createFakeServer;\n`,
  );

describe("fake server import boundary (eslint.config.ts)", () => {
  it.each([
    ["server/contracts/example.ts", "./generated/fake-server/index.ts"],
    ["server/http/example.ts", "../contracts/generated/fake-server/index.ts"],
    ["server/index.ts", "./contracts/generated/fake-server/vectors.ts"],
    ["scripts/example.ts", "../server/contracts/generated/fake-server/index.ts"],
    // The database block switches no-restricted-imports off; this rule stays on.
    ["server/database/example.ts", "../contracts/generated/fake-server/index.ts"],
    ["server/http/example.ts", "../contracts/generated/./fake-server/index.ts"],
    ["server/http/example.ts", "..\\\\contracts\\\\generated\\\\fake-server\\\\index.ts"],
  ])("rejects it in production code %s (%s)", async (filePath, spec) => {
    expect(await restricted(filePath, spec)).toBe(1);
  });

  it.each([
    [
      "scripts/example.ts",
      'export const load = () => import("../server/contracts/generated/fake-server/index.ts");\n',
    ],
    [
      "server/database/example.ts",
      'export const load = () => import("../contracts/generated/fake-server/index.ts");\n',
    ],
    [
      "server/http/example.ts",
      'import { createRequire } from "node:module";\nexport const x = createRequire(import.meta.url)("../contracts/generated/fake-server/index.ts");\n',
    ],
    ["server/http/example.ts", 'export * from "../contracts/generated/fake-server/index.ts";\n'],
  ])("rejects a dynamic import, require or re-export in %s", async (filePath, code) => {
    expect(await reported(filePath, code)).toBe(1);
  });

  it.each([
    ["server/contracts/example.test.ts", "./generated/fake-server/index.ts"],
    ["server/contracts/example.integration.test.ts", "./generated/fake-server/index.ts"],
    ["server/test-server/index.ts", "../contracts/generated/fake-server/index.ts"],
    ["test-support/fakes/index.ts", "../../server/contracts/generated/fake-server/index.ts"],
  ])("allows it in test code %s", async (filePath, spec) => {
    expect(await restricted(filePath, spec)).toBe(0);
  });

  it("leaves other paths alone", async () => {
    expect(await restricted("server/http/example.ts", "../contracts/generated/index.ts")).toBe(0);
    expect(await restricted("server/http/example.ts", "./fake-server-like/index.ts")).toBe(0);
  });

  it("keeps the driver boundary in test code", async () => {
    const [result] = await eslint.lintText('import pg from "pg";\nexport const x = pg;\n', {
      filePath: "server/http/example.test.ts",
    });
    expect(result!.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });
});
