// Checks for .github/labels.yml (S-0.11, DAN-724-2a2); nothing syncs it to GitHub. Errors are
// { code, messageKey } (CODE_STYLE §8), with Croatian texts `labels.*` in locales/hr.json.
import { Lexer, parseDocument } from "yaml";

export const LABEL_ERROR_CODES = [
  "LABELS_INVALID_YAML",
  "LABELS_NOT_A_LIST",
  "LABEL_NOT_A_MAPPING",
  "LABEL_UNKNOWN_KEY",
  "LABEL_INVALID_NAME",
  "LABEL_INVALID_COLOR",
  "LABEL_NO_DESCRIPTION",
  "LABEL_DUPLICATE_NAME",
] as const;
export type LabelErrorCode = (typeof LABEL_ERROR_CODES)[number];
/** `at` is the index of the record, or null for the whole file. */
export type LabelError = { code: LabelErrorCode; messageKey: string; at: number | null };
export type Label = { name: string; color: string; description: string };
export type ParsedLabels = { labels: Label[]; problems: LabelError[] };

const error = (code: LabelErrorCode, at: number | null): LabelError => {
  return { code, messageKey: `labels.${code.toLowerCase()}`, at };
};

const KEYS = ["name", "color", "description"];
const WORD = "[a-z0-9]+(?:-[a-z0-9]+)*";
// A name is one or two lower-case words joined by a colon. 50 code points of
// name is a conservative local limit.
const NAME = new RegExp(`^${WORD}(?::${WORD})?$`);
const COLOR = /^[0-9a-f]{6}$/i;

function entryProblems(entry: unknown, at: number): LabelError[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [error("LABEL_NOT_A_MAPPING", at)];
  }
  const record = entry as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  // One problem per code and record: at most four, however many keys it has.
  const unknown = Object.keys(record).some((key) => !KEYS.includes(key));
  const problems = unknown ? [error("LABEL_UNKNOWN_KEY", at)] : [];
  const [name, color, description] = KEYS.map(own);
  if (typeof name !== "string" || [...name].length > 50 || !NAME.test(name)) {
    problems.push(error("LABEL_INVALID_NAME", at));
  }
  if (typeof color !== "string" || !COLOR.test(color))
    problems.push(error("LABEL_INVALID_COLOR", at));
  // Only that there is a description here; which characters it may have is
  // DAN-724-1a-i-2a″.
  if (typeof description !== "string" || !/\S/u.test(description)) {
    problems.push(error("LABEL_NO_DESCRIPTION", at));
  }
  return problems;
}

/** Labels of a labels.yml text; a record with any problem is no label. */
export function parseLabels(text: string): ParsedLabels {
  const invalid = { labels: [], problems: [error("LABELS_INVALID_YAML", null)] };
  // A BOM, a second document, an alias, a merge key, a directive (%YAML 1.1
  // would turn merge keys back on), an explicit tag (`!!merge <<` is a merge
  // key even with merge: false) or a warning is no valid labels.yml.
  const doc = parseDocument(text, { version: "1.2", merge: false, logLevel: "error" });
  if (doc.errors.length + doc.warnings.length > 0) return invalid;
  // A BOM, a directive and an explicit tag are lexer tokens of their own, which
  // parseDocument may drop without an error (`!<>` leaves no tag on its node).
  const banned = (token: string) => token === "\u{FEFF}" || /^[%!]/u.test(token);
  if ([...new Lexer().lex(text)].some(banned)) return invalid;
  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return invalid;
  }
  if (!Array.isArray(root) || root.length === 0) {
    return { labels: [], problems: [error("LABELS_NOT_A_LIST", null)] };
  }
  const labels: Label[] = [];
  const problems: LabelError[] = [];
  const seen = new Set<string>();
  root.forEach((entry: unknown, index) => {
    const found = entryProblems(entry, index);
    problems.push(...found);
    if (found.length > 0) return;
    const label = entry as Label;
    if (seen.has(label.name)) {
      problems.push(error("LABEL_DUPLICATE_NAME", index));
      return;
    }
    seen.add(label.name);
    labels.push({ name: label.name, color: label.color, description: label.description });
  });
  return { labels, problems };
}
