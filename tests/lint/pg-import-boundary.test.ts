import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// As tests/lint/rules.test.ts: the root config, which this ESLint loads
// only with the native TypeScript config flag.
const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: fileURLToPath(new URL("../../eslint.config.ts", import.meta.url)),
  flags: ["unstable_native_nodejs_ts_config"],
});

// The first lintText call loads the ESLint config and the TypeScript parser,
// which takes several seconds on a busy machine. Pay that once here, with its
// own budget, so it is not charged to the first case's 5 s test timeout.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "server/domain/example.ts" });
}, 60_000);

async function restrictedImports(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((message) => message.ruleId === "no-restricted-imports").length;
}

describe("pg import boundary (eslint.config.ts)", () => {
  it.each([
    ["server/domain/example.ts", 'import pg from "pg";\nexport const x = pg;\n'],
    ["server/session/example.ts", 'import { Pool } from "pg";\nexport const x = Pool;\n'],
    ["server/http/example.ts", 'import Cursor from "pg-cursor";\nexport const x = Cursor;\n'],
    [
      "server/log/example.ts",
      'import { escapeLiteral } from "pg/lib/utils";\nexport const x = escapeLiteral;\n',
    ],
    // D-91 (3): the migration runner takes its lock connection from server/database.
    ["scripts/db/migrate-locked.ts", 'import pg from "pg";\nexport const x = pg;\n'],
  ])("rejects the driver in %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toBe(1);
  });

  it.each([
    ["server/database/pool.ts", 'import pg from "pg";\nexport const x = pg;\n'],
    ["tests/db/example.integration.test.ts", 'import pg from "pg";\nexport const x = pg;\n'],
    ["server/domain/example.ts", 'import { page } from "./pg-like";\nexport const x = page;\n'],
  ])("allows %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toBe(0);
  });
});
