import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { LOCALE_IMPORT_ALLOWED } from "../../scripts/lint-rules/index.ts";

// S-1E-a (DAN-808; decision Ductus#1836 c.6906402529, N2): the one import by
// path out of server/ is `import { messagesHr } from "../../locales/index.ts"`
// in server/http/auth-flow.ts, for the text of the neutral login failure
// page. Any other file, other name, other form or other spelling of the path
// still fails both local/area-boundary and local/no-dynamic-load. Fixtures are
// linted under virtual paths with the repository's own config.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});

const FLOW = "server/http/auth-flow.ts";
const RULES = ["local/area-boundary", "local/no-dynamic-load"];

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? [])
    .map((m) => m.ruleId ?? "")
    .filter((id) => RULES.includes(id))
    .sort();
}

const use = "\nexport const n = String(m);\n";

describe("the locales import of the login page", () => {
  it("is one exact file, one exact specifier and one name", () => {
    expect(LOCALE_IMPORT_ALLOWED).toEqual({
      [FLOW]: { specifier: "../../locales/index.ts", name: "messagesHr" },
    });
    expect(Object.isFrozen(LOCALE_IMPORT_ALLOWED)).toBe(true);
  });

  it.each([
    'import { messagesHr } from "../../locales/index.ts";\nexport const m = messagesHr;\n',
    'import { messagesHr as t } from "../../locales/index.ts";\nexport const m = t;\n',
  ])("passes for the named messagesHr import in auth-flow.ts: %s", async (code) => {
    expect(await ruleIds(FLOW, code)).toEqual([]);
  });

  it.each([
    // Another file of server/, also next to it and in another area.
    ["server/http/auth.ts", 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    ["server/http/health.ts", 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    ["server/session/flow.ts", 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    // The same file with another name or more than the one name.
    [FLOW, 'import { messagesEn as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr, textOf as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import * as m from "../../locales/index.ts";' + use],
    [FLOW, 'import m from "../../locales/index.ts";' + use],
    [FLOW, 'import { "messagesHr" as m } from "../../locales/index.ts";' + use],
    // Another module of locales/.
    [FLOW, 'import { messagesHr as m } from "../../locales/hr.ts";' + use],
    // Another spelling of the same path.
    [FLOW, 'import { messagesHr as m } from "../../locales/./index.ts";' + use],
    [FLOW, 'import { messagesHr as m } from "../../../server/../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr as m } from "./../../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr as m } from "../../locales/index.ts?x";' + use],
    // Another form: re-export, dynamic import, require.
    [FLOW, 'export { messagesHr } from "../../locales/index.ts";\n'],
    [FLOW, 'export * from "../../locales/index.ts";\n'],
    [FLOW, 'const m = await import("../../locales/index.ts");' + use],
  ])("still fails in %s: %s", async (file, code) => {
    const found = await ruleIds(file, code);
    expect(found.length, found.join(",")).toBeGreaterThan(0);
    expect(found).toContain("local/area-boundary");
  });
});
