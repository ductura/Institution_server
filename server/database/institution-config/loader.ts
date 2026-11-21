/**
 * SRV-1405: the loader of the rules of every faculty,
 * `config/faculties/<faculty>/rules.json`, checked against the closed schema
 * (`./schema.ts`) once, when the server starts.
 *
 * A file that cannot be read, is not JSON, does not pass the schema or names
 * another faculty than its directory refuses the whole start: the server
 * reports `faculty rules are refused: <CODE> <faculty>/rules.json [field]` and
 * exits with EX_CONFIG, the same as for a bad environment (server.ts, step 1).
 * The line carries the code, the file and the place in it, never a value.
 *
 * A faculty without the file has no rules here (its directory may hold only
 * declaration forms). The production image carries only the bundle, so there
 * the directory is missing and no faculty has file rules; the versions an
 * administrator publishes are in the database (`app.institution_config`).
 */
import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

import {
  FACULTY_RULES_MAX_BYTES,
  FACULTY_SLUG_PATTERN,
  facultyRulesFileSchema,
  issueField,
  type FacultyRules,
} from "./schema.ts";

/** Relative to the working directory of the server, as for the AI setting. */
export const FACULTY_CONFIG_DIR = "config/faculties";
export const FACULTY_RULES_FILE = "rules.json";

export const FACULTY_RULES_ERROR_CODES = [
  "FACULTY_RULES_UNREADABLE",
  "FACULTY_RULES_TOO_LARGE",
  "FACULTY_RULES_NOT_JSON",
  "FACULTY_RULES_SCHEMA",
  "FACULTY_RULES_FACULTY_MISMATCH",
] as const;
export type FacultyRulesErrorCode = (typeof FACULTY_RULES_ERROR_CODES)[number];

export type FacultyRulesError = {
  readonly code: FacultyRulesErrorCode;
  readonly messageKey: string;
  /** `<faculty>/rules.json`, relative to the configuration directory. */
  readonly file: string;
  /** The place of a schema issue (`rules.workLanguages.1`), else empty. */
  readonly field: string;
};

export type FacultyRulesCatalog = {
  /** The faculties with a rules file, sorted. */
  readonly faculties: readonly string[];
  /** The file rules of a faculty, or null without a file. */
  rulesOf(slug: string | null): FacultyRules | null;
};

export type FacultyRulesResult =
  | { readonly ok: true; readonly value: FacultyRulesCatalog }
  | { readonly ok: false; readonly error: FacultyRulesError };

function refused(code: FacultyRulesErrorCode, file: string, field = ""): FacultyRulesResult {
  return {
    ok: false,
    error: { code, messageKey: `facultyRules.${code.toLowerCase()}`, file, field },
  };
}

/** A catalogue over rules already checked; for tests and the loader. */
export function facultyRulesCatalogOf(
  bySlug: ReadonlyMap<string, FacultyRules>,
): FacultyRulesCatalog {
  const copy = new Map(bySlug);
  return Object.freeze({
    faculties: Object.freeze([...copy.keys()].sort()),
    rulesOf: (slug: string | null) => (slug === null ? null : (copy.get(slug) ?? null)),
  });
}

function directories(root: string): Dirent[] | null {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

/** Every `<faculty>/rules.json` under `root`, or the first refusal in faculty order. */
export function loadFacultyRules(root: string): FacultyRulesResult {
  const entries = directories(root);
  const bySlug = new Map<string, FacultyRules>();
  if (entries === null) return { ok: true, value: facultyRulesCatalogOf(bySlug) };
  const slugs = entries
    .filter((entry) => entry.isDirectory() && FACULTY_SLUG_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const slug of slugs) {
    const file = `${slug}/${FACULTY_RULES_FILE}`;
    const path = join(root, slug, FACULTY_RULES_FILE);
    let text: string;
    try {
      const metadata = lstatSync(path, { throwIfNoEntry: false });
      if (metadata === undefined) continue;
      if (!metadata.isFile()) return refused("FACULTY_RULES_UNREADABLE", file);
      if (metadata.size > FACULTY_RULES_MAX_BYTES) return refused("FACULTY_RULES_TOO_LARGE", file);
      text = readFileSync(path, "utf8");
    } catch {
      return refused("FACULTY_RULES_UNREADABLE", file);
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      return refused("FACULTY_RULES_NOT_JSON", file);
    }
    const parsed = facultyRulesFileSchema.safeParse(input);
    if (!parsed.success) return refused("FACULTY_RULES_SCHEMA", file, issueField(parsed.error));
    if (parsed.data.faculty !== slug)
      return refused("FACULTY_RULES_FACULTY_MISMATCH", file, "faculty");
    bySlug.set(
      slug,
      Object.freeze({
        ...parsed.data.rules,
        workLanguages: [...parsed.data.rules.workLanguages],
      }),
    );
  }
  return { ok: true, value: facultyRulesCatalogOf(bySlug) };
}

/** The startup problem of the faculty rules, by code and file only; empty when they load. */
export function facultyRulesProblems(root: string = resolve(FACULTY_CONFIG_DIR)): string[] {
  const loaded = loadFacultyRules(root);
  if (loaded.ok) return [];
  const { code, file, field } = loaded.error;
  return [`faculty rules are refused: ${code} ${file}${field === "" ? "" : ` ${field}`}`];
}
