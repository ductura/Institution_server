/**
 * The scan of every interface text in locales/** (S-1L.1, DAN-768, PR-b2; Ductus#1836 c.6890523605, c.6890541239).
 * Every file is on a closed list; every leaf is read and checked, or the scan fails with an input error.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import vm from "node:vm";

import ts from "typescript";

import { shownText, unreadableCharacters } from "./characters.ts";
import { findForbiddenTerms, foldText, type ForbiddenTerm } from "./terms.ts";

/** `table` is the export of a `.ts` catalogue that holds it; `functions` are the only exports that may be functions. */
type Catalogue = Readonly<{ lang: "hr" | "en"; table?: string; functions?: readonly string[] }>;

/** Every catalogue under locales/, by file name. */
export const CATALOGUES: Readonly<Record<string, Catalogue>> = {
  "hr.ts": { lang: "hr", table: "messagesHr", functions: ["textOf"] },
  "en.ts": { lang: "en", table: "messagesEn" },
  "hr.json": { lang: "hr" },
};

/** Files under locales/ that are not interface text, with the reason. `*.test.ts` are tests. */
export const NOT_CATALOGUES: Readonly<Record<string, string>> = {
  "index.ts": "re-exports the catalogues, holds no text",
  "parity.ts": "compares the keys of hr and en, holds no text",
  "source.ts": "keeps the Ductus source texts (SOURCE_TEXT_CHANGES) as a record, not as interface",
  "test-leaves.ts": "test helper, holds no text",
  "README.md": "documentation",
  ".gitkeep": "empty file that keeps the folder in git",
};

/** Paths where English equal to Croatian is right (names); any other is untranslated. Stale fails. */
export const SAME_IN_BOTH: readonly string[] = [
  "app.name",
  "shell.role.student",
  "shell.role.admin",
  "landing.access.roles.student.name",
  "teacherCourses.students.one",
  "workspace.work.mentorNote",
  "comments.student",
  "revisions.student",
  "summary.units.minutesGenitive.one",
  "institutionCourses.students.one",
  "accessLog.roles.mentor",
  "accessLog.roleAlone.mentor",
];

/** `literal` is masked before the dictionary is matched, in exactly these characters. */
export type Exception = Readonly<{ file: string; path: string; literal: string; reason: string }>;

const RISK_LINE =
  "the name of a PR description line for the gate (Ductus#1836 c.6890541239, point 3)";

/** The closed list of exceptions to the dictionary; a stale one fails the scan. */
export const EXCEPTIONS: readonly Exception[] = [
  { file: "hr.json", path: "gate.risk_invalid", literal: "Risk:", reason: RISK_LINE },
  { file: "hr.json", path: "gate.risk_below_floor", literal: "Risk:", reason: RISK_LINE },
];

/** `text` writes characters a log cannot show by their escape (`shownText`). */
export type Finding = Readonly<{ file: string; path: string; text: string; reason: string }>;

export const SCAN_ERROR_CODES = [
  "UNLISTED_FILE",
  "CATALOGUE_MISSING",
  "UNREADABLE_FILE",
  "UNKNOWN_EXPORT",
  "NOT_TEXT",
  "DUPLICATE_KEY",
  "STALE_SAME_IN_BOTH",
  "STALE_EXCEPTION",
] as const;

/** `messageKey` is `forbiddenTerms.<code in lower case>` in locales/hr.json (docs/CODE_STYLE.md §8). */
export type ScanError = Readonly<{
  code: (typeof SCAN_ERROR_CODES)[number];
  messageKey: string;
  file: string;
  detail: string;
}>;

/** `read` is the number of leaves read, by catalogue file. */
export type ScanReport = Readonly<{ findings: readonly Finding[]; read: Record<string, number> }>;

export type ScanResult = { ok: true; value: ScanReport } | { ok: false; error: ScanError };

class InputError extends Error {
  constructor(readonly scanError: ScanError) {
    super(`${scanError.code} ${scanError.file}: ${scanError.detail}`);
  }
}

const fail = (code: ScanError["code"], file: string, detail: string): never => {
  const messageKey = `forbiddenTerms.${code.toLowerCase()}`;
  throw new InputError({ code, messageKey, file, detail: shownText(detail) });
};

/** Scans `<root>/locales`; an input the scan cannot read in full is an error, never a smaller report. */
export function scanLocales(root: string): ScanResult {
  try {
    return { ok: true, value: scan(path.join(root, "locales")) };
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: error.scanError };
    throw error;
  }
}

