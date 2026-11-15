import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import {
  BUILDER_NAMES,
  DECODER_ALLOWED,
  isExempt,
  localPlugin,
  repoPath,
  TEXT_EXEMPT,
  TEXT_TRANSITIONAL,
  textProblem,
} from "../../scripts/lint-rules/index.ts";

// S-1L.2 (DAN-780): server code writes no interface text. The rule reads only
// direct literals and forbids text builders whatever their arguments
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
  // Codex review on #65: "hex" as data, not as an encoding.
  'export const f = ["", ""].fill("hex");',
  'export const w = (s: { write(x: string): void }) => s.write("hex");',
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
  // (2) Escapes that give a non-ASCII character, in strings and templates.
  ["builder", 'export const e = "\\u00e9";'],
  ["builder", 'export const e = "\\xe9";'],
  ["builder", 'export const e = "\\u{1F600}";'],
  ["builder", "export const e = `\\u00e9`;"],
  ["builder", "export const e = (n: number) => `${n}\\xe9`;"],
  // (2) fromCharCode and fromCodePoint, directly, by alias and computed member.
  ["builder", "export const e = String.fromCharCode(0x111);"],
  ["builder", "export const e = String.fromCodePoint(0x111);"],
  ["builder", 'export const e = String["fromCharCode"](0x111);'],
  ["builder", "export const e = String[`fromCodePoint`](0x111);"],
  ["builder", "export const e = (k: 'raw') => String[k];"],
  ["value", "const S = String;\nexport const e = S.fromCharCode(0x111);"],
  ["builder", "const S = String;\nexport const e = S.fromCharCode(0x111);"],
  ["builder", 'const k = "fromCharCode";\nexport const e = 1;\nexport { k };'],
  ["builder", 'export const e = Reflect.get(String, "fromCharCode")(0x111);'],
  ["builder", "const { fromCharCode } = String;\nexport const e = fromCharCode(0x111);"],
  ["value", "const { fromCodePoint: f } = String;\nexport const e = f(0x111);"],
  ["value", "export const e = globalThis.String.fromCharCode(0x111);"],
  ["value", 'export const e = globalThis["String"];'],
  ["builder", "export const e = String.fromCharCode.apply(null, [0x111]);"],
  ["value", "export const s = [String][0];"],
  ["value", "declare global {\n  var String: StringConstructor;\n}\nexport const s = String;"],
  // (2) String.raw.
  ["builder", "export const e = String.raw`a`;"],
  ["builder", "const { raw } = { raw: String.raw };\nexport const e = raw;"],
  // (2) Decoders.
  ["builder", 'export const e = atob("xIxhag==");'],
  ["builder", 'export const e = globalThis.atob("xIxhag==");'],
  ["builder", "export const e = (b: Uint8Array) => new TextDecoder().decode(b);"],
  ["builder", 'import { TextDecoder as D } from "node:util";\nexport const d = new D();'],
  ["builder", 'import * as u from "node:util";\nexport const d = new u.TextDecoder();'],
  ["builder", 'export const e = decodeURIComponent("Prona%C4%91eno");'],
  ["builder", "export const e = (x: string) => decodeURIComponent(x);"],
  ["builder", "export const e = (x: string) => decodeURI(x);"],
  ["builder", "export const e = (x: string) => unescape(x);"],
  ["builder", 'export const e = Reflect.get(globalThis, "atob");'],
  // (2) Buffer: an encoding, an array, of, alias, computed member.
  ["builder", 'export const e = Buffer.from("xIxhag==", "base64").toString();'],
  ["builder", 'export const e = Buffer.from("c48d", "hex").toString();'],
  ["builder", "export const e = (x: string) => Buffer.from(x, 'latin1');"],
  ["builder", "export const e = Buffer.from([0xc4, 0x8d]).toString();"],
  ["builder", "export const e = Buffer.of(0xc4, 0x8d).toString();"],
  ["builder", 'export const e = Buffer["from"]("xIxhag==", "base64");'],
  ["builder", "export const e = (k: 'from') => Buffer[k];"],
  ["builder", "export const f = Buffer.from;"],
  ["value", "const B = Buffer;\nexport const e = B.from([0xc4]);"],
  ["value", "export const e = globalThis.Buffer;"],
  // Codex review on #65: Buffer imported from node:buffer, also renamed.
  ["builder", 'import { Buffer } from "node:buffer";\nexport const e = Buffer.from([196, 141]);'],
  ["builder", 'import { Buffer as B } from "buffer";\nexport const e = B.of(196, 141);'],
  ["value", 'import { Buffer as B } from "node:buffer";\nexport const e = [B];'],
  ["value", "export const e = Reflect.get(Buffer, 'from');"],
  // Adversarial review of the contract (w780b): static forms it found.
  // Encoded forms (escapes as text, %, entities, data:, punycode) are DAN-784.
  ["letter", "export const e = /čekaj/u.source;"],
  ["letter", "export const r = /[čćžšđ]/u;"],
  ["sentence", "export const e = /Molimo pokusajte ponovno/u.source;"],
  ["value", 'export const e = Reflect.get(String, "x");'],
  ["value", "export const e = ((f: unknown) => f)(String);"],
  ["builder", "export const e = Reflect.get(String.prototype, 1);"],
  ["builder", 'export const e = Buffer.alloc(2, "c48d", "hex").toString();'],
  ["builder", 'export const e = (b: Buffer) => b.fill("c48d", "hex");'],
  ["builder", 'export const e = (b: Buffer) => b.write("c48d", "hex");'],
  ["builder", "export const e = Buffer.from(new Uint8Array([196, 141])).toString();"],
  ["builder", "export const e = Buffer.concat([new Uint8Array([196, 141])]).toString();"],
  ["builder", "export const e = Buffer.copyBytesFrom(new Uint8Array([196, 141]));"],
  ["builder", "export const e = new TextDecoderStream();"],
  ["builder", "export const e = new Response(new Uint8Array([196, 141])).text();"],
  ["builder", "export const e = new Blob([new Uint8Array([196, 141])]).text();"],
  ["value", 'import util from "node:util";\nexport const e = Object.values(util);'],
  ["value", 'import * as u from "node:url";\nexport const e = Reflect.get(u, "x");'],
  ["builder", 'import { domainToUnicode } from "node:url";\nexport const e = domainToUnicode;'],
  ["builder", 'export const e = new Intl.DisplayNames(["hr"], { type: "language" });'],
  ["builder", 'export const e = new Date(0).toLocaleDateString("hr-HR");'],
  ["sentence", "export const e = (x: string) => `Molimo ${x} pokusajte ${x} ponovno`;"],
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

