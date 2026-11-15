import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, RuleTester, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import {
  isExempt,
  repoPath,
  localPlugin,
  TEXT_EXEMPT,
  TEXT_TRANSITIONAL,
  textProblem,
} from "../../scripts/lint-rules/index.ts";

// S-1L.2 (DAN-780): server code writes no interface text; the text is in
// locales/. Fixtures are linted with RuleTester under virtual paths, and the
// repository config is checked for which files the rule reads.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULE = "local/no-hardcoded-text";
const rule = localPlugin.rules?.["no-hardcoded-text"];
if (!rule || typeof rule === "function") throw new Error("rule not registered");

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, sourceType: "module", ecmaVersion: "latest" },
});

const file = path.join(ROOT, "server/domain/x.ts");
const ok = (code: string) => ({ code, filename: file });
const bad = (code: string, messageId: "letter" | "sentence" | "exempt") => ({
  code,
  filename: file,
  errors: [{ messageId }],
});

tester.run("no-hardcoded-text", rule, {
  valid: [
    // Allowed technical strings: a key, an error code, a header name, a wire value.
    ok('export const k = "auth.signIn";'),
    ok('export const k = "gate.risk_invalid";'),
    ok('export const c = { code: "NOT_FOUND", messageKey: "app.not_found" };'),
    ok('export const h = { "content-type": "application/json; charset=utf-8" };'),
    ok('export const h = "x-request-id";'),
    ok('export const s = ["radi", "ne_radi", "nije_ukljuceno"];'),
    ok('export const s = "NIJE_PRONADENO";'),
    // English developer messages of programming errors (CODE_STYLE §8).
    ok('throw new Error("withActor: the transaction has ended");'),
    ok("export const m = (k: string) => `server/${k}: missing index.ts`;"),
    ok('export const q = "select id from documents where owner_id = $1";'),
    // A non-ASCII letter only in a regex or a comment.
    ok('// Prijava je obavezna, đ\nexport const r = /[čćžšđ]/u;\nexport const d = "d";'),
    ok('export const u = "\\\\u" + String(1);'),
    ok('export const b = Buffer.from("MCowBQYDK2VwAyEA", "base64");'),
    ok('export const t = `${"auth"}.${"signIn"}`;'),
    ok('export const s = ["a", "b"].join("");'),
    // Machine tokens inside a longer text: a wire value in SQL, a query key.
    ok("export const q = \"SELECT CASE WHEN x THEN 'nije_konfigurirano' END\";"),
    ok("export const u = (a: string, b: string) => `?prije=${a}&zapis=${b}`;"),
    // Short words that are also English or technical tokens (adversarial review).
    ok('export const q = "select u.id from users u where u.email = $1";'),
    ok('export const u = "https://example.invalid/u/profile";'),
    ok('export const m = "Invalid character U+200B in token";'),
    ok('export const h = "TE: trailers";'),
    ok('export const l = "hr, en, da";'),
    ok('export const m = "unsupported operator ne";'),
    ok('export const m = "KMS SA key missing";'),
    ok('export const m = "su postgres -c psql";'),
    ok('export const m = "user bio field";'),
    ok('export const r = new RegExp("[a-z]+ u", "g");'),
    ok('export const x = "de ad be ef ce da";'),
    ok('export const f = ["g", "u"].join("");'),
    ok('export const f = ["SELECT", "u.id", "FROM", "users", "u"].join(" ");'),
    ok('export const k = "statusPage.states.ne_radi";'),
    ok('export const d = "5f3c9a0e2b7d4c18";'),
  ],
  invalid: [
    // Croatian letters, including escapes and the decomposed form.
    bad('export const e = { error: "Nije pronađeno." };', "letter"),
    bad('export const e = "Nije prona\\u0111eno";', "letter"),
    bad('export const e = "Nije prona\\u{111}eno";', "letter"),
    bad('export const e = "c\\u030C";', "letter"),
    bad('export const e = "Šifra";', "letter"),
    // Homoglyph and full-width letters.
    bad('export const e = "Prijava \\u0458e obavezna";', "letter"),
    bad('export const e = "Ｐrijava";', "letter"),
    // A sentence without diacritics, also hidden by separators and invisible characters.
    bad('export const e = "Prijava je obavezna.";', "sentence"),
    bad('export const e = "PRIJAVA JE OBAVEZNA";', "sentence"),
    bad('export const e = "Prijava_je_obavezna";', "sentence"),
    bad('export const e = "Prijava-je-obavezna";', "sentence"),
    bad('export const e = "Prijava\\u200Bje\\u200Bobavezna";', "sentence"),
    bad('export const e = "Prijava\\tje\\u00a0obavezna";', "sentence"),
    bad('type T = "Nemate pristup ovom dokumentu.";\nexport const t: T = "x" as T;', "sentence"),
    bad('export const e = { "Prijava je obavezna": 1 };', "sentence"),
    // Templates, String.raw and concatenation: reported once, on the outer node.
    bad("export const e = (n: number) => `Rad ${n} je predan.`;", "sentence"),
    bad('export const e = `${"Prijava"} je obavezna`;', "sentence"),
    bad("export const e = String.raw`Prijava je obavezna`;", "sentence"),
    bad("export const e = String.raw`Nije prona\\u0111eno`;", "letter"),
    bad('export const e = "Prijava " + "je " + "obavezna.";', "sentence"),
    bad('export const e = (x: string) => "Prijava " + x + " je obavezna.";', "sentence"),
    bad('export const e = "Nije prona" + "\\u0111" + "eno";', "letter"),
    // Arrays of characters or words, char codes.
    bad('export const e = ["P","r","i","j","a","v","a"," ","j","e"," ","o"].join("");', "sentence"),
    bad('export const e = ["Prijava", "je", "obavezna"].join(" ");', "sentence"),
    bad("export const e = String.fromCharCode(0x111);", "letter"),
    bad('export const e = String["fromCodePoint"](106, 101, 32, 110, 101);', "sentence"),
    // Percent- and base64-encoded text.
    bad('export const e = decodeURIComponent("Prona%C4%91eno dokument");', "letter"),
    bad('export const e = atob("UHJpamF2YSBqZSBvYmF2ZXpuYS4=");', "sentence"),
    // A constant from an exempt file cannot be imported by server code.
    bad('import { CANARY } from "../log/invented.fixture.ts";\nexport const c = CANARY;', "exempt"),
    bad('export { x } from "./y.test.ts";', "exempt"),
    bad('export const m = import("./y.test.ts");', "exempt"),
    // Adversarial review: invisible and control characters, enclosed letters.
    bad('export const e = "Prijava j\\u200Be obavezna.";', "sentence"),
    bad('export const e = "N\\u00ADije prona\\u00ADdeno.";', "sentence"),
    bad('export const e = "Prijava j\\u0001e obavezna.";', "sentence"),
    bad('export const e = "Prijava \\u24D9e obavezna.";', "sentence"),
    // Machine-token shapes and stripped keys.
    bad('export const e = "prijava-je-obavezna";', "sentence"),
    bad('export const e = "prijava_je_obavezna";', "sentence"),
    bad('export const e = "Prijava je= obavezna.";', "sentence"),
    bad('export const e = "Prijava je_obavezna.";', "sentence"),
    bad('export const e = "Dokument ne postoji.";', "sentence"),
    bad('export const e = "DOKUMENT NE POSTOJI";', "sentence"),
    bad('export const e = "Odjavite se.";', "sentence"),
    bad('export const e = "Unesite ime i lozinku.";', "sentence"),
    // Wrappers and calls the rule folds.
    bad('export const e = "Prijava".concat(" je", " obavezna.");', "sentence"),
    bad(
      'export const e = (b: boolean) => "Prijava " + (b ? "je" : "nije") + " obavezna.";',
      "sentence",
    ),
    bad('export const e = (n?: string) => "Prijava " + (n ?? "je") + " obavezna.";', "sentence"),
    bad('export const e = (n: string) => "Prijava " + (n || "je") + " obavezna.";', "sentence"),
    bad(
      'export const e = ("Prijava" as string) + (" je" satisfies string) + " obavezna.";',
      "sentence",
    ),
    bad('export const e = "Prijava " + String("je") + " obavezna.";', "sentence"),
    bad('export const e = "Prijava " + (0, "je") + " obavezna.";', "sentence"),
    bad(
      'const id = (s: TemplateStringsArray) => s[0];\nexport const e = "Prijava " + id`je` + " obavezna.";',
      "sentence",
    ),
    bad('export const e = ["Prijava", "obavezna."].join(" je ");', "sentence"),
    bad('export const e = [...["Prijava"], ...["je"], ...["obavezna."]].join(" ");', "sentence"),
    bad('const j = "je";\nexport const e = `Prijava ${j} obavezna.`;', "sentence"),
    bad(
      'const a = "Prijava";\nconst b = "je";\nexport const e = a + " " + b + " obavezna.";',
      "sentence",
    ),
    bad('export const e = "Prijava je obavezna.".trim().toUpperCase();', "sentence"),
    // Codex review on #51: every alternative of an array element is joined.
    bad(
      'export const e = (on: boolean) => ["Prijava", on ? "x" : "je", "obavezna."].join(" ");',
      "sentence",
    ),
    bad('export const e = (on: boolean) => ["Prijava", on ? "x" : "je", "obavezna."];', "sentence"),
    bad(
      'export const e = (on: boolean) => ["Prijava ", on ? "" : "je", " obavezna."].join("");',
      "sentence",
    ),
    // Review FAIL c.6894940324: `.join` on a const array, a regex source in a concatenation.
    bad(
      'const WORDS = ["Prijava", "obavezna."];\nexport const message = WORDS.join(" je ");',
      "sentence",
    ),
    bad('export const message = "Prijava " + /je/.source + " obavezna.";', "sentence"),
    bad("export const message = `Prijava ${/je/.source} obavezna.`;", "sentence"),
    // Review FAIL c.6895754450: short encoded text, a const array of codes.
    bad('export const e = Buffer.from("xIxhag==", "base64").toString("utf8");', "letter"),
    bad('export const e = atob("xIxhag==");', "letter"),
    bad("const CODES = [273];\nexport const MESSAGE = String.fromCharCode(...CODES);", "letter"),
    bad(
      "const CODES = [273];\nexport const MESSAGE = String.fromCharCode.apply(null, CODES);",
      "letter",
    ),
    bad("const D = 273;\nexport const MESSAGE = String.fromCharCode(D);", "letter"),
    // Ruling c.6895834779: short base64 and hex literals are decoded like long ones.
    bad('export const e = "xIxhag==";', "letter"),
    bad('export const e = "c48d";', "letter"),
    bad('export const e = Buffer.from("c48d", "hex").toString();', "letter"),
    // Names and regex sources.
    bad("export const o = { nijePronađeno: 0 };", "letter"),
    bad("export function pronađeno(): void {}", "letter"),
    bad("export const e = /Prijava je obavezna\\./.source;", "sentence"),
    bad("export const e = /Nije pronađeno/u.source;", "letter"),
    // Char codes through apply, spread, unary plus and numeric strings.
    bad("export const e = String.fromCharCode.apply(null, [106, 101, 32, 110, 101]);", "sentence"),
    bad("export const e = String.fromCharCode(...[106, 101, 32, 110, 101]);", "sentence"),
    bad("export const e = String.fromCharCode(+106, +101, +32, +110, +101);", "sentence"),
    bad('export const e = String.fromCharCode("106", "101", "32", "110", "101");', "sentence"),
    // Hex, base64 with a line end, percent text with a broken tail.
    bad(
      'export const e = Buffer.from("5072696a617661206a65206f626176657a6e612e", "hex");',
      "sentence",
    ),
    bad('export const e = atob("UHJpamF2YSBqZSBvYmF2ZXpuYS4K");', "sentence"),
    bad('export const e = decodeURIComponent("%50rijava%20je%20obavezna%");', "sentence"),
  ],
});