function scan(dir: string): ScanReport {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const name = path.relative(dir, path.join(entry.parentPath, entry.name));
    const listed = Object.hasOwn(CATALOGUES, name) || Object.hasOwn(NOT_CATALOGUES, name);
    if (!entry.isFile() || !(listed || /^[^/\\]+\.test\.ts$/.test(name))) {
      fail("UNLISTED_FILE", name, "not a file on CATALOGUES or NOT_CATALOGUES");
    }
  }
  const texts = new Map<string, Map<string, string>>();
  for (const [file, catalogue] of Object.entries(CATALOGUES)) {
    // #44 c.6892510145: whatever a catalogue throws while it is read is an input error, never thrown on.
    try {
      texts.set(file, readCatalogue(dir, file, catalogue));
    } catch (error) {
      if (error instanceof InputError) throw error;
      fail("UNREADABLE_FILE", file, "the catalogue threw while it was read");
    }
  }
  const findings: Finding[] = [];
  const add = (file: string, leafPath: string, text: string, reason: string): void => {
    findings.push({ file, path: leafPath, text: shownText(text), reason });
  };
  for (const [file, leaves] of texts) {
    const lang = CATALOGUES[file]!.lang;
    for (const [leafPath, text] of leaves) {
      let masked = text;
      const excused = new Set<ForbiddenTerm>();
      for (const exception of EXCEPTIONS.filter((e) => e.file === file && e.path === leafPath)) {
        // Exactly one occurrence, which the dictionary still flags; only the terms of the literal alone are excused.
        const own = findForbiddenTerms(exception.literal);
        if (text.split(exception.literal).length !== 2 || own.length === 0) {
          fail("STALE_EXCEPTION", file, `${leafPath}: ${exception.literal}`);
        }
        masked = masked.replace(exception.literal, ".");
        for (const term of own) excused.add(term);
      }
      const unmasked = findForbiddenTerms(text).filter((term) => !excused.has(term));
      for (const term of new Set([...findForbiddenTerms(masked), ...unmasked])) {
        add(file, leafPath, text, `forbidden term: ${term.entry}`);
      }
      const characters = unreadableCharacters(text);
      if (characters.length > 0) add(file, leafPath, text, `characters: ${characters.join(" ")}`);
      // A combining mark left after NFKC (d + U+0335, s + U+0306) can draw a Croatian letter too.
      if (lang === "en" && /[čćđšž]|\p{M}/iu.test(text.normalize("NFKC"))) {
        add(file, leafPath, text, "Croatian letter in English text");
      }
    }
  }
  const gone = EXCEPTIONS.find((exception) => !texts.get(exception.file)?.has(exception.path));
  if (gone) fail("STALE_EXCEPTION", gone.file, `${gone.path}: no such text`);
  findings.push(...untranslated(texts.get("hr.ts")!, texts.get("en.ts")!));
  const read = Object.fromEntries([...texts].map(([file, leaves]) => [file, leaves.size]));
  return { findings, read };
}

/** English texts equal to the Croatian ones at the same path; a stale `SAME_IN_BOTH` path is an error. */
function untranslated(hr: Map<string, string>, en: Map<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const [leafPath, text] of en) {
    const croatian = hr.get(leafPath);
    const same =
      croatian !== undefined &&
      foldText(croatian) === foldText(text) &&
      (text.match(/\p{L}/gu) ?? []).length >= 2;
    const listed = SAME_IN_BOTH.includes(leafPath);
    const reason = "same text as hr.ts (not on SAME_IN_BOTH)";
    if (same && !listed)
      findings.push({ file: "en.ts", path: leafPath, text: shownText(text), reason });
    if (listed && !same) fail("STALE_SAME_IN_BOTH", "en.ts", leafPath);
  }
  const gone = SAME_IN_BOTH.find((leafPath) => !en.has(leafPath));
  if (gone) fail("STALE_SAME_IN_BOTH", "en.ts", `${gone}: no such text`);
  return findings;
}

