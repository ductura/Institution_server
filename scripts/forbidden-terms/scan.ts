/**
 * The scan of every interface text in locales/** (S-1L.1, DAN-768, PR-b2; contract Ductus#1836
 * c.6890523605, confirmed in c.6890541239). Every file is on a closed list and every leaf is read
 * and checked; a leaf the scan cannot read is an input error, never skipped.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import ts from "typescript";

import { shownText, unreadableCharacters } from "./characters.ts";
import { findForbiddenTerms, foldText } from "./terms.ts";

type Catalogue = {
  readonly lang: "hr" | "en";
  /** The export that holds the table (`.ts`); a `.json` catalogue is the table. */
  readonly table?: string;
  /** Exports that may be functions; any other function export is an input error. */
  readonly functions?: readonly string[];
};

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

export type Exception = {
  readonly file: string;
  readonly path: string;
  /** Masked before the dictionary is matched, in exactly these characters. */
  readonly literal: string;
  readonly reason: string;
};

const RISK_LINE =
  "the name of the line a PR description must hold for the gate (Risk:), not an interface word (Ductus#1836 c.6890541239, point 3)";

/** The closed list of exceptions to the dictionary; a stale one fails the scan. */
export const EXCEPTIONS: readonly Exception[] = [
  { file: "hr.json", path: "gate.risk_invalid", literal: "Risk:", reason: RISK_LINE },
  { file: "hr.json", path: "gate.risk_below_floor", literal: "Risk:", reason: RISK_LINE },
];

export type Finding = {
  readonly file: string;
  readonly path: string;
  /** The text, with characters a log cannot show written by their escape. */
  readonly text: string;
  readonly reason: string;
};

export type ScanError = {
  readonly code:
    | "UNLISTED_FILE"
    | "CATALOGUE_MISSING"
    | "UNREADABLE_FILE"
    | "UNKNOWN_EXPORT"
    | "NOT_TEXT"
    | "DUPLICATE_KEY"
    | "STALE_SAME_IN_BOTH"
    | "STALE_EXCEPTION";
  readonly file: string;
  readonly detail: string;
};

export type ScanReport = {
  readonly findings: readonly Finding[];
  /** Leaves read, by catalogue file. */
  readonly read: Readonly<Record<string, number>>;
};

export type ScanResult = { ok: true; value: ScanReport } | { ok: false; error: ScanError };

class InputError extends Error {
  constructor(readonly scanError: ScanError) {
    super(`${scanError.code} ${scanError.file}: ${scanError.detail}`);
  }
}

const fail = (code: ScanError["code"], file: string, detail: string): never => {
  throw new InputError({ code, file, detail: shownText(detail) });
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
    texts.set(file, readCatalogue(dir, file, catalogue));
  }
  const findings: Finding[] = [];
  const add = (file: string, leafPath: string, text: string, reason: string): void => {
    findings.push({ file, path: leafPath, text: shownText(text), reason });
  };
  for (const [file, leaves] of texts) {
    const lang = CATALOGUES[file]!.lang;
    for (const [leafPath, text] of leaves) {
      let masked = text;
      for (const exception of EXCEPTIONS.filter((e) => e.file === file && e.path === leafPath)) {
        // Stale when the literal is gone from the text or the dictionary no longer flags it.
        const live = text.includes(exception.literal) && findForbiddenTerms(exception.literal)[0];
        if (!live) fail("STALE_EXCEPTION", file, `${leafPath}: ${exception.literal}`);
        masked = masked.replaceAll(exception.literal, ".");
      }
      for (const term of findForbiddenTerms(masked)) {
        add(file, leafPath, text, `forbidden term: ${term.entry}`);
      }
      const characters = unreadableCharacters(text);
      if (characters.length > 0) add(file, leafPath, text, `characters: ${characters.join(" ")}`);
      if (lang === "en" && /[čćđšž]/iu.test(text.normalize("NFKC"))) {
        add(file, leafPath, text, "Croatian letter in English text");
      }
    }
  }
  for (const exception of EXCEPTIONS) {
    if (!texts.get(exception.file)?.has(exception.path)) {
      fail("STALE_EXCEPTION", exception.file, `${exception.path}: no such text`);
    }
  }
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
  for (const leafPath of SAME_IN_BOTH) {
    if (!en.has(leafPath)) fail("STALE_SAME_IN_BOTH", "en.ts", `${leafPath}: no such text`);
  }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return fail("UNREADABLE_FILE", file, String(error));
    }
    const keys = walk(file, parsed, "", leaves);
    // JSON.parse keeps the last of two equal keys, so an earlier text would go unread.
    const tokens = raw.match(/"(?:[^"\\]|\\.)*"/g)?.length ?? 0;
    if (tokens !== keys + leaves.size) {
      fail("DUPLICATE_KEY", file, `${tokens} strings for ${keys} keys and ${leaves.size} texts`);
    }
    return leaves;
  }
  const module = evaluate(file, full, raw);
  if (!Object.hasOwn(module, catalogue.table)) {
    fail("UNKNOWN_EXPORT", file, `no export ${catalogue.table}`);
  }
  const table = module[catalogue.table];
  walk(file, table, "", leaves);
  for (const [name, value] of Object.entries(module)) {
    if (name === catalogue.table || value === table) continue;
    if (typeof value === "function") {
      if (!catalogue.functions?.includes(name)) fail("UNKNOWN_EXPORT", file, name);
      continue;
    }
    walk(file, value, name, leaves);
  }
  return leaves;
}

/** A `.ts` catalogue's exports, read as scripts/locales/source-digest.ts reads one; no runtime imports. */
function evaluate(file: string, full: string, raw: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const module = { exports: {} as Record<string, unknown> };
  try {
    vm.runInNewContext(outputText, { module, exports: module.exports }, { filename: full });
  } catch (error) {
    return fail("UNREADABLE_FILE", file, String(error));
  }
  return module.exports;
}

/** Puts every text under `node` into `leaves` and returns the number of keys it went through. */
function walk(file: string, node: unknown, at: string, leaves: Map<string, string>): number {
  if (typeof node === "string") {
    if (leaves.has(at)) fail("DUPLICATE_KEY", file, at);
    leaves.set(at, node);
    return 0;
  }
  // A plain object or an array of any realm (a catalogue runs in its own context); not a Map or a class instance.
  const proto: unknown = typeof node === "object" && node ? Object.getPrototypeOf(node) : undefined;
  const object = proto === null || (proto !== undefined && Object.getPrototypeOf(proto) === null);
  if (
    !Array.isArray(node) &&
    !(object && Object.prototype.toString.call(node) === "[object Object]")
  ) {
    return fail("NOT_TEXT", file, `${at || "(root)"}: ${typeof node}`);
  }
  let keys = 0;
  for (const key of Reflect.ownKeys(node as object)) {
    if (typeof key === "symbol") return fail("NOT_TEXT", file, `${at}: symbol key`);
    if (Array.isArray(node) && key === "length") continue;
    const value = (node as Record<string, unknown>)[key];
    keys += Array.isArray(node) ? 0 : 1;
    keys += walk(file, value, at ? `${at}.${key}` : key, leaves);
  }
  return keys;
}
