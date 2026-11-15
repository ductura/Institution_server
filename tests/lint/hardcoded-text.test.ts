import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import {
  encodesNonAscii,
  isExempt,
  localPlugin,
  repoPath,
  TEXT_EXEMPT,
  TEXT_TRANSITIONAL,
  textProblem,
} from "../../scripts/lint-rules/index.ts";

// S-1L.2 (DAN-780): server code writes no interface text. The rule reads only
// direct literals; text builders are part b
// (orchestrator decision Ductus#87 c.6896146643; contract Ductus#1836
// c.6896182732). Fixtures are linted under virtual paths with the repository
// config. Literal cases are carried over from ductura/server#51.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULE = "local/no-hardcoded-text";
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});
const AT = "server/domain/x.ts";

async function ids(code: string, file = AT): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  const fatal = (result?.messages ?? []).filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`parse error: ${fatal[0]?.message ?? ""}`);
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.messageId ?? "");
}

const passing: string[] = [
  // Keys, error codes, headers, wire values, SQL, URLs.
  'export const k = "auth.signIn";',
  'export const k = "gate.risk_invalid";',
  'export const c = { code: "NOT_FOUND", messageKey: "app.not_found" };',
  'export const h = { "content-type": "application/json; charset=utf-8" };',
  'export const s = ["radi", "ne_radi", "nije_ukljuceno"];',
  'export const s = "NIJE_PRONADENO";',
  'throw new Error("withActor: the transaction has ended");',
  "export const m = (k: string) => `server/${k}: missing index.ts`;",
  'export const q = "select u.id from users u where u.email = $1";',
  "export const q = \"SELECT CASE WHEN x THEN 'nije_konfigurirano' END\";",
  "export const u = (a: string, b: string) => `?prije=${a}&zapis=${b}`;",
  'export const u = "https://example.invalid/u/profile?q=a%20b";',
  'export const m = "Invalid character U+200B in token";',
  'export const l = "hr, en, da";',
  'export const d = "5f3c9a0e2b7d4c18";',
  // ASCII escapes, a backslash before u, a regex and a comment with letters.
  'export const t = "a\\tb\\u0041\\x41\\u{7e}";',
  "export const u = (n: number) => `\\\\u${n}`;",
  '// Prijava je obavezna, đ\nexport const r = /[\\u010d\\u0111]/u;\nexport const d = "d";',
  // String and Buffer used plainly.
  "export const s = (x: unknown) => String(x);",
  "export const s = (x: unknown) => new String(x);",
  "export const s = (xs: number[]) => xs.map(String);",
  "export const p = String.prototype.trim;",
  "export const b = Buffer.alloc(4);",
  "export const b = (x: Uint8Array) => Buffer.from(x).byteLength;",
  "export const b = (xs: Buffer[]) => Buffer.concat(xs);",
  "export const b = (x: Buffer): Buffer => x;",
  "export type B = typeof Buffer;",
  // A schema library's String is not the global.
  "const Type = { String: () => 1 };\nexport const t = Type.String();",
  "export const raw = (x: { raw: string }) => x.raw;",
  // Adversarial review of the contract (w780b): ordinary code that must pass.
  'export const m = "unescaped quote in header";',
  "export const q = \"name like '%admin%'\";",
  'export const q = "?page=1&ordering=desc&filtering=on";',
  'export const h = "a &amp; b &lt; c";',
  'export const d = (b: Uint8Array) => Buffer.from(b).toString("hex");',
  "export const r = (x: Uint8Array) => new Response(x);",
  'import { fileURLToPath } from "node:url";\nexport const f = fileURLToPath;',
  'import * as util from "node:util";\nexport const f = util.inspect;',
  "export const t = (a: string, b: string) => `${a}: ${b}`;",
  "export const r = /^[a-z]+$/u;",
];

