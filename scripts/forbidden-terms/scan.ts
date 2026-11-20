/**
 * The scan of every interface text in locales/** (S-1L.1, DAN-768, PR-b2; Ductus#1836 c.6890523605, c.6890541239).
 * Every file is on a closed list; every leaf is read and checked, or the scan fails with an input error.
 */
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { shownText, unreadableCharacters } from "./characters.ts";
import { findForbiddenTerms, foldText, type ForbiddenTerm } from "./terms.ts";

/** `table` is the export of a `.ts` catalogue that holds it. */
type Catalogue = Readonly<{ lang: "hr" | "en"; table?: string }>;

/** Every catalogue under locales/, by file name. */
export const CATALOGUES: Readonly<Record<string, Catalogue>> = {
  "hr.ts": { lang: "hr", table: "messagesHr" },
  "en.ts": { lang: "en", table: "messagesEn" },
  "hr.json": { lang: "hr" },
  "receipt-pdf.ts": { lang: "hr", table: "receiptPdfHr" },
};

/** Files under locales/ that are not interface text, with the reason. `*.test.ts` are tests. */
export const NOT_CATALOGUES: Readonly<Record<string, string>> = {
  "index.ts": "re-exports the catalogues, holds no text",
  "parity.ts": "compares the keys of hr and en, holds no text",
  "source.ts": "keeps the Ductus source texts (SOURCE_TEXT_CHANGES) as a record, not as interface",
  "test-leaves.ts": "test helper, holds no text",
  "text-of.ts": "reads a text from a table by key, holds no text",
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
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    fail("UNREADABLE_FILE", "locales", "the folder cannot be listed");
  }
  for (const entry of entries) {
    const name = path.relative(dir, path.join(entry.parentPath, entry.name));
    const listed = Object.hasOwn(CATALOGUES, name) || Object.hasOwn(NOT_CATALOGUES, name);
    if (!entry.isFile() || !(listed || /^[^/\\]+\.test\.ts$/.test(name)))
      fail("UNLISTED_FILE", name, "not a file on CATALOGUES or NOT_CATALOGUES");
  }
  const texts = new Map<string, Map<string, string>>();
  for (const [file, catalogue] of Object.entries(CATALOGUES)) {
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
      if (lang === "en" && /[čćđšž]|\p{M}/iu.test(text.normalize("NFKC")))
        add(file, leafPath, text, "Croatian letter in English text");
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
    if (tokens !== keys + leaves.size)
      fail("DUPLICATE_KEY", file, `${tokens} strings for ${keys} keys and ${leaves.size} texts`);
    return leaves;
  }
  const exports = readSource(file, raw);
  if (!exports.has(catalogue.table)) fail("UNKNOWN_EXPORT", file, catalogue.table);
  const table = exports.get(catalogue.table);
  for (const [name, value] of exports) {
    if (name !== catalogue.table && value === table) continue;
    walk(file, value, name === catalogue.table ? "" : name, leaves);
  }
  return leaves;
}

/** Strips what only TypeScript sees: `as`, `satisfies`, `<T>`, `!` and parentheses. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

/**
 * The exports of a `.ts` catalogue, read from its syntax tree (DAN-774); no line of it runs, so no getter,
 * Proxy, prototype or call can show the app other text than the scan reads. A catalogue is type-only imports,
 * types, and `const` declarations whose values are strings, templates of strings, object and array literals
 * and earlier constants; anything else is an input error.
 */
function readSource(file: string, raw: string): Map<string, unknown> {
  const options = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
  const { diagnostics } = ts.transpileModule(raw, {
    reportDiagnostics: true,
    compilerOptions: options,
  });
  if (diagnostics !== undefined && diagnostics.length > 0)
    fail("UNREADABLE_FILE", file, "the catalogue does not parse");
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const line = (node: ts.Node): string =>
    `line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const consts = new Map<string, unknown>();
  const exports = new Map<string, unknown>();

  const valueOf = (expression: ts.Expression): unknown => {
    const node = unwrap(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node) && consts.has(node.text)) return consts.get(node.text);
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = valueOf(span.expression);
        if (typeof part !== "string") fail("NOT_TEXT", file, `${line(span)}: not a text`);
        text += `${part as string}${span.literal.text}`;
      }
      return text;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map((element) =>
        ts.isOmittedExpression(element) || ts.isSpreadElement(element)
          ? fail("NOT_TEXT", file, `${line(node)}: not a dense array literal`)
          : valueOf(element),
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      // Built with no prototype, so no key, `__proto__` included, can reach one.
      const object = Object.create(null) as Record<string, unknown>;
      for (const property of node.properties) {
        const { name } = property;
        const key = name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : "";
        // A `__proto__: x` literal sets the prototype instead of a key.
        if (!ts.isPropertyAssignment(property) || key === "" || key === "__proto__")
          return fail("NOT_TEXT", file, `${line(property)}: not a key with a value`);
        if (Object.hasOwn(object, key)) fail("DUPLICATE_KEY", file, `${line(property)}: ${key}`);
        object[key] = valueOf(property.initializer);
      }
      return object;
    }
    return fail("NOT_TEXT", file, `${line(node)}: ${ts.SyntaxKind[node.kind]}`);
  };

  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) continue;
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const flags = ts.isVariableStatement(statement) ? statement.declarationList.flags : 0;
    const data =
      ts.isVariableStatement(statement) &&
      (flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const &&
      modifiers.every((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!data) {
      const name = ts.isFunctionDeclaration(statement) ? (statement.name?.text ?? "") : "";
      const exporting =
        exported || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement);
      fail(
        exporting ? "UNKNOWN_EXPORT" : "UNREADABLE_FILE",
        file,
        `${line(statement)}: not data ${name}`,
      );
    }
    for (const declaration of (statement as ts.VariableStatement).declarationList.declarations) {
      const { name, initializer } = declaration;
      if (!ts.isIdentifier(name) || initializer === undefined)
        return fail("NOT_TEXT", file, `${line(declaration)}: not a named constant`);
      if (consts.has(name.text)) fail("DUPLICATE_KEY", file, `${line(declaration)}: ${name.text}`);
      const value = valueOf(initializer);
      consts.set(name.text, value);
      if (exported) exports.set(name.text, value);
    }
  }
  return exports;
}

/** Puts every text under `node` into `leaves` and returns the number of keys it went through. */
function walk(file: string, node: unknown, at: string, leaves: Map<string, string>): number {
  if (typeof node === "string") {
    if (leaves.has(at)) fail("DUPLICATE_KEY", file, at);
    leaves.set(at, node);
    return 0;
  }
  // Only JSON.parse output and the values readSource builds come here: strings, dense arrays, plain objects.
  if (typeof node !== "object" || node === null)
    return fail("NOT_TEXT", file, `${at || "(root)"}: ${node === null ? "null" : typeof node}`);
  const array = Array.isArray(node);
  const entries = array
    ? node.map((value, i) => [String(i), value] as const)
    : Object.entries(node);
  let keys = 0;
  for (const [key, value] of entries) {
    keys += array ? 0 : 1;
    keys += walk(file, value, at ? `${at}.${key}` : key, leaves);
  }
  return keys;
}
