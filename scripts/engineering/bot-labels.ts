// Checks for .github/labels.yml and for the labels that docs/BOTS.md and the
// agent rules (CLAUDE.md, AGENTS.md, .claude/rules) mention (S-0.11, DAN-724).
// The file records the repo's labels; nothing syncs it to GitHub.
import { parseDocument } from "yaml";

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
  // would turn merge keys back on) or a warning is no valid labels.yml.
  const doc = parseDocument(text, { version: "1.2", merge: false, logLevel: "error" });
  const tags = Object.keys(doc.directives?.tags ?? {}).filter((tag) => tag !== "!!");
  if (doc.errors.length + doc.warnings.length + tags.length > 0) return invalid;
  if (doc.directives?.yaml.explicit === true) return invalid;
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
 * Labels a Markdown text mentions: label-shaped inline code outside fenced
 * blocks, on a line that contains "label" or in a section whose heading does,
 * or with a label namespace on any line. `x:a|b` is `x:a` and `x:b`; `x:*` stays.
 */
export function labelMentions(markdown: string, names: readonly string[]): string[] {
  const namespaces = new Set([...NAMESPACES, ...names.map((name) => name.split(":")[0] ?? "")]);
  const mentions = new Set<string>();
  let fence = "";
  let section = 0;
  for (const line of markdown.split(/\r?\n/u)) {
    // CommonMark fences: a backtick opener's info string has no backtick, and
    // a closer is the same character, at least as long, with nothing after it.
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== "") {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) {
        fence = "";
      }
      continue;
    }
    if (open?.[1] !== undefined && !(open[1][0] === "`" && (open[2] ?? "").includes("`"))) {
      fence = open[1];
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/u.exec(line)?.[1]?.length;
    if (heading !== undefined && (section === 0 || heading <= section)) {
      section = /label/iu.test(line) ? heading : 0;
    }
    const context = section !== 0 || /label/iu.test(line);
    for (const span of line.matchAll(/(`+)(.+?)\1/gu)) {
      const token = TOKEN.exec((span[2] ?? "").trim());
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
