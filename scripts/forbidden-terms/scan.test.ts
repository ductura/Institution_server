// The locales scan (S-1L.1, DAN-768, PR-b2), contract Ductus#1836
// c.6890523605, "Invarijante i negativni testovi". The first case scans the
// real locales/; every negative case runs on a copy in a temporary folder,
// never on the real catalogue.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SCAN_ERROR_CODES, scanLocales, type ScanReport } from "./scan.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A copy of locales/ in a new temporary root, so each case imports its own modules. */
function copy(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ductura-locales-"));
  roots.push(root);
  cpSync(path.join(REPO_ROOT, "locales"), path.join(root, "locales"), { recursive: true });
  return root;
}

/** Replaces the one occurrence of `from` in a file of the copy; a fixture that does not find it is a test mistake. */
function edit(root: string, file: string, from: string, to: string): void {
  const full = path.join(root, "locales", file);
  const content = readFileSync(full, "utf8");
  if (content.split(from).length !== 2) throw new Error(`${file}: "${from}" is not there once`);
  writeFileSync(
    full,
    content.replace(from, () => to),
  );
}

/** Adds an export of texts to a `.ts` catalogue of the copy; the scan reads every export. */
function probe(root: string, file: string, texts: readonly string[]): void {
  writeFileSync(
    path.join(root, "locales", file),
    `${readFileSync(path.join(root, "locales", file), "utf8")}\nexport const probe = ${JSON.stringify(texts)};\n`,
  );
}

function report(root: string): ScanReport {
  const result = scanLocales(root);
  if (!result.ok)
    throw new Error(`${result.error.code} ${result.error.file}: ${result.error.detail}`);
  return result.value;
}

function errorCode(root: string): string {
  const result = scanLocales(root);
  return result.ok ? "ok" : `${result.error.code} ${result.error.file}`;
}

/** Findings as "file path: reason". */
const found = (scan: ScanReport): string[] =>
  scan.findings.map((finding) => `${finding.file} ${finding.path}: ${finding.reason}`);
/** The paths of the probe export that have a finding. */
const flagged = (scan: ScanReport, file: string): string[] => [
  ...new Set(
    scan.findings
      .filter((finding) => finding.file === file && finding.path.startsWith("probe."))
      .map((finding) => finding.path),
  ),
];
const TAGLINE_HR = '"Kako je rad nastao, bez presude o autorstvu."';
const TAGLINE_EN = '"How the work was written, with no verdict on authorship."';

describe("scanLocales on locales/", () => {
  it("reads every text and finds nothing", () => {
    const scan = report(REPO_ROOT);
    expect(found(scan)).toEqual([]);
    expect(scan.read).toEqual({ "hr.ts": 1430, "en.ts": 1430, "hr.json": 55 });
  });
});

describe("scan errors", () => {
  // docs/CODE_STYLE.md §8: every error carries a messageKey with Croatian text in locales/.
  it("have a text in hr.json for every code", () => {
    const texts = JSON.parse(readFileSync(path.join(REPO_ROOT, "locales", "hr.json"), "utf8")) as {
      forbiddenTerms: Record<string, string>;
    };
    expect(Object.keys(texts.forbiddenTerms).sort()).toEqual(
      SCAN_ERROR_CODES.map((code) => code.toLowerCase()).sort(),
    );
    const root = copy();
    rmSync(path.join(root, "locales", "en.ts"));
    const result = scanLocales(root);
    expect(result.ok ? "" : result.error.messageKey).toBe("forbiddenTerms.catalogue_missing");
  });
});