describe("DECODER_ALLOWED", () => {
  it("allows a listed decoder on input, never on a literal", async () => {
    const file = "server/contracts/work-id.ts";
    expect(DECODER_ALLOWED[file]).toEqual(["decodeURIComponent"]);
    expect(await ids("export const e = (x: string) => decodeURIComponent(x);", file)).toEqual([]);
    expect(await ids('export const e = decodeURIComponent("%C4%91");', file)).toContain("builder");
    expect(await ids("export const e = decodeURIComponent(`a`);", file)).toContain("builder");
    // Only the listed name: another decoder in the same file fails.
    expect(await ids("export const e = (x: string) => atob(x);", file)).toContain("builder");
    expect(await ids("export const e = String.fromCharCode(1);", file)).toContain("builder");
  });

  it("allows Buffer.from with an encoding only in listed files", async () => {
    const code = 'export const e = (x: string) => Buffer.from(x, "hex");';
    expect(await ids(code, "server/domain/forensics/golden-vectors/load.ts")).toEqual([]);
    expect(await ids(code, "server/domain/forensics/other.ts")).toContain("builder");
    // Review FAIL c.6898809748: the exception is Buffer.from only.
    const keys = "server/external/keys/ed25519-signature-encoding.ts";
    for (const other of [
      'export const e = Buffer.alloc(2, "c48d", "hex").toString();',
      "export const e = Buffer.concat([new Uint8Array([196, 141])]).toString();",
      'export const e = (b: Buffer) => b.fill("c48d", "hex");',
      'export const e = (b: Buffer) => b.write("c48d", "hex");',
    ])
      expect(await ids(other, keys), other).toContain("builder");
  });

  it("lists files that exist and use each listed builder", () => {
    for (const [file, names] of Object.entries(DECODER_ALLOWED)) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const name of names) {
        expect(BUILDER_NAMES.includes(name) || name === "Buffer.from", name).toBe(true);
        expect(source.includes(name), `${file}: ${name}`).toBe(true);
      }
    }
  });
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
