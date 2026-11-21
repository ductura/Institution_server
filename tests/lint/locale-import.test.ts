import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { LOCALE_IMPORT_ALLOWED } from "../../scripts/lint-rules/index.ts";

// The login failure page (DAN-808), receipt PDF (SRV-9C) and Merlin roster (SRV-1109) each have a
// named import of their catalogue. Any other file, name, form or spelling
// still fails both local/area-boundary and local/no-dynamic-load. Fixtures are
// linted under virtual paths with the repository's own config.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});

const FLOW = "server/http/auth-flow.ts";
const RECEIPT = "server/http/receipt-pdf.ts";
const MERLIN = "server/http/merlin-roster/index.ts";
const WORK_EXPORT = "server/http/work-export/index.ts";
const PORTABLE_RECORD = "server/http/portable-record/index.ts";
const RULES = ["local/area-boundary", "local/no-dynamic-load"];

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? [])
    .map((m) => m.ruleId ?? "")
    .filter((id) => RULES.includes(id))
    .sort();
}

const use = "\nexport const n = String(m);\n";

describe("the locales imports of the login page and receipt PDF", () => {
  it("is an exact file, specifier and name for each allowed import", () => {
    expect(LOCALE_IMPORT_ALLOWED).toEqual({
      [FLOW]: { specifier: "../../locales/index.ts", name: "messagesHr" },
      [RECEIPT]: { specifier: "../../locales/index.ts", name: "receiptPdfHr" },
      [MERLIN]: { specifier: "../../../locales/index.ts", name: "merlinHr" },
      [WORK_EXPORT]: { specifier: "../../../locales/index.ts", name: "merlinHr" },
      [PORTABLE_RECORD]: { specifier: "../../../locales/index.ts", name: "receiptPdfHr" },
    });
    expect(Object.isFrozen(LOCALE_IMPORT_ALLOWED)).toBe(true);
  });

  it("allows the Croatian PDF labels in the receipt adapter", async () => {
    const code = 'import { receiptPdfHr as m } from "../../locales/index.ts";' + use;
    expect(await ruleIds(RECEIPT, code)).toEqual([]);
  });

  it("allows the receipt PDF labels in the portable record adapter, and nothing else there", async () => {
    const code = 'import { receiptPdfHr as m } from "../../../locales/index.ts";' + use;
    expect(await ruleIds(PORTABLE_RECORD, code)).toEqual([]);
    const other = 'import { messagesHr as m } from "../../../locales/index.ts";' + use;
    expect(await ruleIds(PORTABLE_RECORD, other)).not.toEqual([]);
  });

  it("allows the Croatian roster labels in the Merlin roster adapter", async () => {
    const code = 'import { merlinHr as m } from "../../../locales/index.ts";' + use;
    expect(await ruleIds(MERLIN, code)).toEqual([]);
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
    [FLOW, 'import { receiptPdfHr as m } from "../../locales/index.ts";' + use],
    [RECEIPT, 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    [MERLIN, 'import { messagesHr as m } from "../../../locales/index.ts";' + use],
    [MERLIN, 'import { merlinHr as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr, textOf as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import * as m from "../../locales/index.ts";' + use],
    [FLOW, 'import m from "../../locales/index.ts";' + use],
    [FLOW, 'import { "messagesHr" as m } from "../../locales/index.ts";' + use],
    // Type-only, an inline type, or a default next to the name (samonapad, #104).
    [FLOW, 'import type { messagesHr as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import { type messagesHr as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr as m, default as d } from "../../locales/index.ts";' + use],
    [FLOW, 'import d, { messagesHr as m } from "../../locales/index.ts";' + use],
    // Letter case of the file or the folder, and Windows separators.
    ["server/http/Auth-Flow.ts", 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    ["server/HTTP/auth-flow.ts", 'import { messagesHr as m } from "../../locales/index.ts";' + use],
    [FLOW, 'import { messagesHr as m } from "../../Locales/index.ts";' + use],
    [FLOW, 'import { messagesHr as m } from "..\\\\..\\\\locales\\\\index.ts";' + use],
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
