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
    [
      "YAML 1.1 directive with a merge key",
      '%YAML 1.1\n---\n- { <<: { description: "Opis", name: "x" }, color: "d73a4a" }\n',
    ],
    ["YAML 1.2 directive", `%YAML 1.2\n---\n${VALID}`],
    ["TAG directive", `%TAG !x! tag:x.invalid,2026:\n---\n${VALID}`],
    ["unknown tag (a warning)", '- { name: "x", color: "d73a4a", description: !foo "Opis" }\n'],
    ["!!merge key", '- { !!merge <<: { description: "Opis" }, name: "x", color: "d73a4a" }\n'],
    ["!!merge key, block", "- !!merge <<:\n    description: Opis\n  name: x\n  color: d73a4a\n"],
    [
      "verbatim merge tag",
      '- { !<tag:yaml.org,2002:merge> <<: { description: "Opis" }, name: "x", color: "d73a4a" }\n',
    ],
    ["!!str tag", '- { name: "x", color: "d73a4a", description: !!str "Opis" }\n'],
    ["%TAG redefining !!", `%TAG !! tag:x.invalid,2026:\n---\n${VALID}`],
    ["%TAG repeating !!", `%TAG !! tag:yaml.org,2002:\n---\n${VALID}`],
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
    ["paragraph separator inside", '{ name: "x", color: "d73a4a", description: "a\\u2029b" }'],
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
    [
      "description only from a merge key",
      '{ <<: { description: "Opis" }, name: "x", color: "d73a4a" }',
    ],
    ["lone surrogate", '{ name: "x", color: "d73a4a", description: "a\\ud800" }'],
    ["private use", '{ name: "x", color: "d73a4a", description: "a\\ue000" }'],
    ["unassigned", '{ name: "x", color: "d73a4a", description: "a\\u0378" }'],
    [
      "101 code points, astral",
      `{ name: "x", color: "d73a4a", description: "a${"😀".repeat(100)}" }`,
    ],
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
    ["seven-digit color", '{ name: "x", color: "d73a4a0", description: "Opis" }'],
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
    const astral = `{ name: "x", color: "d73a4a", description: "a${"😀".repeat(99)}" }`;
    expect(parseLabels(yamlWith(astral)).problems).toEqual([]);
    const digits = '{ name: "x", color: "d73a4a", description: "2026" }';
    expect(parseLabels(yamlWith(digits)).problems).toEqual([]);
    const numeral = '{ name: "x", color: "d73a4a", description: "Ⅻ" }';
    expect(parseLabels(yamlWith(numeral)).problems).toEqual([]);
    expect(parseLabels(`---\n# komentar\n${VALID}...\n`).problems).toEqual([]);
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
    ["deeper heading stays in the section", "## Labele\n\n### Pod\n\n- `nema`", ["nema"]],
    ["NBSP after # is no heading", "## Labele\n\n##\u00a0Dalje\n\n- `nema`", ["nema"]],
    [
      "inline triple backticks are no fence",
      "```nema``` je labela.\nLabela `nema2`.",
      ["nema", "nema2"],
    ],
    ["four spaces of indent are no fence", "    ```\nLabela `nema`.\n", ["nema"]],
    ["a tab before ``` is no fence", "\t```\nLabela `nema`.\n", ["nema"]],
    ["a longer closer closes", "```\n````\nLabela `nema`.", ["nema"]],
    ["a closer with a trailing tab closes", "```\n```\t\nLabela `nema`.", ["nema"]],
    ["a CRLF closer closes", "```\r\nx\r\n```\r\nLabela `nema`.", ["nema"]],
    ["a CRLF closer after an LF opener closes", "```\nx\n```\r\nLabela `nema`.", ["nema"]],
    ["seven # are no heading", "## Labele\n\n####### x\n\n- `nema`", ["nema"]],
    ["double backtick span", "Labela `` nema ``.", ["nema"]],
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
    ["fence not closed by a shorter one", "````\n```\nLabela `nema`.\n````\n"],
    ["fence not closed by the other character", "```\n~~~\nLabela `nema`.\n```\n"],
    ["fence not closed by an opener with info", "```\n```js\nLabela `nema`.\n```\n"],
    ["next line of a paragraph (known limit: lines)", "Stavi labelu\n`nema-je` na issue."],
    ["a closer indented by four is no closer", "```\n    ```\nLabela `nema`.\n```\n"],
    ["an empty heading ends the section", "## Labele\n\n##\n\n`nema-je`"],
    ["seven # open no section", "####### Labele\n\n- `nema`"],
    ["a label without a namespace gives none", "Vidi `bug:x` danas."],
    ["after a label section ends", "## Labele\n\n- `bug`: opis\n\n## Dalje\n\n`nema-je`"],
  ])("%s is not a mention", (_, markdown) => {
    expect(mentionProblems("F.md", markdown, names)).toEqual([]);
  });

  it.each([
    ["an unclosed double run", "Labela `` pa `nema`."],
    ["an unclosed triple run", "Labela ``` pa `nema`."],
    ["a run longer than any closer", "Labela ```` x `` pa `nema`."],
    ["runs of other lengths before the span", "Labela `` x ``` y `nema`."],
  ])("a backtick run without a closer of its length is text: %s", (_, markdown) => {
    expect(mentionProblems("F.md", markdown, names)).toEqual([
      "F.md: `nema` (no such label in .github/labels.yml)",
    ]);
  });

  it("finds several spans on a line and keeps inner backticks in a span", () => {
    expect(labelMentions("Labele `bug`, ``area:db`` i `` a`b `` te `nema`.", names)).toEqual([
      "bug",
      "area:db",
      "nema",
    ]);
  });

  it.each([
    ["H1 before the line", "## Labele\n\n- `bug`\n\n# Dodatak\n\n- `risk:low`", ["bug"]],
    ["H2 before the line", "## Labele\n\n- `bug`\n\n## Dalje\n\n- `risk:low`", ["bug"]],
    ["H3 keeps the section", "## Labele\n\n### Pod\n\n- `risk:low`", ["risk:low"]],
    ["a fenced # keeps it", "## Labele\n\n```\n# x\n```\n\n- `risk:low`", ["risk:low"]],
    ["a label line outside", "Labela `bug`, razina `risk:low`.", []],
  ])("sections only: %s", (_, markdown, expected) => {
    expect(labelMentions(markdown, names, { sectionsOnly: true })).toEqual(expected);
  });

  it("without sectionsOnly a namespace counts outside the section", () => {
    const markdown = "## Labele\n\n- `bug`\n\n# Dodatak\n\n- `risk:low`";
    expect(labelMentions(markdown, names)).toEqual(["bug", "risk:low"]);
  });

  it("the fixed namespaces need no label of that namespace", () => {
    const text = "Vidi `claude:nema`, `area:nema`, `risk:nema` i `role:nema`.";
    expect(mentionProblems("F.md", text, [])).toHaveLength(4);
  });

  it("a wildcard needs a label of exactly that namespace", () => {
    expect(mentionProblems("F.md", "Labele `bu:*`.", ["bug", "bux:y"])).toEqual([
      "F.md: `bu:*` (no such label in .github/labels.yml)",
    ]);
  });

  it("namespaces come from labels.yml too", () => {
    expect(mentionProblems("F.md", "Vidi `foo:nema`.", [...names, "foo:x"])).toEqual([
      "F.md: `foo:nema` (no such label in .github/labels.yml)",
    ]);
    expect(mentionProblems("F.md", "Vidi `foo:nema`.", names)).toEqual([]);
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

  it("the Labele section of docs/BOTS.md names every label of labels.yml", () => {
    const listed = labelMentions(bots, names, { sectionsOnly: true });
    expect(names.filter((name) => !listed.includes(name))).toEqual([]);
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
