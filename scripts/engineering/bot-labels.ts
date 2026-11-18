// Checks for .github/labels.yml and for the labels that docs/BOTS.md and the
// agent rules (CLAUDE.md, AGENTS.md, .claude/rules) mention (S-0.11, DAN-724).
// The file records the repo's labels; nothing syncs it to GitHub.
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
/** Namespaces whose inline code counts as a label mention on any line. */
const NAMESPACES = ["area", "role", "risk", "claude"];
const TOKEN = new RegExp(`^(${WORD})(?::(\\*|${WORD}(?:\\|${WORD})*))?$`);

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

/**
 * Inline code spans of one line, as in CommonMark: a backtick run opens a span
 * only if a later run has the same length; otherwise it is text.
 */
function codeSpans(line: string): string[] {
  const runs = [...line.matchAll(/`+/gu)].map((m) => ({ at: m.index, length: m[0].length }));
  const spans: string[] = [];
  for (let i = 0; i < runs.length;) {
    const open = runs[i];
    const close = runs.findIndex((run, j) => j > i && run.length === open?.length);
    if (open === undefined || close === -1) {
      i += 1;
      continue;
    }
    spans.push(line.slice(open.at + open.length, runs[close]?.at));
    i = close + 1;
  }
  return spans;
}

// Block quote and list item markers in front of a fence.
const CONTAINER = /^(?: {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*/u;

/**
 * Lines inside fenced code. Stricter than CommonMark, so that a fence can only
 * hide too little: an opener (after container markers, at most 3 spaces; a
 * backtick opener's info string has no backtick) hides nothing unless a closer
 * follows, and a closer (the same character, at least as long, nothing after
 * it) counts at any indent.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = lines.map(() => false);
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec((lines[i] ?? "").replace(CONTAINER, ""));
    const marker = open?.[1];
    if (marker === undefined || (marker[0] === "`" && (open?.[2] ?? "").includes("`"))) continue;
    const close = lines.findIndex((line, j) => {
      const run = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(line.replace(CONTAINER, ""))?.[1];
      return j > i && run !== undefined && run[0] === marker[0] && run.length >= marker.length;
    });
    if (close === -1) continue;
    fenced.fill(true, i, close + 1);
    i = close;
  }
  return fenced;
}

/**
 * Labels a Markdown text mentions: label-shaped inline code outside fenced
 * blocks, on a line that contains "label" or in a section whose heading does,
 * or with a label namespace on any line. `x:a|b` is `x:a` and `x:b`; `x:*` stays.
 * With `section`, only mentions in the first section whose heading text is
 * exactly `section`, its subsections included.
 */
export function labelMentions(
  markdown: string,
  names: readonly string[],
  options: { section?: string } = {},
): string[] {
  const prefixed = names.filter((name) => name.includes(":"));
  const namespaces = new Set([...NAMESPACES, ...prefixed.map((name) => name.split(":")[0] ?? "")]);
  const mentions = new Set<string>();
  const lines = markdown.split(/\r?\n/u);
  const fenced = fencedLines(lines);
  let section = 0;
  // For `options.section`: 0 before it, its heading level inside it, -1 after it.
  let target = 0;
  for (const [index, line] of lines.entries()) {
    if (fenced[index] === true) continue;
    const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/u.exec(line)?.[1]?.length;
    if (heading !== undefined && (section === 0 || heading <= section)) {
      section = /label/iu.test(line) ? heading : 0;
    }
    if (heading !== undefined && target > 0 && heading <= target) target = -1;
    const text = line
      .replace(/^ {0,3}#{1,6}/u, "")
      .replace(/[ \t]+#+[ \t]*$/u, "")
      .trim();
    if (heading !== undefined && target === 0 && text === options.section) target = heading;
    if (options.section !== undefined && target <= 0) continue;
    const context = section !== 0 || target > 0 || /label/iu.test(line);
    for (const span of codeSpans(line)) {
      const token = TOKEN.exec(span.trim());
      if (token === null) continue;
      const [, prefix = "", rest] = token;
      if (!context && (rest === undefined || !namespaces.has(prefix))) continue;
      const alternatives = rest === undefined ? [""] : rest.split("|");
      for (const alt of alternatives) mentions.add(alt === "" ? prefix : `${prefix}:${alt}`);
    }
  }
  return [...mentions];
}

/** Mentions in `markdown` that name no label of `names`. */
export function mentionProblems(
  file: string,
  markdown: string,
  names: readonly string[],
): string[] {
  return labelMentions(markdown, names)
    .filter((label) =>
      label.endsWith(":*")
        ? !names.some((name) => name.startsWith(label.slice(0, -1)))
        : !names.includes(label),
    )
    .map((label) => `${file}: \`${label}\` (no such label in .github/labels.yml)`);
}
