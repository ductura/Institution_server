// Checks for .github/labels.yml and for the Labele section of docs/BOTS.md
// (S-0.11, DAN-724-1a). The file records the repo's labels; nothing syncs it to
// GitHub.
import { isNode, parseDocument, Parser, visit } from "yaml";

export type Label = { name: string; color: string; description: string };
export type ParsedLabels = { labels: Label[]; problems: string[] };

const KEYS = ["name", "color", "description"];
const WORD = "[a-z0-9]+(?:-[a-z0-9]+)*";
// A name has the shape of a mention, so every label can be mentioned. 50 code
// points of name is a conservative local limit; GitHub documents 100 of description.
const NAME = new RegExp(`^${WORD}(?::${WORD})?$`);
const COLOR = /^[0-9a-f]{6}$/i;
const VISIBLE = /[\p{L}\p{N}]/u;
// Control, format, surrogate, private use, unassigned and line or paragraph separators.
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}]/u;

function entryProblems(entry: unknown, at: string): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${at}: not a mapping`];
  }
  const record = entry as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  const problems = Object.keys(record)
    .filter((key) => !KEYS.includes(key))
    .map((key) => `${at}: unknown key ${JSON.stringify(key)}`);
  const name = own("name");
  const description = own("description");
  if (typeof name !== "string" || [...name].length > 50 || !NAME.test(name)) {
    problems.push(`${at}: invalid name`);
  }
  if (typeof own("color") !== "string" || !COLOR.test(own("color") as string)) {
    problems.push(`${at}: invalid color`);
  }
  if (typeof description !== "string" || !VISIBLE.test(description)) {
    problems.push(`${at}: no description`);
  } else if (INVISIBLE.test(description) || [...description].length > 100) {
    problems.push(`${at}: invalid description`);
  }
  return problems;
}

/** Labels of a labels.yml text; every problem of shape or content is reported. */
export function parseLabels(text: string): ParsedLabels {
  const invalid = { labels: [], problems: ["labels.yml: invalid YAML"] };
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
    return { labels: [], problems: ["labels.yml: not a list of labels"] };
  }
  const labels: Label[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  root.forEach((entry: unknown, index) => {
    const found = entryProblems(entry, `labels.yml[${index}]`);
    problems.push(...found);
    if (found.length > 0) return;
    const label = entry as Label;
    if (seen.has(label.name)) problems.push(`labels.yml[${index}]: duplicate name ${label.name}`);
    seen.add(label.name);
    labels.push({ name: label.name, color: label.color, description: label.description });
  });
  return { labels, problems };
}

const FILE = "docs/BOTS.md";
// A line that, after any whitespace, starts like a list item, a quote, a
// heading, an HTML block or a setext underline. Wider than CommonMark on purpose.
const MARKED = /^\s*(?:[-+*>#<=]|\d+[.)])/u;
const ITEM = /^- `([^`]+)`: \S(?:.*\S)?$/u;

/**
 * Problems of the Labele section of docs/BOTS.md: it starts at the one line
 * that is exactly `## Labele` and ends at the next line that starts with `#`.
 * Fences are not read. Every line of it marked as a list item must be exactly
 * "- `name`: text" for a label of `names`, and every label has one such line.
 */
export function labelListProblems(markdown: string, names: readonly string[]): string[] {
  const lines = markdown.split("\n").map((line) => line.replace(/\r$/u, ""));
  const at = (index: number): string => `${FILE}:${index + 1}`;
  const raw = [
    ...lines.flatMap((line, i) => (line.includes("﻿") ? [`${at(i)}: BOM`] : [])),
    ...lines.flatMap((line, i) => (line.includes("\r") ? [`${at(i)}: lone CR`] : [])),
  ];
  if (raw.length > 0) return raw;
  const starts = lines.flatMap((line, i) => (line === "## Labele" ? [i] : []));
  const start = starts[0];
  if (starts.length !== 1 || start === undefined) {
    return [`${FILE}: ${starts.length} lines \`## Labele\`, expected exactly 1`];
  }
  const known = new Set(names);
  const listed = new Set<string>();
  const problems: string[] = [];
  for (let i = start + 1; i < lines.length && !(lines[i] ?? "").startsWith("#"); i += 1) {
    const line = lines[i] ?? "";
    if (!MARKED.test(line)) continue;
    const name = INVISIBLE.test(line) ? undefined : ITEM.exec(line)?.[1];
    if (name === undefined) problems.push(`${at(i)}: malformed line`);
    else if (!known.has(name)) problems.push(`${at(i)}: no such label \`${name}\``);
    else if (listed.has(name)) problems.push(`${at(i)}: duplicate item \`${name}\``);
    else listed.add(name);
  }
  const missing = names.filter((name) => !listed.has(name));
  return [...problems, ...missing.map((name) => `${FILE}: no item for \`${name}\``)];
}
