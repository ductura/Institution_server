import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// S-1A-b (DAN-769): the five rules of docs/PLAN.md §3 "Pravilo granica" and
// the import table of docs/server-map.md §2. Every rule has fixtures that must
// fail; they are linted under virtual paths with the repository's own config,
// as in tests/lint/rules.test.ts. The table itself (equal to the map, acyclic)
// is checked in server/server-map.test.ts.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});

const RULE = "local/area-boundary";
type Case = { file: string; code: string; messageId: string };

async function ids(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? ""}:${m.messageId ?? ""}`);
}

const imp = (spec: string): string => `import { x } from "${spec}";\n`;
const all = (file: string, messageId: string, specs: string[]): Case[] =>
  specs.map((spec) => ({ file, code: imp(spec), messageId }));
// The same specifier in every form that loads or re-exports a module.
const forms = (spec: string): string[] => [
  imp(spec),
  `import type { X } from "${spec}";\n`,
  `export { x } from "${spec}";\n`,
  `export * from "${spec}";\n`,
  `export const m = await import("${spec}");\n`,
  `export const m = require("${spec}");\n`,
  `import m = require("${spec}");\n`,
  `import { createRequire } from "node:module";\nexport const m = createRequire(import.meta.url)("${spec}");\n`,
];

const DB = "server/database/x.ts";
const failing: Case[] = [
  // Rule 1: another area only through its own index.ts, in every form.
  ...["../domain/forensics/index.ts", "../domain/forensics/jcs.ts", "../log/redact.ts"].flatMap(
    (spec) => forms(spec).map((code) => ({ file: DB, code, messageId: "public" })),
  ),
  ...all(DB, "public", [
    "../log/../domain/forensics/index.ts",
    "./../domain/json/index.ts",
    "../Domain/index.ts",
    "../domain/INDEX.ts",
    "..\\\\domain\\\\forensics\\\\index.ts",
    "../domain/forensics/index.ts?x",
    "../domain/%66orensics/index.ts",
  ]),
  { file: DB, code: 'type M = typeof import("../log/redact.ts");\n', messageId: "public" },
  // Rule 2: domain imports nothing (node:crypto is the S-0.19 exception);
  // contracts only the schema library. Type-only does not help.
  ...all("server/domain/x.ts", "pure", ["node:fs", "fs", "zod", "../../scripts/index.ts"]),
  ...all("server/domain/forensics/golden-vectors/other.ts", "pure", ["node:fs"]),
  ...all("server/contracts/x.ts", "pure", [
    "node:http",
    "@sinclair/typebox-other",
    "../../test-support/x/index.ts",
  ]),
  { file: "server/contracts/x.ts", code: 'import("node:fs");\n', messageId: "pure" },
  ...forms("../log/index.ts").map((code) => ({
    file: "server/domain/x.ts",
    code,
    messageId: "edge",
  })),
  ...all("server/contracts/schema/x.ts", "edge", ["../../domain/index.ts"]),
  // Rule 3: routes.ts imports only contracts, http as a type and ./service.ts.
  ...all("server/roles/routes.ts", "routes", [
    "../database/index.ts",
    "../http/index.ts",
    "./other.ts",
    "./sub/service.ts",
    "../roles/service.ts?x=../roles/service.ts",
    "@sinclair/typebox",
    "node:fs",
  ]),
  {
    file: "server/roles/routes.ts",
    code: 'export * from "../http/index.ts";\n',
    messageId: "routes",
  },
  // Rule 4: PGlite only where the database lives; nobody imports React, Next.js or .tsx.
  ...[
    "@electric-sql/pglite",
    "@electric-sql/pglite/worker",
    "@ELECTRIC-SQL/PGLITE",
    "../../node_modules/@electric-sql/pglite/dist/index.js",
    "../../node_modules/.pnpm/@electric-sql+pglite@0.3.14/node_modules/x.js",
  ].flatMap((spec) =>
    ["server/session/x.ts", "test-support/x.ts", "packages/test-fakes/clock/x.ts"].flatMap((file) =>
      forms(spec).map((code) => ({ file, code, messageId: "pglite" })),
    ),
  ),
  ...[
    "react",
    "react-dom/client",
    "next",
    "next/server",
    "./c.tsx",
    "pkg/c.jsx?x",
    "./c.TSX",
  ].flatMap((spec) =>
    ["scripts/x.ts", "server/http/x.ts", "server/database/x.ts"].flatMap((file) =>
      forms(spec).map((code) => ({ file, code, messageId: "ui" })),
    ),
  ),
  // Rule 5 and the table: an edge outside the table (log -> database would
  // close a cycle with database -> log), the composer, the test server,
  // feature to feature, adapter to adapter.
  ...all("server/log/x.ts", "edge", ["../database/index.ts"]),
  ...all("server/settings/x.ts", "edge", ["../log/index.ts"]),
  ...all("server/session/x.ts", "edge", ["../http/index.ts", "../test-server/index.ts"]),
  ...all("server/http/x.ts", "edge", ["../test-server/index.ts", "../domain/index.ts"]),
  ...all("server/roles/x.ts", "edge", ["../legal/index.ts", "../index.ts", "../app.ts"]),
  ...all("server/external/keys/x.ts", "edge", ["../storage/index.ts", "../../roles/index.ts"]),
  ...all("server/database/x.ts", "edge", ["../stray/index.ts", "../external/index.ts"]),
  ...all("server/x.ts", "edge", ["./database/index.ts"]),
  // Only http and the entry point create adapters; the others take their types.
  ...[
    imp("../database/index.ts"),
    'import { type WithActor, withActor } from "../database/index.ts";\n',
    'import { type WithActor } from "../database/index.ts";\n',
    'export { withActor } from "../database/index.ts";\n',
    'export * from "../external/srce-auth/index.ts";\n',
    'export const m = await import("../database/index.ts");\n',
    'import m = require("../database/index.ts");\n',
  ].map((code) => ({ file: "server/session/x.ts", code, messageId: "typeOnly" })),
  // Package self-reference or subpath imports cannot stand in for a path.
  ...all("server/session/x.ts", "alias", [
    "@ductura/server",
    "@ductura/server/server/domain/forensics/jcs.ts",
    "#domain",
  ]),
];

// Bypasses found by the adversarial run on the first head of this PR; each
// loads the forbidden module at run time.
const REPO = path.basename(ROOT);
const bypasses: Case[] = [
  // leaving the repository and coming back in
  ...all("server/log/x.ts", "edge", [`../../../${REPO}/server/database/index.ts`]),
  // URL parsing drops tab, CR and LF inside a relative specifier
  ...all("server/log/x.ts", "edge", ["./\t../database/index.ts", "./.\\n./database/index.ts"]),
  { file: "server/domain/x.ts", code: 'import("./\t../log/index.ts");\n', messageId: "edge" },
  ...all("server/session/x.ts", "typeOnly", ["./\\r../database/index.ts"]),
  // loaders the name matching cannot follow, and builtins without an import
  ...["server/log/x.ts", "server/session/x.ts", "server/x.ts"].flatMap((file) =>
    all(file, "loader", ["node:module", "module"]),
  ),
  {
    file: "server/log/x.ts",
    code: 'const { createRequire: cr } = await import("node:module");\n',
    messageId: "loader",
  },
  ...[
    'export const fs = process.getBuiltinModule("node:fs");\n',
    'export const fs = process["getBuiltinModule"]("node:fs");\n',
    'export const fs = globalThis.process.getBuiltinModule("node:fs");\n',
    "export const m = process.mainModule;\n",
  ].map((code) => ({ file: "server/domain/x.ts", code, messageId: "loader" })),
  // laundering through a folder outside server/
  ...all("server/log/x.ts", "outside", ["../../scripts/hop/index.ts", "../../db/x/index.ts"]),
  { file: "server/x.ts", code: imp("../scripts/index.ts"), messageId: "outside" },
  // URL schemes
  ...all("server/log/x.ts", "scheme", [
    "data:text/javascript,export * from 'file:///app/server/database/index.ts'",
    "https://example.invalid/x.ts",
  ]),
  // a routes.ts directly in server/ is still a routes file
  ...all("server/routes.ts", "routes", ["./http/index.ts", "fast-check"]),
];

const passing: { file: string; code: string }[] = [
  { file: DB, code: imp("../domain/index.ts") + imp("./with-actor.ts") + imp("pg") },
  { file: "server/domain/x.ts", code: imp("node:crypto") + imp("./forensics/index.ts") },
  { file: "server/domain/forensics/golden-vectors/load.ts", code: imp("node:fs") },
  { file: "server/domain/x.test.ts", code: imp("vitest") + imp("node:fs") },
  {
    file: "server/contracts/x.ts",
    code: imp("@sinclair/typebox") + imp("@sinclair/typebox/value"),
  },
  { file: "server/contracts/generated/fake-server/index.ts", code: imp("node:http") },
  {
    file: "server/roles/routes.ts",
    code: [
      'import type { Route } from "../http/index.ts";',
      'import { schemas } from "../contracts/index.ts";',
      'import { list } from "./service.ts";',
      "export const routes = [{ schemas, list }] satisfies Route[];",
      "",
    ].join("\n"),
  },
  {
    file: "server/session/x.ts",
    code: [
      'import type { WithActor } from "../database/index.ts";',
      'export type { BackchannelLogout } from "../database/index.ts";',
      'export type * from "../external/srce-auth/index.ts";',
      'type M = typeof import("../database/index.ts");',
      'import { a } from "../domain/index.ts";',
      "",
    ].join("\n"),
  },
  { file: "server/session/x.test.ts", code: imp("../database/index.ts") },
  { file: "server/contracts/x.test.ts", code: imp("../../scripts/index.ts") + imp("node:module") },
  { file: "server/log/x.ts", code: "export const env = process.env;\n" },
  {
    file: "server/http/x.ts",
    code: imp("../database/index.ts") + imp("../external/keys/index.ts"),
  },
  { file: "server/index.ts", code: imp("./app.ts") + imp("./http/index.ts") },
  { file: "server/test-server/x.ts", code: imp("../http/index.ts") },
  ...[
    "server/database/x.ts",
    "tests/db/x.integration.test.ts",
    "packages/test-fakes/pglite/x.ts",
  ].map((file) => ({ file, code: imp("@electric-sql/pglite") })),
  { file: "scripts/x.ts", code: imp("../server/contracts/index.ts") + imp("nextjs-like") },
];

describe("area boundaries (PLAN §3, docs/server-map.md §2)", () => {
  it.each(failing)("fails: $file · $code", async ({ file, code, messageId }) => {
    expect(await ids(file, code)).toContain(`${RULE}:${messageId}`);
  });

  it.each(bypasses)("closes bypass: $file · $code", async ({ file, code, messageId }) => {
    expect(await ids(file, code)).toContain(`${RULE}:${messageId}`);
  });

  it.each(passing)("passes: $file · $code", async ({ file, code }) => {
    expect((await ids(file, code)).filter((id) => id.startsWith(`${RULE}:`))).toEqual([]);
  });

  it("routes.ts holds no logic", async () => {
    for (const body of [
      "if (a) b();",
      "switch (a) {}",
      "for (;;) {}",
      "for (const k in a) {}",
      "for (const k of a) {}",
      "while (a) {}",
      "do {} while (a);",
      "try {} catch {}",
      "export const v = a ? 1 : 2;",
      "export const v = await a;",
      "export const v = a && 1;",
      "export const v = a ?? 1;",
      "export const v = a?.b;",
      "throw a;",
    ]) {
      expect(await ids("server/roles/routes.ts", `declare const a: never;\n${body}\n`)).toContain(
        "no-restricted-syntax:restrictedSyntax",
      );
    }
    expect(await ids("server/roles/routes.ts", "export enum E { A }\n")).toContain(
      "no-restricted-syntax:restrictedSyntax",
    );
  });

  it("a computed dynamic import is reported, so no boundary is skipped", async () => {
    const code = 'const p = "../log/redact.ts";\nexport const m = await import(p);\n';
    expect(await ids(DB, code)).toContain("local/import-boundary:dynamic");
  });
});