const failing: [messageId: string, code: string][] = [
  // (1) Letters, sentences, names, JSX text.
  ["letter", 'export const e = { error: "Nije pronađeno." };'],
  ["letter", 'export const e = "Šifra";'],
  ["letter", 'export const e = "Ｐrijava";'],
  ["letter", 'export const e = "c\\u030C";'],
  ["letter", 'export const e = "prona\\u0111eno";'],
  ["letter", "export const e = `prona\\u{111}eno`;"],
  ["sentence", 'export const e = "Prijava je obavezna.";'],
  ["sentence", 'export const e = "PRIJAVA JE OBAVEZNA";'],
  ["sentence", 'export const e = "Prijava_je_obavezna";'],
  ["sentence", 'export const e = "prijava-je-obavezna";'],
  ["sentence", 'export const e = "Prijava\\u200Bje\\u200Bobavezna";'],
  ["sentence", 'export const e = "Prijava \\u24D9e obavezna.";'],
  ["sentence", 'export const e = "Dokument ne postoji.";'],
  ["sentence", 'export const e = "Unesite ime i lozinku.";'],
  ["sentence", 'export const e = { "Prijava je obavezna": 1 };'],
  ["sentence", 'type T = "Nemate pristup ovom dokumentu.";\nexport const t = "x" as T;'],
  ["sentence", "export const e = `Prijava je obavezna`;"],
  ["sentence", "export const e = (n: number) => `Rad ${n} je predan.`;"],
  ["sentence", "export const e = String.raw`Prijava je obavezna`;"],
  ["letter", "export const o = { nijePronađeno: 0 };"],
  ["letter", "export function pronađeno(): void {}"],
  ["letter", "export class K {\n  #pronađeno = 1;\n}"],
  // (1) Encoded forms written as text.
  ["encoded", "export const e = JSON.parse('\"prona\\\\u0111eno\"');"],
  ["encoded", 'export const e = new URL("http://x.invalid/?m=Prona%C4%91eno");'],
  ["encoded", 'export const e = "<p>Prona&#273;eno</p>";'],
  ["encoded", 'export const e = "<p>Prona&#x111;eno</p>";'],
  ["encoded", 'export const e = "<p>&scaron;ifra</p>";'],
  // Adversarial review of the contract (w780b): static forms it found.
  ["letter", "export const e = /čekaj/u.source;"],
  ["letter", "export const r = /[čćžšđ]/u;"],
  ["sentence", "export const e = /Molimo pokusajte ponovno/u.source;"],
  ["encoded", 'export const e = new URL("http://xn--ekaj-fua.hr/");'],
  ["sentence", "export const e = (x: string) => `Molimo ${x} pokusajte ${x} ponovno`;"],
  ["encoded", 'export const e = "&eth;";'],
  // Review FAIL on #64 (cxcrs64): a surrogate pair.
  ["encoded", "export const e = JSON.parse('\"\\\\uD801\\\\uDC00\"');"],
  // Review FAIL c.6896957758: tab and line ends inside a URL are dropped by the parser.
  // data: URLs are DAN-784 (Ductus#87 c.6897002897).
  ["encoded", 'export const e = new URL("http://xn-\\r-ekaj-fua.hr/");'],
  ["encoded", 'export const e = new URL("http://xn-\\t-ekaj-fua.hr/");'],
  // (3) Server code may not import a test or a fixture.
  ["exempt", 'import { CANARY } from "../log/invented.fixture.ts";\nexport const c = CANARY;'],
  ["exempt", 'export { x } from "./y.test.ts";'],
];

describe("local/no-hardcoded-text", () => {
  it.each(passing)("passes %s", async (code) => {
    expect(await ids(code)).toEqual([]);
  });

  it.each(failing)("reports %s in %s", async (messageId, code) => {
    expect(await ids(code)).toContain(messageId);
  });

  it("reports JSX text and a JSX attribute", async () => {
    const only = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.tsx"],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { local: localPlugin },
          rules: { [RULE]: "error" },
        },
      ],
    });
    const lint = async (code: string): Promise<string[]> => {
      const [r] = await only.lintText(code, { filePath: path.join(ROOT, "server/domain/x.tsx") });
      return (r?.messages ?? []).map((m) => m.messageId ?? m.message);
    };
    expect(await lint("export const v = <p>Prijava je obavezna.</p>;")).toEqual(["sentence"]);
    expect(await lint("export const v = <p>Šifra</p>;")).toEqual(["letter"]);
    expect(await lint('export const v = <p title="Nije pronađeno">x</p>;')).toEqual(["letter"]);
    expect(await lint("export const v = <p>{x}</p>;")).toEqual([]);
  });
});