describe("invariant 1: every leaf is read", () => {
  it("reads the same numbers from a copy", () => {
    expect(report(copy()).read).toEqual({ "hr.ts": 1430, "en.ts": 1430, "hr.json": 55 });
  });

  it.each(["de.ts", "x.json", "notes.txt", "sub/hr.ts", "hr.test.json"])(
    "fails on a file it has not classified: %s",
    (file) => {
      const root = copy();
      mkdirSync(path.dirname(path.join(root, "locales", file)), { recursive: true });
      writeFileSync(path.join(root, "locales", file), "export const a = 'x';\n");
      expect(errorCode(root)).toBe(`UNLISTED_FILE ${file.split("/")[0]}`);
    },
  );

  // Review FAIL c.6892705617, point 2: a folder that cannot be listed is an input error in the result.
  it("fails with the result, not a throw, when locales/ is not there", () => {
    const root = copy();
    rmSync(path.join(root, "locales"), { recursive: true });
    expect(errorCode(root)).toBe("UNREADABLE_FILE locales");
  });

  it("fails on a listed catalogue that is gone", () => {
    const root = copy();
    rmSync(path.join(root, "locales", "en.ts"));
    expect(errorCode(root)).toBe("CATALOGUE_MISSING en.ts");
  });

  it.each([
    ["number", "7"],
    ["null", "null"],
    ["undefined", "undefined"],
    ["boolean", "true"],
    ["function", "() => 'Sumnjivo'"],
    ["Map", "new Map([['a', 'Sumnjivo']])"],
  ])("fails on a leaf that is a %s", (_, value) => {
    const root = copy();
    edit(root, "hr.ts", `tagline: ${TAGLINE_HR}`, `tagline: ${value}`);
    expect(errorCode(root)).toBe("NOT_TEXT hr.ts");
  });

  it("fails on a JSON leaf that is not a string", () => {
    const root = copy();
    edit(root, "hr.json", '"Risk: mora biti low, standard ili critical."', "null");
    expect(errorCode(root)).toBe("NOT_TEXT hr.json");
  });

  it("fails with the result, not a throw, when a catalogue throws a value that cannot be shown", () => {
    const root = copy();
    const file = path.join(root, "locales", "en.ts");
    const thrower = 'throw { toString() { throw new Error("no"); } };';
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${thrower}\n`);
    expect(errorCode(root)).toBe("UNREADABLE_FILE en.ts");
  });

  it("fails on a catalogue that needs a runtime import", () => {
    const root = copy();
    edit(
      root,
      "en.ts",
      'import type { Messages } from "./hr.ts";',
      'import { type Messages, textOf } from "./hr.ts";\nvoid textOf;',
    );
    expect(errorCode(root)).toBe("UNREADABLE_FILE en.ts");
  });

  it("fails on a leaf that is a class instance", () => {
    const root = copy();
    edit(
      root,
      "hr.ts",
      `tagline: ${TAGLINE_HR}`,
      "tagline: new (class Text { a = 'Sumnjivo'; })()",
    );
    expect(errorCode(root)).toBe("NOT_TEXT hr.ts");
  });

  // QA of PR-b2: what the scan reads must be what the app reads, once and as written.
  it.each([
    ["a getter", `tagline: ${TAGLINE_EN}`, 'get tagline() { return "Skip"; }'],
    [
      "a Proxy",
      "export const messagesEn: Messages = en;",
      "export const messagesEn = new Proxy(en, {});",
    ],
    [
      "inherited text",
      "const en = {",
      'const en = {\n  __proto__: { __proto__: null, note: "Suspicious edit" },',
    ],
  ])("fails on %s", (_, from, to) => {
    const root = copy();
    edit(root, "en.ts", from, to);
    expect(errorCode(root)).toBe("NOT_TEXT en.ts");
  });

  it("fails on an array whose prototype holds text", () => {
    const root = copy();
    probe(root, "en.ts", []);
    edit(
      root,
      "en.ts",
      "export const probe = [];",
      'export const probe = Object.setPrototypeOf([], { note: "Suspicious edit" });',
    );
    expect(errorCode(root)).toBe("NOT_TEXT en.ts");
  });

  // Review FAIL c.6892188812: a prototype is accepted by identity, not by the names of its keys.
  it("fails on an object whose prototype copies Object.prototype and holds text", () => {
    const root = copy();
    writeFileSync(
      path.join(root, "locales", "en.ts"),
      `${readFileSync(path.join(root, "locales", "en.ts"), "utf8")}
const proto = Object.create(null);
for (const key of Object.getOwnPropertyNames(Object.prototype)) proto[key] = "Suspicious edit";
export const probe = Object.create(proto);
`,
    );
    expect(errorCode(root)).toBe("NOT_TEXT en.ts");
  });

  it("fails on a catalogue that writes text into its own Object.prototype", () => {
    const root = copy();
    probe(root, "en.ts", []);
    edit(
      root,
      "en.ts",
      "export const probe = [];",
      'Object.defineProperty(Object.prototype, "note", { value: "Suspicious edit" });',
    );
    expect(errorCode(root)).toBe("UNREADABLE_FILE en.ts");
  });

  // Orchestrator's hard cut (#44 c.6892192874): exactly Object.prototype or Array.prototype, data properties only.
  it.each([
    [
      "Object.create(null)",
      'export const probe = Object.assign(Object.create(null), { a: "Predano" });',
    ],
    [
      "Object.create over Object.prototype with inherited text",
      'const base = Object.create(Object.prototype);\nbase.note = "Suspicious edit";\nexport const probe = Object.create(base);',
    ],
    [
      "a key that is not enumerable",
      'export const probe = Object.defineProperty({}, "a", { value: "Suspicious edit", enumerable: false });',
    ],
    ["an array with a hole", 'export const probe = ["Predano", , "Predano"];'],
    // Review FAIL c.6892496799: a hole hidden by a named key, and a revoked Proxy.
    [
      "an array with a hole and a named key",
      'export const probe = Object.assign(new Array<string>(1), { label: "Ready" });',
    ],
    // Orchestrator's third round (#44 c.6892510145): the shapes it names, and what the JSON copy catches.
    ["an array with a named key", 'export const probe = Object.assign([], { label: "Ready" });'],
    ["a Proxy that is not revoked", 'export const probe = new Proxy({ a: "Predano" }, {});'],
    [
      "a revoked Proxy",
      "const revocable = Proxy.revocable({}, {});\nrevocable.revoke();\nexport const probe = revocable.proxy;",
    ],
    ["a getter on an export", 'export const probe = { get a() { return "Suspicious edit"; } };'],
  ])("fails on %s", (_, source) => {
    const root = copy();
    const file = path.join(root, "locales", "en.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${source}\n`);
    expect(errorCode(root)).toBe("NOT_TEXT en.ts");
  });

  it("fails on an export that is a function not on the list", () => {
    const root = copy();
    writeFileSync(
      path.join(root, "locales", "en.ts"),
      `${readFileSync(path.join(root, "locales", "en.ts"), "utf8")}export function textOf() { return "Sumnjivo"; }\n`,
    );
    expect(errorCode(root)).toBe("UNKNOWN_EXPORT en.ts");
  });

  it("fails on a catalogue without its table", () => {
    const root = copy();
    edit(root, "en.ts", "export const messagesEn: Messages = en;", "export const other = en;");
    expect(errorCode(root)).toBe("UNKNOWN_EXPORT en.ts");
  });

  it("reads every other export, arrays included", () => {
    const root = copy();
    probe(root, "hr.ts", ["Predano", "Sumnjivo pisanje"]);
    const scan = report(root);
    expect(scan.read["hr.ts"]).toBe(1432);
    expect(found(scan)).toEqual(["hr.ts probe.1: forbidden term: sumnjivo"]);
  });

  it("fails on a JSON key written twice in one object", () => {
    const root = copy();
    edit(root, "hr.json", '  "gate": {\n', '  "gate": {\n    "task_missing": "Sumnjivo",\n');
    expect(errorCode(root)).toBe("DUPLICATE_KEY hr.json");
  });

  it("fails on a dotted JSON key that names the path of another text", () => {
    const root = copy();
    edit(root, "hr.json", '  "gate": {\n', '  "gate.task_missing": "Sumnjivo",\n  "gate": {\n');
    expect(errorCode(root)).toBe("DUPLICATE_KEY hr.json");
  });

  it("fails on a catalogue that is not JSON", () => {
    const root = copy();
    edit(root, "hr.json", '  "gate": {\n', `  "gate": ${cp(0x202e)}{\n`);
    const result = scanLocales(root);
    expect(result.ok ? "" : `${result.error.code} ${result.error.detail}`).not.toMatch(/‮/u);
    expect(errorCode(root)).toBe("UNREADABLE_FILE hr.json");
  });
});

