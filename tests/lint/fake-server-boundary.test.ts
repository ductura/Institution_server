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

async function restricted(filePath: string, spec: string) {
  const code = `import { createFakeServer } from "${spec}";\nexport const x = createFakeServer;\n`;
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").length;
}

describe("fake server import boundary (eslint.config.ts)", () => {
  it.each([
    ["server/contracts/example.ts", "./generated/fake-server/index.ts"],
    ["server/http/example.ts", "../contracts/generated/fake-server/index.ts"],
    ["server/index.ts", "./contracts/generated/fake-server/vectors.ts"],
    ["scripts/example.ts", "../server/contracts/generated/fake-server/index.ts"],
  ])("rejects it in production code %s", async (filePath, spec) => {
    expect(await restricted(filePath, spec)).toBe(1);
  });

  it.each([
    ["server/contracts/example.test.ts", "./generated/fake-server/index.ts"],
    ["server/contracts/example.integration.test.ts", "./generated/fake-server/index.ts"],
    ["server/test-server/index.ts", "../contracts/generated/fake-server/index.ts"],
    ["test-support/fakes/index.ts", "../../server/contracts/generated/fake-server/index.ts"],
  ])("allows it in test code %s", async (filePath, spec) => {
    expect(await restricted(filePath, spec)).toBe(0);
  });

  it("keeps the driver boundary in test code", async () => {
    const [result] = await eslint.lintText('import pg from "pg";\nexport const x = pg;\n', {
      filePath: "server/http/example.test.ts",
    });
    expect(result!.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });
});
