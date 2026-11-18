import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { labelListProblems, parseLabels } from "./bot-labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
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

describe("the Labele section of docs/BOTS.md lists every label exactly once", () => {
  const names = ["bug", "risk:low"];
  const list = "- `bug`: kvar\n- `risk:low`: niski rizik\n";
  const doc = (section: string, before = "# Botovi\n\n"): string =>
    `${before}## Labele\n\nPopis labela.\n\n${section}`;

  it.each([
    [
      "an item under ### Primjeri labela",
      "- `bug`: kvar\n\n### Primjeri labela\n\n- `risk:low`: x\n",
    ],
    [
      "an item under ## Povijest labela",
      "- `bug`: kvar\n\n## Povijest labela\n\n- `risk:low`: x\n",
    ],
    ["# Dodatak before an item", "- `bug`: kvar\n\n# Dodatak\n\n- `risk:low`: x\n"],
    ["a fenced ## Primjer", "```md\n## Primjer\n```\n\n- `bug`: kvar\n- `risk:low`: x\n"],
    ["a #-line with no space", "- `bug`: kvar\n#x\n- `risk:low`: x\n"],
  ])("%s ends the section, so the item after it is missing", (_, section) => {
    expect(labelListProblems(doc(section), names).at(-1)).toMatch(/: no item for `risk:low`$/u);
  });

  it.each([
    ["a trailing space", "## Labele "],
    ["a trailing NBSP", "## Labele\u00a0"],
    ["a trailing tab", "## Labele\t"],
    ["an NBSP after ##", "##\u00a0Labele"],
    ["closing hashes", "## Labele ##"],
    ["another level", "### Labele"],
    ["a longer title", "## Labele i boje"],
    ["lower case", "## labele"],
    ["a leading space", " ## Labele"],
  ])("a heading with %s is no Labele section", (_, heading) => {
    const problems = labelListProblems(`${heading}\n\n${list}`, names);
    expect(problems).toContain("docs/BOTS.md: 0 lines `## Labele`, expected exactly 1");
  });

  it("two Labele sections are a problem", () => {
    const problems = labelListProblems(doc(`${list}\n## Labele\n\n${list}`), names);
    expect(problems).toEqual(["docs/BOTS.md: 2 lines `## Labele`, expected exactly 1"]);
  });

  it.each([
    ["unknown name", "- `nema`: x", "no such label `nema`"],
    ["__proto__", "- `__proto__`: x", "no such label `__proto__`"],
    ["constructor", "- `constructor`: x", "no such label `constructor`"],
    ["toString", "- `toString`: x", "no such label `toString`"],
    ["NBSP in the name", "- `bug\u00a0`: x", "no such label `bug\u00a0`"],
    ["upper case name", "- `Bug`: x", "no such label `Bug`"],
    ["duplicate item", "- `bug`: opet", "duplicate item `bug`"],
    ["tab after the dash", "-\t`nema`: x", "malformed line"],
    ["NBSP after the dash", "-\u00a0`nema`: x", "malformed line"],
    ["tab after the colon", "- `nema`:\tx", "malformed line"],
    ["NBSP after the colon", "- `nema`:\u00a0x", "malformed line"],
    ["two spaces after the dash", "-  `nema`: x", "malformed line"],
    ["a trailing space", "- `nema`: x ", "malformed line"],
    ["a trailing tab", "- `nema`: x\t", "malformed line"],
    ["a trailing NBSP", "- `nema`: x\u00a0", "malformed line"],
    ["a line separator", "- `nema`: x\u2028y", "malformed line"],
    ["a zero width space", "- `nema`: x\u200by", "malformed line"],
    ["a bidi override", "- `nema`: x\u202ey", "malformed line"],
    ["a tab inside", "- `nema`: x\ty", "malformed line"],
    ["an indented heading", " # Dodatak", "malformed line"],
    ["an HTML comment", "<!-- - `nema`: x -->", "malformed line"],
    ["a setext underline", "===", "malformed line"],
    ["a dash underline", "---", "malformed line"],
    ["bold prose at the start", "**masno** prvo", "malformed line"],
    ["no description", "- `nema`:", "malformed line"],
    ["no colon", "- `nema` x", "malformed line"],
    ["no backticks", "- nema: x", "malformed line"],
    ["two names", "- `nema`, `bug`: x", "malformed line"],
    ["a star marker", "* `nema`: x", "malformed line"],
    ["a plus marker", "+ `nema`: x", "malformed line"],
    ["a numbered item", "1. `nema`: x", "malformed line"],
    ["a quoted item", "> - `nema`: x", "malformed line"],
    ["a nested item", "  - `nema`: x", "malformed line"],
    ["an NBSP before the dash", "\u00a0- `nema`: x", "malformed line"],
  ])("%s is a problem", (_, line, problem) => {
    const problems = labelListProblems(doc(`${list}${line}\n`), names);
    expect(problems).toEqual([`docs/BOTS.md:9: ${problem}`]);
  });

  it("a lone CR anywhere is a problem, as CommonMark ends a line there", () => {
    expect(labelListProblems(doc(`${list}- \`bug\`: x\ry\n`), names)).toEqual([
      "docs/BOTS.md:9: lone CR",
    ]);
    expect(labelListProblems(doc(`uvod\r# Dodatak\n${list}`), names)).toEqual([
      "docs/BOTS.md:7: lone CR",
    ]);
  });

  it("a BOM anywhere is a problem", () => {
    expect(labelListProblems(`\ufeff${doc(list)}`, names)).toEqual(["docs/BOTS.md:1: BOM"]);
    expect(labelListProblems(doc(`${list}Kraj.\ufeff\n`), names)).toEqual(["docs/BOTS.md:9: BOM"]);
  });

  it("an item outside the section does not count", () => {
    const problems = labelListProblems(doc("- `bug`: kvar\n", `- \`risk:low\`: x\n\n`), names);
    expect(problems).toEqual(["docs/BOTS.md: no item for `risk:low`"]);
  });

  it("a real label named constructor needs its own item", () => {
    expect(labelListProblems(doc(list), [...names, "constructor"])).toEqual([
      "docs/BOTS.md: no item for `constructor`",
    ]);
    const withItem = doc(`${list}- \`constructor\`: x\n`);
    expect(labelListProblems(withItem, [...names, "constructor"])).toEqual([]);
  });

  it("fences are not read: an item in a fence counts, a fence hides no #-line", () => {
    expect(
      labelListProblems(doc(`- \`bug\`: kvar\n\`\`\`\n- \`risk:low\`: x\n\`\`\`\n`), names),
    ).toEqual([]);
  });

  it("a full list passes, to the end of the text or to the next #-line", () => {
    expect(labelListProblems(doc(list), names)).toEqual([]);
    expect(labelListProblems(`${doc(list)}\n## Dalje\n\n- \`nema\`: x\n`, names)).toEqual([]);
    expect(labelListProblems(doc(`${list}\nProza **masno** i \`kod\`.\n`), names)).toEqual([]);
  });

  it("a CRLF text reads like the LF text", () => {
    const lf = doc(`${list}- \`nema\`: x\n`);
    expect(labelListProblems(lf.replaceAll("\n", "\r\n"), names)).toEqual(
      labelListProblems(lf, names),
    );
    expect(labelListProblems(doc(list).replaceAll("\n", "\r\n"), names)).toEqual([]);
  });
});

describe("repository", () => {
  const parsed = parseLabels(readFileSync(join(ROOT, ".github", "labels.yml"), "utf8"));
  const names = parsed.labels.map((label) => label.name);

  it("every label of .github/labels.yml has a description", () => {
    expect(parsed.problems).toEqual([]);
    expect(names).toHaveLength(20);
  });

  it("the Labele section of docs/BOTS.md lists every label of labels.yml once", () => {
    const bots = readFileSync(join(ROOT, "docs", "BOTS.md"), "utf8");
    expect(labelListProblems(bots, names)).toEqual([]);
    expect(labelListProblems(bots.replaceAll("\n", "\r\n"), names)).toEqual([]);
  });
});
