// Checks for .github/labels.yml (S-0.11, DAN-724-1a-i-2). The file records the
// repo's labels; nothing syncs it to GitHub. Errors are { code, messageKey }
// (docs/CODE_STYLE.md §8); their Croatian texts are `labels.*` in locales/hr.json.
import { isNode, parseDocument, Parser, visit } from "yaml";

export const LABEL_ERROR_CODES = [
  "LABELS_INVALID_YAML",
  "LABELS_NOT_A_LIST",
  "LABEL_NOT_A_MAPPING",
  "LABEL_UNKNOWN_KEY",
  "LABEL_INVALID_NAME",
  "LABEL_INVALID_COLOR",
  "LABEL_NO_DESCRIPTION",
  "LABEL_INVALID_DESCRIPTION",
  "LABEL_DUPLICATE_NAME",
] as const;
export type LabelErrorCode = (typeof LABEL_ERROR_CODES)[number];
/** `at` is the index of the record, or null for the whole file. */
export type LabelError = { code: LabelErrorCode; messageKey: string; at: number | null };
export type Label = { name: string; color: string; description: string };
export type ParsedLabels = { labels: Label[]; problems: LabelError[] };

const error = (code: LabelErrorCode, at: number | null): LabelError => ({
  code,
  messageKey: `labels.${code.toLowerCase()}`,
  at,
});

const KEYS = ["name", "color", "description"];
const WORD = "[a-z0-9]+(?:-[a-z0-9]+)*";
// A name is one or two lower-case words joined by a colon. 50 code points of
// name is a conservative local limit; GitHub documents 100 of description.
const NAME = new RegExp(`^${WORD}(?::${WORD})?$`);
const COLOR = /^[0-9a-f]{6}$/i;
// The only characters of a description: Latin letters (Script=Latin and a
// letter, so no Roman numeral such as U+2160), printable ASCII (digits,
// punctuation, space) and §, which a repo label uses. Nothing else, so no
// character that renders blank or hides text can pass.
// Each class is the intersection by lookahead, one way per character.
const ALLOWED = /^(?:(?=[\p{L} -~§])[\p{Script=Latin} -~§])*$/u;
const LETTER_OR_DIGIT = /(?=[\p{L}0-9])[\p{Script=Latin}0-9]/u;

function entryProblems(entry: unknown, at: number): LabelError[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [error("LABEL_NOT_A_MAPPING", at)];
  }
  const record = entry as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  // One problem per code and record, so a record has at most four problems
  // however many keys it has.
  const unknown = Object.keys(record).some((key) => !KEYS.includes(key));
  const problems = unknown ? [error("LABEL_UNKNOWN_KEY", at)] : [];
  const name = own("name");
  const color = own("color");
  const description = own("description");
  if (typeof name !== "string" || [...name].length > 50 || !NAME.test(name)) {
    problems.push(error("LABEL_INVALID_NAME", at));
  }
  if (typeof color !== "string" || !COLOR.test(color))
    problems.push(error("LABEL_INVALID_COLOR", at));
  if (typeof description !== "string") {
    problems.push(error("LABEL_NO_DESCRIPTION", at));
  } else if (!ALLOWED.test(description) || [...description].length > 100) {
    problems.push(error("LABEL_INVALID_DESCRIPTION", at));
  } else if (!LETTER_OR_DIGIT.test(description)) {
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
  const tokens = [...new Parser().parse(text)];
  if (tokens.some((token) => token.type === "directive")) return invalid;
  let tagged = false;
  visit(doc, (_, node) => {
    if (isNode(node) && node.tag !== undefined) tagged = true;
  });
  if (tagged) return invalid;
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