describe("exempt import on a Windows checkout (review FAIL c.6895202719)", () => {
  it("reports the fixture import when cwd and file name use backslashes", () => {
    const reports: string[] = [];
    const context = {
      cwd: "C:\\repo",
      filename: "C:\\repo\\server\\log\\leak.ts",
      report: (r: { messageId?: string }) => reports.push(r.messageId ?? ""),
      sourceCode: { getScope: () => null },
    } as unknown as Rule.RuleContext;
    const visitors = rule.create(context) as Record<string, (node: unknown) => void>;
    visitors.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      source: { type: "Literal", value: "./invented.fixture.ts" },
    });
    expect(reports).toEqual(["exempt"]);
  });
});

describe("folding cost", () => {
  it("folds a chain of shared constants in linear time (Codex review on #51)", async () => {
    const lines = ["const n0 = 1;"];
    for (let i = 1; i <= 40; i++) lines.push(`const n${i} = n${i - 1} + n${i - 1};`);
    lines.push("export const last = n40;");
    const eslint = new ESLint({
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
    const started = performance.now();
    const [result] = await eslint.lintText(lines.join("\n"), { filePath: file });
    expect(result?.messages).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  }, 20000);
});

describe("folded text length (review FAIL c.6895754450)", () => {
  it("cuts a doubling chain of strings instead of building 2^40 characters", async () => {
    const lines = ['const a0 = "x";'];
    for (let i = 1; i <= 40; i++) lines.push(`const a${i} = a${i - 1} + a${i - 1};`);
    lines.push("export function unused(): string {\n  return a40;\n}");
    const eslint = new ESLint({
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
    const started = performance.now();
    const [result] = await eslint.lintText(lines.join("\n"), { filePath: file });
    expect(result?.messages).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  }, 20000);
});

describe("textProblem", () => {
  it("tells a sentence without diacritics from a technical string", () => {
    expect(textProblem("Dokument ne postoji.")).toBe("sentence");
    expect(textProblem("Metoda nije podrzana")).toBe("sentence");
    expect(textProblem("Content-Type")).toBeNull();
    expect(textProblem("RISK_BELOW_FLOOR")).toBeNull();
    expect(textProblem("statusPage.states.notWorking")).toBeNull();
    expect(textProblem("je")).toBeNull();
  });
});

describe("lint-ignored folders", () => {
  it("hold no tracked file under server/ (dist/, coverage/ and node_modules/ are not linted)", () => {
    const tracked = execFileSync("git", ["ls-files", "server"], { cwd: ROOT, encoding: "utf8" });
    const hidden = tracked
      .split("\n")
      .filter((f) => /(?:^|\/)(?:dist|coverage|node_modules)\//u.test(f));
    expect(hidden).toEqual([]);
  });
});

describe("repository path of a linted file (review FAIL c.6895202719)", () => {
  it("is the same on Windows and on posix", () => {
    expect(repoPath("/repo", "/repo/server/log/leak.ts")).toBe("server/log/leak.ts");
    expect(repoPath("C:\\repo", "C:\\repo\\server\\log\\leak.ts")).toBe("server/log/leak.ts");
    expect(repoPath("c:\\Repo", "C:\\repo\\server\\log\\leak.ts")).toBe("server/log/leak.ts");
    expect(repoPath("C:\\repo", "C:/repo/server/log/leak.ts")).toBe("server/log/leak.ts");
  });
});

describe("exempt paths", () => {
  it("are only tests and fixtures, each listed fixture exists", () => {
    for (const pattern of TEXT_EXEMPT) {
      if (pattern === "server/**/*.test.ts") continue;
      expect(pattern).toMatch(/\.fixture\.ts$/u);
      expect(existsSync(path.join(ROOT, pattern)), pattern).toBe(true);
    }
  });

  it("match exactly, not a file that only looks like a test", () => {
    expect(isExempt("server/app.test.ts")).toBe(true);
    expect(isExempt("server/log/invented.fixture.ts")).toBe(true);
    for (const f of [
      "server/app.spec.ts",
      "server/app.test.ts.ts",
      "server/app.tests.ts",
      "server/test.ts",
      "server/tests/app.ts",
      "server/test-server/index.ts",
      "server/log/other.fixture.ts",
      "server/log/invented.fixture.ts.ts",
      "test-support/app.test.ts",
    ])
      expect(isExempt(f), f).toBe(false);
  });
});

describe("repository config", () => {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
    flags: ["unstable_native_nodejs_ts_config"],
  });
  async function ruleOn(filePath: string): Promise<boolean> {
    const config = (await eslint.calculateConfigForFile(path.join(ROOT, filePath))) as {
      rules?: Record<string, unknown>;
    };
    const entry = config.rules?.[RULE];
    return Array.isArray(entry) ? entry[0] === 2 : entry === 2;
  }
  async function hits(filePath: string, code: string): Promise<number> {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
    return (result?.messages ?? []).filter((m) => m.ruleId === RULE).length;
  }

  it("fails a sentence written in a server file", async () => {
    expect(await hits("server/domain/x.ts", 'export const e = "Prijava je obavezna.";\n')).toBe(1);
    expect(await hits("server/app-routes.ts", 'export const e = "Nije pronađeno.";\n')).toBe(1);
  });

  it("transitional files still write text, so a stale entry fails", async () => {
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
    expect(TEXT_TRANSITIONAL).toEqual(["server/app.ts"]);
    for (const f of TEXT_TRANSITIONAL) {
      expect(existsSync(path.join(ROOT, f)), f).toBe(true);
      const [result] = await only.lintFiles([path.join(ROOT, f)]);
      expect(result?.messages.length ?? 0, f).toBeGreaterThan(0);
      expect(await ruleOn(f), f).toBe(false);
    }
  });

  it("reads every server file but the exempt ones", async () => {
    expect(await ruleOn("server/access.ts")).toBe(true);
    expect(await ruleOn("server/app.spec.ts")).toBe(true);
    expect(await ruleOn("server/app.tests.ts")).toBe(true);
    expect(await ruleOn("server/test-server/index.ts")).toBe(true);
    expect(await ruleOn("server/log/other.fixture.ts")).toBe(true);
    expect(await ruleOn("server/app.test.ts")).toBe(false);
    expect(await ruleOn("server/log/invented.fixture.ts")).toBe(false);
  });
});