describe("textProblem and encodesNonAscii", () => {
  it("tells a sentence without diacritics from a technical string", () => {
    expect(textProblem("Dokument ne postoji.")).toBe("sentence");
    expect(textProblem("Metoda nije podrzana")).toBe("sentence");
    expect(textProblem("Content-Type")).toBeNull();
    expect(textProblem("RISK_BELOW_FLOOR")).toBeNull();
    expect(textProblem("statusPage.states.notWorking")).toBeNull();
    expect(textProblem("je")).toBeNull();
  });

  it("finds a non-ASCII character spelled in an encoded form", () => {
    for (const t of ["\\u010d", "\\u{10d}", "\\xe9", "%C4%8D", "&#269;", "&#x10D;", "&ccaron;"])
      expect(encodesNonAscii(t), t).toBe(true);
    // Control characters and spaces spelled as escapes are not text (a schema pattern).
    for (const t of [
      "\\u0041",
      "%20",
      "&#65;",
      "&amp;",
      "a%2Fb",
      "\\\\u",
      "100%",
      "\\u009f",
      "&#160;",
    ])
      expect(encodesNonAscii(t), t).toBe(false);
  });
});

describe("paths", () => {
  it("are the same on Windows and on posix", () => {
    expect(repoPath("/repo", "/repo/server/log/leak.ts")).toBe("server/log/leak.ts");
    expect(repoPath("C:\\repo", "C:\\repo\\server\\log\\leak.ts")).toBe("server/log/leak.ts");
    expect(repoPath("c:\\Repo", "C:\\repo\\server\\log\\leak.ts")).toBe("server/log/leak.ts");
  });

  it("exempt only tests and the listed fixtures, which exist", () => {
    expect(TEXT_EXEMPT[0]).toBe("server/**/*.test.ts");
    for (const fixture of TEXT_EXEMPT.slice(1)) {
      expect(fixture).toMatch(/\.fixture\.ts$/u);
      expect(existsSync(path.join(ROOT, fixture)), fixture).toBe(true);
    }
    expect(isExempt("server/app.test.ts")).toBe(true);
    expect(isExempt("server/log/invented.fixture.ts")).toBe(true);
    for (const f of [
      "server/app.spec.ts",
      "server/app.test.ts.ts",
      "server/test.ts",
      "server/test-server/index.ts",
      "server/log/other.fixture.ts",
      "test-support/app.test.ts",
    ])
      expect(isExempt(f), f).toBe(false);
  });

  it("lint-ignored folders hold no tracked file under server/", () => {
    const tracked = execFileSync("git", ["ls-files", "server"], { cwd: ROOT, encoding: "utf8" });
    expect(
      tracked.split("\n").filter((f) => /(?:^|\/)(?:dist|coverage|node_modules)\//u.test(f)),
    ).toEqual([]);
  });
});

describe("repository config", () => {
  async function ruleOn(file: string): Promise<boolean> {
    const config = (await eslint.calculateConfigForFile(path.join(ROOT, file))) as {
      rules?: Record<string, unknown>;
    };
    const entry = config.rules?.[RULE];
    return Array.isArray(entry) ? entry[0] === 2 : entry === 2;
  }

  it("reads every server file but tests, fixtures and the transitional server", async () => {
    for (const f of ["server/access.ts", "server/app.spec.ts", "server/test-server/index.ts"])
      expect(await ruleOn(f), f).toBe(true);
    for (const f of ["server/app.test.ts", "server/log/invented.fixture.ts", "server/app.ts"])
      expect(await ruleOn(f), f).toBe(false);
  });

  it("keeps the transitional list closed and still needed", async () => {
    expect(TEXT_TRANSITIONAL).toEqual(["server/app.ts"]);
    const only = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { local: localPlugin },
          rules: { [RULE]: "error" },
        },
      ],
    });
    const [result] = await only.lintFiles([path.join(ROOT, "server/app.ts")]);
    expect(result?.messages.length ?? 0).toBeGreaterThan(0);
  });
});