// DAN-774: a `.ts` catalogue is read from its syntax tree as data; no line of it runs.
describe("invariant 1b: a .ts catalogue is data, read without running it", () => {
  /** Appends `source` to en.ts of a new copy and returns the scan's error code. */
  const withSource = (source: string): string => {
    const root = copy();
    const file = path.join(root, "locales", "en.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${source}\n`);
    return errorCode(root);
  };

  // Review FAIL c.6892705617, point 1: a `length` getter that replaces itself with a clean text.
  it("fails on a getter that replaces itself, as in the fourth FAIL on #44", () => {
    const getter = [
      "export const probe = {",
      "  get length() {",
      '    Object.defineProperty(probe, "length", { value: "Ready", enumerable: true });',
      '    return "Suspicious edit";',
      "  },",
      "};",
    ].join("\n");
    expect(withSource(getter)).toBe("NOT_TEXT en.ts");
  });

  // Had the scan run the getter, the throw would give UNREADABLE_FILE (or escape the result).
  it.each([
    [
      "on a table key",
      'export const probe = { get a(): string { throw new Error("getter ran"); } };',
    ],
    [
      "on length",
      'export const probe = { get length(): number { throw new Error("getter ran"); } };',
    ],
    [
      "as a setter",
      'export const probe = { set a(_: string) { throw new Error("setter ran"); } };',
    ],
  ])("refuses a getter %s before it runs", (_, source) => {
    expect(withSource(source)).toBe("NOT_TEXT en.ts");
  });

  it.each([
    [
      "__proto__ as a string key",
      'export const probe = { "__proto__": { note: "Suspicious edit" } };',
    ],
    [
      "__proto__ written with an escape",
      'export const probe = { __proto\\u005f_: { note: "Suspicious edit" } };',
    ],
    ["a computed key", 'export const probe = { ["a"]: "Suspicious edit" };'],
    [
      "a spread into an object",
      'const extra = { a: "Suspicious edit" };\nexport const probe = { ...extra };',
    ],
    [
      "a spread into an array",
      'const extra = ["Suspicious edit"];\nexport const probe = [...extra];',
    ],
    ["a method", 'export const probe = { a() { return "Suspicious edit"; } };'],
    [
      "a toJSON method",
      'export const probe = { a: "Ready", toJSON() { return { a: "Ready" }; } };',
    ],
    ["a shorthand key", 'const a = "Ready";\nexport const probe = { a };'],
    ["a numeric key", 'export const probe = { 0: "Ready" };'],
    ["a call", 'export const probe = [String("Suspicious edit")];'],
    ["a tagged template", "export const probe = [String.raw`Suspicious edit`];"],
    ["a concatenation", 'export const probe = ["Suspicious " + "edit"];'],
    ["a template with a number", "export const probe = [`Edit ${1}`];"],
    [
      "a template with an object",
      'const part = { a: "x" };\nexport const probe = [`Edit ${part}`];',
    ],
    [
      "a constant used before it is declared",
      'export const probe = [later];\nconst later = "Ready";',
    ],
    ["a name that is not a constant of the file", "export const probe = [undefined];"],
    ["a destructured constant", 'export const { probe } = { probe: ["Ready"] };'],
  ])("fails on %s", (_, source) => {
    expect(withSource(source)).toBe("NOT_TEXT en.ts");
  });

  it.each([
    ["a statement that changes the table", 'Object.assign(en.app, { name: "Suspicious edit" });'],
    ["a function that is not exported", 'function probe() { return "Suspicious edit"; }'],
    ["a side-effect import", 'import "./hr.ts";'],
    ["a block", '{ const a = "Suspicious edit"; }'],
    ["a let that is not exported", 'let probe = ["Ready"];'],
  ])("fails on %s", (_, source) => {
    expect(withSource(source)).toBe("UNREADABLE_FILE en.ts");
  });

  it.each([
    ["a re-export under another name", "export { en as probe };"],
    ["a default export", "export default en;"],
    ["an exported let", 'export let probe = ["Ready"];'],
    ["an exported var", 'export var probe = ["Ready"];'],
    ["an exported class", 'export class Probe { a = "Suspicious edit"; }'],
  ])("fails on %s", (_, source) => {
    expect(withSource(source)).toBe("UNKNOWN_EXPORT en.ts");
  });

  it("fails on a key or a constant written twice", () => {
    expect(withSource('export const probe = { a: "Ready", a: "Suspicious edit" };')).toBe(
      "DUPLICATE_KEY en.ts",
    );
    expect(withSource('const a = "Ready";\nconst a = "Suspicious edit";')).toBe(
      "DUPLICATE_KEY en.ts",
    );
  });

  it("fails on a catalogue that does not parse", () => {
    expect(withSource("export const probe = {")).toBe("UNREADABLE_FILE en.ts");
  });

  it("reads texts built from templates and earlier constants", () => {
    const root = copy();
    const file = path.join(root, "locales", "hr.ts");
    const source =
      'const WORD = "Sumnjivo";\nexport const probe = { a: `${WORD} pisanje`, b: [WORD] };';
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${source}\n`);
    const scan = report(root);
    expect(scan.read["hr.ts"]).toBe(1432);
    expect(flagged(scan, "hr.ts")).toEqual(["probe.a", "probe.b.0"]);
  });

  it("fails on hr.ts that exports textOf again", () => {
    const root = copy();
    const file = path.join(root, "locales", "hr.ts");
    const textOf = 'export function textOf(): string {\n  return "Sumnjivo";\n}';
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${textOf}\n`);
    expect(errorCode(root)).toBe("UNKNOWN_EXPORT hr.ts");
  });

  // Adversarial pass on DAN-774: forms that keep or add runtime code.
  it.each([
    [
      "an import that is type-only per name, which still loads hr.ts",
      'import { type Messages as M } from "./hr.ts";',
    ],
    ["an enum", 'enum Probe { A = "Suspicious edit" }'],
    ["a namespace", 'namespace Probe { export const a = "Suspicious edit"; }'],
    ["an ambient constant", "declare const probe: string;"],
    ["an import alias", "import Probe = globalThis.String;"],
    ["a using declaration", "using probe = null;"],
  ])("fails on %s", (_, source) => {
    expect(withSource(source)).toBe("UNREADABLE_FILE en.ts");
  });

  it("fails on a re-export of another module", () => {
    expect(withSource('export * from "./hr.ts";')).toBe("UNKNOWN_EXPORT en.ts");
  });
});