function readCatalogue(dir: string, file: string, catalogue: Catalogue): Map<string, string> {
  const full = path.join(dir, file);
  let raw: string;
  try {
    raw = readFileSync(full, "utf8");
  } catch {
    return fail("CATALOGUE_MISSING", file, "a listed catalogue is not there");
  }
  const leaves = new Map<string, string>();
  if (catalogue.table === undefined) {
    const keys = walk(file, JSON.parse(raw) as unknown, "", leaves);
    // JSON.parse keeps the last of two equal keys, so an earlier text would go unread.
    const tokens = raw.match(/"(?:[^"\\]|\\.)*"/g)?.length ?? 0;
    if (tokens !== keys + leaves.size) {
      fail("DUPLICATE_KEY", file, `${tokens} strings for ${keys} keys and ${leaves.size} texts`);
    }
    return leaves;
  }
  const [module, copy] = evaluate(full, raw);
  if (!Object.hasOwn(module, catalogue.table)) fail("UNKNOWN_EXPORT", file, catalogue.table);
  const table = module[catalogue.table];
  for (const [name, value] of Object.entries(module)) {
    if (name !== catalogue.table && value === table) continue;
    if (typeof value === "function") {
      if (!catalogue.functions?.includes(name)) fail("UNKNOWN_EXPORT", file, name);
      continue;
    }
    walk(file, value, name === catalogue.table ? "" : name, leaves);
    // #44 c.6892510145: the export must equal its JSON copy made in its own realm, which drops every shape JSON has not.
    if (!isDeepStrictEqual(value, copy(value))) fail("NOT_TEXT", file, `${name}: not plain JSON`);
  }
  return leaves;
}

type Copy = (value: unknown) => unknown;
type CjsSetUp = [object, object, { exports: Record<string, unknown> }, Copy];

/** A `.ts` catalogue's exports, read as scripts/locales/source-digest.ts reads one; no runtime imports. */
function evaluate(full: string, raw: string): [Record<string, unknown>, Copy] {
  const { outputText } = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  // Its own context, whose prototypes are frozen and whose JSON copy is taken before the catalogue runs.
  const context = vm.createContext(Object.create(null) as object);
  const intrinsics = "Object.freeze(Object.prototype), Object.freeze(Array.prototype)";
  const copy = "((p, s) => (value) => p(s(value)))(JSON.parse, JSON.stringify)";
  const setUp = `module = { exports: {} }; exports = module.exports; [${intrinsics}, module, ${copy}]`;
  const [object, array, module, roundTrip] = vm.runInContext(setUp, context) as CjsSetUp;
  OBJECTS.add(object);
  ARRAYS.add(array);
  vm.runInContext(outputText, context, { filename: full });
  return [module.exports, roundTrip];
}

/** Object.prototype and Array.prototype of this realm (JSON) and of each catalogue's context, compared with ===. */
const [OBJECTS, ARRAYS] = [
  new Set<unknown>([Object.prototype]),
  new Set<unknown>([Array.prototype]),
];

/** Puts every text under `node` into `leaves` and returns the number of keys it went through. */
function walk(file: string, node: unknown, at: string, leaves: Map<string, string>): number {
  if (typeof node === "string") {
    if (leaves.has(at)) fail("DUPLICATE_KEY", file, at);
    leaves.set(at, node);
    return 0;
  }
  // #44 c.6892192874: prototype exactly Object.prototype or Array.prototype (=== OBJECTS, ARRAYS), own enumerable
  // data properties only, an array dense with no named key; a Proxy is refused before any introspection.
  const object = typeof node === "object" && node !== null && !types.isProxy(node);
  const proto: unknown = object ? Object.getPrototypeOf(node) : undefined;
  const array = object && Array.isArray(node) && ARRAYS.has(proto);
  if (!(array || OBJECTS.has(proto)))
    return fail("NOT_TEXT", file, `${at || "(root)"}: ${typeof node}`);
  const [own, count] = [Reflect.ownKeys(node as object), (node as unknown[]).length];
  if (array && !own.every((key, i) => key === (i < count ? String(i) : "length"))) {
    fail("NOT_TEXT", file, `${at}: not a dense array`);
  }
  let keys = 0;
  for (const key of own) {
    if (typeof key === "symbol") return fail("NOT_TEXT", file, `${at}: symbol key`);
    if (array && key === "length") continue;
    const property = Object.getOwnPropertyDescriptor(node, key)!;
    if (!("value" in property) || !property.enumerable) fail("NOT_TEXT", file, `${at}.${key}`);
    keys += array ? 0 : 1;
    keys += walk(file, property.value, at ? `${at}.${key}` : key, leaves);
  }
  return keys;
}
