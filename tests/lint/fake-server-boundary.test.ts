import { fileURLToPath, pathToFileURL } from "node:url";

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
    // A relative path that names the folder only once resolved against the importer.
    ["server/contracts/generated/client.ts", "./fake-server/index.ts"],
    ["server/contracts/generated/client.ts", "./fake-server"],
    ["server/contracts/example.ts", "./generated/../generated/fake-server/index.ts"],
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

  // QA on e34b91f6 (c.6886570274): every form a file can name a module with,
  // each from the production entry point. The first passed the rule there.
  const FAKE = "./contracts/generated/fake-server/index.ts";
  it.each([
    ["import x = require", `import fake = require("${FAKE}");\nexport const x = fake;\n`],
    ["export import x = require", `export import fake = require("${FAKE}");\n`],
    ["import", `import { createFakeServer } from "${FAKE}";\nexport const x = createFakeServer;\n`],
    ["import of the side effects", `import "${FAKE}";\n`],
    ["import type", `import type { FakeRequest } from "${FAKE}";\nexport type X = FakeRequest;\n`],
    [
      "import { type x }",
      `import { type FakeRequest } from "${FAKE}";\nexport type X = FakeRequest;\n`,
    ],
    ["export from", `export { createFakeServer } from "${FAKE}";\n`],
    ["export type from", `export type { FakeRequest } from "${FAKE}";\n`],
    ["export * as", `export * as fake from "${FAKE}";\n`],
    ["import()", `export const load = () => import("${FAKE}");\n`],
    ["import() of a template", `export const load = () => import(\`${FAKE}\`);\n`],
    ["typeof import()", `export type X = typeof import("${FAKE}");\n`],
    ["import() type", `export type X = import("${FAKE}").FakeRequest;\n`],
    ["require", `export const x: unknown = require("${FAKE}");\n`],
    ["module.require", `export const x: unknown = module.require("${FAKE}");\n`],
    ["require.resolve", `export const x = require.resolve("${FAKE}");\n`],
    ["import.meta.resolve", `export const x = import.meta.resolve("${FAKE}");\n`],
    ["/// <reference path>", `/// <reference path="${FAKE}" />\nexport {};\n`],
  ])("rejects %s in server/index.ts", async (_, code) => {
    expect(await reported("server/index.ts", code)).toBe(1);
  });

  // Spellings that load the same folder: a .js or no extension, the folder
  // alone, another letter case (Windows, macOS), %-escapes, a file: URL.
  it.each([
    "./contracts/generated/fake-server/index.js",
    "./contracts/generated/fake-server/index",
    "./contracts/generated/fake-server",
    "./contracts/generated/fake-server/",
    "./contracts/generated/fake-server/vectors.json",
    "./Contracts/Generated/Fake-Server/index.ts",
    "./contracts/generated/fake%2Dserver/index.ts",
    "./contracts/generated%2Ffake-server/index.ts",
    "file:///repo/server/contracts/generated/fake-server/index.ts",
    " ./contracts/generated/fake-server/index.ts",
  ])("rejects the spelling %s", async (spec) => {
    expect(await reported("server/index.ts", `import fake = require("${spec}");\n`)).toBe(1);
    expect(await reported("server/index.ts", `export * from "${spec}";\n`)).toBe(1);
  });

  // A re-export through test code, where the rule is off, would carry the fake
  // server into production; production code does not load test code at all.
  it.each([
    "./test-server/index.ts",
    "../test-support/fakes/index.ts",
    "./contracts/fake-server.test.ts",
    "./contracts/example.integration.test.ts",
    "./Test-Server/index.js",
    "./test-server",
  ])("rejects test code %s in server/index.ts", async (spec) => {
    expect(await reported("server/index.ts", `export * from "${spec}";\n`)).toBe(1);
    expect(await reported("server/index.ts", `import x = require("${spec}");\n`)).toBe(1);
    expect(await reported("server/index.ts", `export type X = typeof import("${spec}");\n`)).toBe(
      1,
    );
  });

  // U9 (DAN-741): the test fakes package, by name or by path, is test code.
  it.each([
    "@ductura/test-fakes",
    "@ductura/test-fakes/oidc",
    "@ductura/test-fakes/fake-server",
    "@ductura/test-fakes/pglite",
    "@Ductura/Test-Fakes/clock",
    "@ductura/test-fakes/oidc/server.ts",
    "../packages/test-fakes/index.ts",
    "../packages/test-fakes/oidc/index.ts",
    "../Packages/Test-Fakes/fido2/index.ts",
    "../packages/./test-fakes/services/index.ts",
    "..\\\\packages\\\\test-fakes\\\\index.ts",
    "../packages/test%2Dfakes/index.ts",
    pathToFileURL(`${REPO_ROOT}packages/test-fakes/index.ts`).href,
  ])("rejects the test fakes %s in production code", async (spec) => {
    // One folder below the root, so a relative path reaches packages/.
    for (const filePath of ["server/index.ts", "server/example.ts", "scripts/example.ts"]) {
      const code = `import * as fakes from "${spec}";\nexport const x = fakes;\n`;
      expect(await reported(filePath, code), `${filePath} ${spec}`).toBe(1);
    }
    expect(await reported("server/index.ts", `export * from "${spec}";\n`)).toBe(1);
    expect(
      await reported("server/index.ts", `export const load = () => import("${spec}");\n`),
    ).toBe(1);
    expect(await reported("server/index.ts", `export type X = typeof import("${spec}");\n`)).toBe(
      1,
    );
  });

  it("allows the test fakes in tests and inside the package", async () => {
    const code = 'import * as fakes from "@ductura/test-fakes";\nexport const x = fakes;\n';
    expect(await reported("server/session/example.test.ts", code)).toBe(0);
    expect(await reported("packages/test-fakes/clock/clock.ts", code)).toBe(0);
    expect(
      await restricted(
        "packages/test-fakes/fake-server/index.ts",
        "../../../server/contracts/generated/fake-server/index.ts",
      ),
    ).toBe(0);
    // A name that only starts like it is another package.
    expect(await reported("server/index.ts", 'export * from "@ductura/test-fakesx";\n')).toBe(0);
  });

  it("allows a production helper and test code inside test code", async () => {
    expect(await reported("server/index.ts", 'export * from "./contracts/index.ts";\n')).toBe(0);
    expect(
      await reported(
        "server/test-server/index.ts",
        'export * from "../../test-support/x/index.ts";\n',
      ),
    ).toBe(0);
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
    // A folder named fake-server elsewhere is not the generated one.
    expect(await restricted("server/http/example.ts", "./fake-server/index.ts")).toBe(0);
  });

  it("keeps the driver boundary in test code", async () => {
    const [result] = await eslint.lintText('import pg from "pg";\nexport const x = pg;\n', {
      filePath: "server/http/example.test.ts",
    });
    expect(result!.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });
});