describe("invariant 2: a forbidden term in any catalogue", () => {
  it("is found with its file and path in hr, en and hr.json", () => {
    const root = copy();
    edit(root, "hr.ts", `tagline: ${TAGLINE_HR}`, 'tagline: "Sumnjivo pisanje"');
    edit(root, "en.ts", `tagline: ${TAGLINE_EN}`, 'tagline: "Suspicious edit"');
    edit(root, "hr.json", "Pokušaj ponovno.", "Rizik je visok.");
    expect(found(report(root))).toEqual([
      "hr.ts app.tagline: forbidden term: sumnjivo",
      "en.ts app.tagline: forbidden term: suspicious",
      "hr.json signing.timeout: forbidden term: rizik",
    ]);
  });

  it("is found in the Croatian entries over English text and the English entries over Croatian text", () => {
    const root = copy();
    probe(root, "en.ts", ["Rizik"]);
    probe(root, "hr.ts", ["Hidden steps"]);
    expect(found(report(root))).toEqual([
      "hr.ts probe.0: forbidden term: hidden",
      "en.ts probe.0: forbidden term: rizik",
    ]);
  });
});

describe("invariant 3: kopir- and copy only in the words of §5", () => {
  it("lets the four allowed texts through and flags every other form", () => {
    const root = copy();
    const allowed = [
      "Kopiraj navod",
      "kopiranje navoda",
      "Kopirano u međuspremnik",
      "Copy citation",
    ];
    const banned = [
      "Kopiraj tekst",
      "Kopirajte",
      "Kopiraj navode",
      "Copy",
      "Copied to clipboard",
      "copying",
      "Copy-paste",
      "Copy. Citation",
    ];
    probe(root, "hr.ts", [...allowed, ...banned]);
    probe(root, "en.ts", ["Copy citation", ...banned.slice(3)]);
    const scan = report(root);
    expect(flagged(scan, "hr.ts")).toEqual(
      banned.map((_, index) => `probe.${index + allowed.length}`),
    );
    expect(flagged(scan, "en.ts")).toEqual(["probe.1", "probe.2", "probe.3", "probe.4", "probe.5"]);
  });
});

