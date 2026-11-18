import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { labelMentions, mentionProblems, parseLabels } from "./bot-labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RULES = join(ROOT, ".claude", "rules");
const VALID = '- { name: "bug", color: "d73a4a", description: "Opis" }\n';

function yamlWith(entry: string): string {
  return `${VALID}- ${entry}\n`;
}

describe("labels.yml: every label has a description and a valid shape", () => {
  it.each([
    ["empty file", ""],
    ["null root", "null\n"],
    ["object root", "name: bug\n"],
    ["scalar root", "bug\n"],
    ["invalid yaml", "- { name: [\n"],
    ["duplicate key", '- { name: "x", name: "y", color: "d73a4a", description: "Opis" }\n'],
    [
      "escaped duplicate key",
      '- { "name": "x", name: "y", color: "d73a4a", description: "Opis" }\n',
    ],
    ["empty list", "[]\n"],
    ["comment only", "# samo komentar\n"],
    ["BOM", `\uFEFF${VALID}`],
    ["two documents", `${VALID}---\n${VALID}`],
    [
      "alias",
      '- { name: "x", color: "d73a4a", description: &d "Opis" }\n- { name: "y", color: "d73a4a", description: *d }\n',
    ],
  ])("%s is a problem", (_, text) => {
    expect(parseLabels(text).problems).not.toEqual([]);
  });

  it.each([
    ["missing description", '{ name: "x", color: "d73a4a" }'],
    ["empty description", '{ name: "x", color: "d73a4a", description: "" }'],
    ["spaces only", '{ name: "x", color: "d73a4a", description: "   " }'],
    ["tab only", '{ name: "x", color: "d73a4a", description: "\\t" }'],
    ["NBSP only", '{ name: "x", color: "d73a4a", description: "\\u00a0" }'],
    ["zero width space only", '{ name: "x", color: "d73a4a", description: "\\u200b" }'],
    ["punctuation only", '{ name: "x", color: "d73a4a", description: "..." }'],
    ["zero width space inside", '{ name: "x", color: "d73a4a", description: "a\\u200bb" }'],
    ["bidi mark inside", '{ name: "x", color: "d73a4a", description: "a\\u202eb" }'],
    ["line separator inside", '{ name: "x", color: "d73a4a", description: "a\\u2028b" }'],
    ["binary description", '{ name: "x", color: "d73a4a", description: !!binary T3Bpcw== }'],
    ["null description", '{ name: "x", color: "d73a4a", description: null }'],
    ["number description", '{ name: "x", color: "d73a4a", description: 5 }'],
    ["CR in description", '{ name: "x", color: "d73a4a", description: "a\\rb" }'],
    ["LF in description", '{ name: "x", color: "d73a4a", description: "a\\nb" }'],
    ["tab in description", '{ name: "x", color: "d73a4a", description: "a\\tb" }'],
    ["DEL in description", '{ name: "x", color: "d73a4a", description: "a\\x7fb" }'],
    ["C1 in description", '{ name: "x", color: "d73a4a", description: "a\\x85b" }'],
    ["101 characters", `{ name: "x", color: "d73a4a", description: "${"a".repeat(101)}" }`],
    ["extra key", '{ name: "x", color: "d73a4a", description: "Opis", default: true }'],
    ["__proto__ key", '{ name: "x", color: "d73a4a", description: "Opis", __proto__: "y" }'],
    ["toString key", '{ name: "x", color: "d73a4a", description: "Opis", toString: "y" }'],
    ["constructor key", '{ name: "x", color: "d73a4a", description: "Opis", constructor: "y" }'],
    ["merge key", '{ <<: { default: true }, name: "x", color: "d73a4a", description: "Opis" }'],
    ["scalar entry", '"x"'],
    ["null entry", "null"],
    ["missing name", '{ color: "d73a4a", description: "Opis" }'],
    ["empty name", '{ name: "", color: "d73a4a", description: "Opis" }'],
    ["space in name", '{ name: "a b", color: "d73a4a", description: "Opis" }'],
    ["NBSP in name", '{ name: "a\\u00a0b", color: "d73a4a", description: "Opis" }'],
    ["tab in name", '{ name: "a\\tb", color: "d73a4a", description: "Opis" }'],
    ["DEL in name", '{ name: "a\\x7f", color: "d73a4a", description: "Opis" }'],
    ["51 characters", `{ name: "${"a".repeat(51)}", color: "d73a4a", description: "Opis" }`],
    ["same name in other case", '{ name: "Bug", color: "d73a4a", description: "Opis" }'],
    ["same name", '{ name: "bug", color: "d73a4a", description: "Opis" }'],
    ["upper case name", '{ name: "Good-First", color: "d73a4a", description: "Opis" }'],
    ["star in name", '{ name: "area:*", color: "d73a4a", description: "Opis" }'],
    ["pipe in name", '{ name: "area:a|b", color: "d73a4a", description: "Opis" }'],
    ["two colons in name", '{ name: "a:b:c", color: "d73a4a", description: "Opis" }'],
    ["number color", '{ name: "x", color: 000001, description: "Opis" }'],
    ["short color", '{ name: "x", color: "d73a4", description: "Opis" }'],
    ["color with hash", '{ name: "x", color: "#d73a4a", description: "Opis" }'],
    ["missing color", '{ name: "x", description: "Opis" }'],
  ])("%s is a problem", (_, entry) => {
    const parsed = parseLabels(yamlWith(entry));
    expect(parsed.problems).not.toEqual([]);
    expect(parseLabels(VALID).problems).toEqual([]);
  });

  it("an inherited description does not count", () => {
    const proto = '- { name: "x", color: "d73a4a", __proto__: { description: "Opis" } }\n';
    expect(parseLabels(proto).problems).not.toEqual([]);
    const plain = '- { name: "x", color: "d73a4a" }\n';
    Object.defineProperty(Object.prototype, "description", { value: "Opis", configurable: true });
    try {
      expect(parseLabels(plain).problems).toEqual(["labels.yml[0]: no description"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "description");
    }
  });

  it("a CRLF file reads like the LF file", () => {
    const lf = `${VALID}- { name: "risk:low", color: "0e8a16", description: "Niski rizik" }\n`;
    expect(parseLabels(lf.replaceAll("\n", "\r\n"))).toEqual(parseLabels(lf));
    expect(parseLabels(lf).labels.map((label) => label.name)).toEqual(["bug", "risk:low"]);
  });

  it("100 characters of description and 50 of name are allowed", () => {
    const entry = `{ name: "${"a".repeat(50)}", color: "D73A4A", description: "${"č".repeat(100)}" }`;
    expect(parseLabels(yamlWith(entry)).problems).toEqual([]);
  });
});

describe("label mentions", () => {
  const names = ["bug", "area:db", "risk:low", "ready-for-claude"];

  it.each([
    ["unknown label on a label line", "Stavi labelu `nema-je`.", ["nema-je"]],
    ["unknown namespaced token anywhere", "Razina `risk:nema` vrijedi.", ["risk:nema"]],
    ["one bad alternative", "Labele `area:db|nema`.", ["area:nema"]],
    ["wildcard without any label", "Labele `role:*`.", ["role:*"]],
    ["under a label heading", "## Labele\n\n- `nema`: opis", ["nema"]],
    ["upper-case heading", "## LABELE\n\n- `nema`: opis", ["nema"]],
    ["CRLF lines", "## Labele\r\n\r\n- `nema`: opis\r\n", ["nema"]],
    ["fixed namespace", "Uloga `role:nema` danas.", ["role:nema"]],
    ["unclosed fence ends nothing", "Labela `nema`.\n```\n", ["nema"]],
    [
      "code on a label paragraph (known limit)",
      "Ostaju na labelama (`issuecomment-1`).",
      ["issuecomment-1"],
    ],
    ["upper case is no label shape", "Labela `Bug` i `bug`.", []],
  ])("%s", (_, markdown, missing) => {
    expect(mentionProblems("F.md", markdown, names)).toEqual(
      missing.map((label) => `F.md: \`${label}\` (no such label in .github/labels.yml)`),
    );
  });

  it.each([
    ["two colons", "Labela `claude:b:orchestrator`."],
    ["other namespace", "Uvoz `node:fs` danas."],
    ["header line", "Redak `Risk:` i labela."],
    ["upper case", "Labela `DAN-xxx`."],
    ["fenced code", "## Labele\n\n```\n`nema`\n```\n"],
    ["tilde fence", "Labela:\n~~~\n`nema`\n~~~\n"],
    ["line without the word", "Pokreni `nema-je` danas."],
    ["alternatives without a namespace", "Labele `bug|nema`."],
    ["after an unclosed fence", "```\nLabela `nema`.\n"],
    ["after a label section ends", "## Labele\n\n- `bug`: opis\n\n## Dalje\n\n`nema-je`"],
  ])("%s is not a mention", (_, markdown) => {
    expect(mentionProblems("F.md", markdown, names)).toEqual([]);
  });

  it("expands alternatives and wildcards that exist", () => {
    expect(labelMentions("Labele `area:*`, `area:db|db` i `bug`.", names)).toEqual([
      "area:*",
      "area:db",
      "bug",
    ]);
    expect(mentionProblems("F.md", "Labele `area:*`.", names)).toEqual([]);
  });
});

describe("repository", () => {
  const yaml = readFileSync(join(ROOT, ".github", "labels.yml"), "utf8");
  const parsed = parseLabels(yaml);
  const names = parsed.labels.map((label) => label.name);
  const bots = readFileSync(join(ROOT, "docs", "BOTS.md"), "utf8");
  const files = [
    join(ROOT, "docs", "BOTS.md"),
    join(ROOT, "CLAUDE.md"),
    join(ROOT, "AGENTS.md"),
    ...readdirSync(RULES)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(RULES, name)),
  ];

  it("every mentioned label exists and has a description", () => {
    const problems = files.flatMap((file) =>
      mentionProblems(file.slice(ROOT.length + 1), readFileSync(file, "utf8"), names),
    );
    expect([...parsed.problems, ...problems]).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
  });

  it("docs/BOTS.md mentions every label of labels.yml by name", () => {
    expect(names.filter((name) => !labelMentions(bots, names).includes(name))).toEqual([]);
  });

  it("docs/BOTS.md mentions every label the scope names", () => {
    const mentioned = labelMentions(bots, names);
    for (const label of [
      "ready-for-claude",
      "claude:in-progress",
      "bug",
      "security",
      "plan-napada",
      "pitanje-za-grok",
      "area:*",
      "role:*",
      "risk:*",
    ]) {
      const prefix = label.endsWith(":*") ? label.slice(0, -1) : null;
      expect(mentioned.some((m) => m === label || (prefix !== null && m.startsWith(prefix)))).toBe(
        true,
      );
    }
  });
});