// DAN-950: production code binds no import or export to a name of a fake
// (Fake*, fake*, FAKE_*), whatever module it comes from.
describe("fake names in production code (fakeName)", () => {
  async function fakeNames(filePath: string, code: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return result!.messages.filter((m) => m.messageId === "fakeName").length;
  }
  const INDEX = "./c/index.ts";

  it.each([
    [
      "import { FakeEmail }",
      `import { FakeEmail } from "${INDEX}";\nexport const x = FakeEmail;\n`,
    ],
    ["import { a as FakeA }", `import { a as FakeA } from "${INDEX}";\nexport const x = FakeA;\n`],
    ["import { FakeA as a }", `import { FakeA as a } from "${INDEX}";\nexport const x = a;\n`],
    ["import a string name", `import { "FakeA" as a } from "${INDEX}";\nexport const x = a;\n`],
    ["import default", `import fakeClock from "${INDEX}";\nexport const x = fakeClock;\n`],
    ["import * as", `import * as FAKE_KEYS from "${INDEX}";\nexport const x = FAKE_KEYS;\n`],
    ["import type", `import type { FakeStore } from "${INDEX}";\nexport type X = FakeStore;\n`],
    ["inline type", `import { type Fake } from "${INDEX}";\nexport type X = Fake;\n`],
    ["export from", `export { Fake2 } from "${INDEX}";\n`],
    ["export as from", `export { a as fake$ } from "${INDEX}";\n`],
    ["export local as", `const a = 1;\nexport { a as FakeA };\n`],
    ["export * as", `export * as FAKE from "${INDEX}";\n`],
    ["import = require", `import FakeA = require("${INDEX}");\nexport const x = FakeA;\n`],
    [
      "import = namespace",
      `namespace N { export const y = 1; }\nimport FakeY = N.y;\nexport const x = FakeY;\n`,
    ],
  ])("rejects %s in server/external/email/example.ts", async (_, code) => {
    expect(await fakeNames("server/external/email/example.ts", code)).toBe(1);
    expect(await fakeNames("scripts/example.ts", code)).toBe(1);
  });

  it.each([
    ["faker", `import { faker } from "${INDEX}";\nexport const x = faker;\n`],
    ["FAKER", `import { FAKER } from "${INDEX}";\nexport const x = FAKER;\n`],
    ["fakeness", `import { fakeness } from "${INDEX}";\nexport const x = fakeness;\n`],
    ["Fakery", `import { Fakery } from "${INDEX}";\nexport const x = Fakery;\n`],
    ["isFake", `import { isFake } from "${INDEX}";\nexport const x = isFake;\n`],
    ["an exported declaration", "export const FakeX = 1;\n"],
  ])("allows %s in production code", async (_, code) => {
    expect(await fakeNames("server/external/email/example.ts", code)).toBe(0);
  });

  it.each(["server/http/example.test.ts", "server/test-server/example.ts", "test-support/x.ts"])(
    "allows fake names in test code %s",
    async (filePath) => {
      const code = `import { FakeEmail } from "${INDEX}";\nexport const x = FakeEmail;\n`;
      expect(await fakeNames(filePath, code)).toBe(0);
    },
  );

  it("reports a fake server import once, as fakeServer, not also as fakeName", async () => {
    const code = `import { FakeRequest } from "./contracts/generated/fake-server/index.ts";\nexport type X = FakeRequest;\n`;
    expect(await reported("server/index.ts", code)).toBe(1);
    expect(await fakeNames("server/index.ts", code)).toBe(0);
  });
});