describe("invariant 4: Croatian in en", () => {
  it("flags a Croatian letter, also written apart, and a Croatian word", () => {
    const root = copy();
    probe(root, "en.ts", [
      "Sažetak",
      "Prec\u030Cica",
      "Sumnjivo",
      "SAŽETAK",
      "Summary",
      "Pod\u0335a",
      "Mis\u0306",
    ]);
    const scan = report(root);
    expect(found(scan).filter((line) => line.includes("probe"))).toEqual([
      "en.ts probe.0: Croatian letter in English text",
      "en.ts probe.1: Croatian letter in English text",
      "en.ts probe.2: forbidden term: sumnjivo",
      "en.ts probe.3: Croatian letter in English text",
      "en.ts probe.5: Croatian letter in English text",
      "en.ts probe.6: Croatian letter in English text",
    ]);
  });

  it("flags an English text equal to the Croatian one at the same path", () => {
    const root = copy();
    edit(root, "hr.ts", `tagline: ${TAGLINE_HR}`, 'tagline: "Spremi rad"');
    edit(root, "en.ts", `tagline: ${TAGLINE_EN}`, 'tagline: "Spremi rad"');
    expect(found(report(root))).toEqual([
      "en.ts app.tagline: same text as hr.ts (not on SAME_IN_BOTH)",
    ]);
  });

  it("fails on a stale SAME_IN_BOTH path", () => {
    const root = copy();
    edit(
      root,
      "en.ts",
      'role: { teacher: "Teacher", student: "Student"',
      'role: { teacher: "Teacher", student: "Learner"',
    );
    expect(errorCode(root)).toBe("STALE_SAME_IN_BOTH en.ts");
  });
});

describe("invariant 5: hidden forms", () => {
  it.each([
    ["capitals", "SUMNJIVO"],
    ["no diacritics", "Autenticnost rada"],
    ["full width", "Ｓｕｍｎｊｉｖｏ"],
    ["soft hyphen inside a word", `Sum${cp(0xad)}njivo`],
    ["zero width space inside a word", `Sum${cp(0x200b)}njivo`],
    ["Cyrillic o", `sumnjiv${cp(0x43e)}`],
    ["bidi control", `${cp(0x202e)}ovijnmus${cp(0x202c)}`],
    ["phrase end mark", `Rok${cp(0xffff)}predaje`],
  ])("flags %s in hr and en", (_, text) => {
    const root = copy();
    probe(root, "hr.ts", [text]);
    probe(root, "en.ts", [text]);
    const scan = report(root);
    expect(flagged(scan, "hr.ts")).toEqual(["probe.0"]);
    expect(flagged(scan, "en.ts")).toEqual(["probe.0"]);
    for (const finding of scan.findings) expect(finding.text).not.toMatch(/[‮‬￿]/u);
  });
});

describe("invariant 6: the exception for Risk: does not spread", () => {
  it("flags Risk: on another path, risk without the colon and rizik on an excepted path", () => {
    const root = copy();
    edit(
      root,
      "hr.json",
      "Potpisivanje zapisa trajalo je predugo. Pokušaj ponovno.",
      "Risk: predugo.",
    );
    edit(root, "hr.json", "Risk: mora biti low", "Risk: mora biti low, a risk");
    edit(root, "hr.json", "Prijavljeni Risk: niži", "Prijavljeni Risk: (rizik) niži");
    expect(found(report(root))).toEqual([
      "hr.json gate.risk_invalid: forbidden term: risk",
      "hr.json gate.risk_below_floor: forbidden term: rizik",
      "hr.json signing.timeout: forbidden term: risk",
    ]);
  });

  it("excuses one Risk: and only the term of the literal itself", () => {
    const root = copy();
    edit(root, "hr.json", "Risk: mora biti low", "Risk: score mora biti low");
    expect(found(report(root))).toEqual([
      "hr.json gate.risk_invalid: forbidden term: risk score, trust score, attention score, suspicion score",
    ]);
    edit(root, "hr.json", "Prijavljeni Risk: niži", "Prijavljeni Risk: niži, High Risk: viši");
    expect(errorCode(root)).toBe("STALE_EXCEPTION hr.json");
  });

  it("does not mask Risk: in other letter case", () => {
    const root = copy();
    edit(root, "hr.json", "Risk: mora biti low", "RISK: mora biti low");
    expect(errorCode(root)).toBe("STALE_EXCEPTION hr.json");
  });

  it("fails on a stale exception", () => {
    const root = copy();
    edit(root, "hr.json", "Prijavljeni Risk: niži", "Prijavljena razina niža");
    expect(errorCode(root)).toBe("STALE_EXCEPTION hr.json");
  });

  it("fails on an exception whose path is gone", () => {
    const root = copy();
    edit(root, "hr.json", '"risk_invalid"', '"risk_wrong"');
    expect(errorCode(root)).toBe("STALE_EXCEPTION hr.json");
  });

  it("does not take the exception into hr.ts at the same path", () => {
    const root = copy();
    writeFileSync(
      path.join(root, "locales", "hr.ts"),
      `${readFileSync(path.join(root, "locales", "hr.ts"), "utf8")}export const gate = { risk_invalid: "Risk: x" };\n`,
    );
    expect(found(report(root))).toEqual(["hr.ts gate.risk_invalid: forbidden term: risk"]);
  });
});

describe("invariant 7: deltas 3 to 5 and allowed texts", () => {
  it("flags the deltas and lets the allowed forms through", () => {
    const root = copy();
    const banned = ["Vjerojatno", "Lost data", "Flagged for review", "Cheating", "Vanished data"];
    const allowed = [
      "Spremljeno na uređaju",
      "Saved on this device",
      "Sakrij komentare",
      "Prepiska s mentorom",
      "Authentication failed",
      "Nepravilan format",
      "Predano 50 %",
    ];
    probe(root, "hr.ts", [...banned, ...allowed]);
    probe(root, "en.ts", [...banned, ...allowed.filter((text) => !/[čćđšž]/iu.test(text))]);
    const scan = report(root);
    expect(flagged(scan, "hr.ts")).toEqual(banned.map((_, index) => `probe.${index}`));
    expect(flagged(scan, "en.ts")).toEqual(banned.map((_, index) => `probe.${index}`));
  });
});
