import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "../forbidden-terms/index.ts";
import { LABEL_ERROR_CODES, type LabelErrorCode, parseLabels } from "./bot-labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const VALID = '- { name: "bug", color: "d73a4a", description: "Opis" }\n';
const [N, C, D] = ['name: "x"', 'color: "d73a4a"', 'description: "O"'];
const yamlWith = (entry: string): string => `${VALID}- ${entry}\n`;
const problem = (code: LabelErrorCode, at: number | null) => ({
  code,
  messageKey: `labels.${code.toLowerCase()}`,
  at,
});
const names = (text: string): string[] => parseLabels(text).labels.map((label) => label.name);
type Row = readonly [LabelErrorCode, string, string];
const of = (code: LabelErrorCode, rows: readonly (readonly [string, string])[]): Row[] =>
  rows.map(([name, text]) => [code, name, text]);

const FILES: Row[] = [
  ...of("LABELS_NOT_A_LIST", [
    ["empty file", ""],
    ["null root", "null\n"],
    ["object root", "name: bug\n"],
    ["scalar root", "bug\n"],
    ["empty list", "[]\n"],
    ["comment only", "# samo komentar\n"],
  ]),
  ...of("LABELS_INVALID_YAML", [
    ["invalid yaml", "- { name: [\n"],
    ["duplicate key", `- { ${N}, name: "y", ${C}, ${D} }\n`],
    ["escaped duplicate key", `- { "na\\u006de": "x", name: "y", ${C}, ${D} }\n`],
    ["BOM", `\uFEFF${VALID}`],
    ["BOM before a flow list", `\uFEFF[{ ${N}, ${C}, ${D} }]\n`],
    ["BOM before a comment", `\uFEFF# x\n${VALID}`],
    ["BOM before ---", `\uFEFF---\n${VALID}`],
    ["BOM after ...", `${VALID}...\n\uFEFF`],
    ["CR line ends only", VALID.replaceAll("\n", "\r")],
    ["tab indentation", "- name: x\n\tcolor: d73a4a\n"],
    ["two documents", `${VALID}---\n${VALID}`],
    ["alias", `- { ${N}, ${C}, description: &d "O" }\n- { name: "y", ${C}, description: *d }\n`],
    ["YAML 1.1 merge key", `%YAML 1.1\n---\n- { <<: { ${D}, ${N} }, ${C} }\n`],
    ["YAML 1.2 directive", `%YAML 1.2\n---\n${VALID}`],
    ["TAG directive", `%TAG !x! tag:x.invalid,2026:\n---\n${VALID}`],
    ["unknown tag", `- { ${N}, ${C}, description: !foo "O" }\n`],
    ["!!merge key", `- { !!merge <<: { ${D} }, ${N}, ${C} }\n`],
    ["!!merge key, block", "- !!merge <<:\n    description: O\n  name: x\n  color: d73a4a\n"],
    ["verbatim merge tag", `- { !<tag:yaml.org,2002:merge> <<: { ${D} }, ${N}, ${C} }\n`],
    ["anchor as a key (a warning only)", `- &a: { ${N}, ${C}, ${D} }\n`],
    ["!!map tag on a record", `- !!map { ${N}, ${C}, ${D} }\n`],
    ["!!str tag", `- { ${N}, ${C}, description: !!str "O" }\n`],
    ["!!binary description", `- { ${N}, ${C}, description: !!binary T3Bpcw== }\n`],
    ["%TAG redefining !!", `%TAG !! tag:x.invalid,2026:\n---\n${VALID}`],
    ["%TAG repeating !!", `%TAG !! tag:yaml.org,2002:\n---\n${VALID}`],
  ]),
];

it.each(FILES)("labels.yml, %s: %s", (code, _, text) => {
  const expected = { labels: [], problems: [problem(code, null)] };
  expect(parseLabels(text)).toEqual(expected);
});

const RECORDS: Row[] = [
  ...of("LABEL_NOT_A_MAPPING", [
    ["scalar entry", '"x"'],
    ["list entry", '["x"]'],
    ["null entry", "null"],
  ]),
  ...of("LABEL_UNKNOWN_KEY", [
    ["extra key", `{ ${N}, ${C}, ${D}, default: true }`],
    ["__proto__ key", `{ ${N}, ${C}, ${D}, __proto__: "y" }`],
    ["constructor key", `{ ${N}, ${C}, ${D}, constructor: "y" }`],
    ["toString key", `{ ${N}, ${C}, ${D}, toString: "y" }`],
    ["three extra keys, one problem", `{ ${N}, ${C}, ${D}, a: 1, b: 2, c: 3 }`],
  ]),
  ...of("LABEL_INVALID_NAME", [
    ["missing name", `{ ${C}, ${D} }`],
    ["upper case name", `{ name: "Bug", ${C}, ${D} }`],
    ["space in name", `{ name: "a b", ${C}, ${D} }`],
    ["__proto__ as name", `{ name: "__proto__", ${C}, ${D} }`],
    ["51 characters", `{ name: "${"a".repeat(51)}", ${C}, ${D} }`],
    ["double dash", `{ name: "a--b", ${C}, ${D} }`],
    ["trailing dash", `{ name: "a-", ${C}, ${D} }`],
    ["two colons", `{ name: "a:b:c", ${C}, ${D} }`],
    ["tab in name", `{ name: "a\\tb", ${C}, ${D} }`],
    ["CRLF in name", `{ name: "a\\r\\nb", ${C}, ${D} }`],
  ]),
  ...of("LABEL_INVALID_COLOR", [
    ["short color", `{ ${N}, color: "d73a4", ${D} }`],
    ["color with hash", `{ ${N}, color: "#d73a4a", ${D} }`],
    ["seven digit color", `{ ${N}, color: "d73a4aa", ${D} }`],
    ["numeric color", `{ ${N}, color: 123456, ${D} }`],
  ]),
  ...of("LABEL_NO_DESCRIPTION", [
    ["missing description", `{ ${N}, ${C} }`],
    ["null description", `{ ${N}, ${C}, description: null }`],
    ["number description", `{ ${N}, ${C}, description: 5 }`],
    ["empty description", `{ ${N}, ${C}, description: "" }`],
    ["spaces only", `{ ${N}, ${C}, description: "   " }`],
    ["tab and CRLF only", `{ ${N}, ${C}, description: "\\t\\r\\n" }`],
    ["NBSP only", `{ ${N}, ${C}, description: "\\u00a0" }`],
  ]),
  ...of("LABEL_DUPLICATE_NAME", [["same name", `{ name: "bug", ${C}, ${D} }`]]),
];

describe("a record with any problem is no label", () => {
  it.each(RECORDS)("%s: %s", (code, _, entry) => {
    const parsed = parseLabels(yamlWith(entry));
    expect(parsed.problems).toEqual([problem(code, 1)]);
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  it.each(["a:b", "a".repeat(50)])("%s is a name", (name) => {
    expect(names(yamlWith(`{ name: "${name}", ${C}, ${D} }`))).toEqual(["bug", name]);
  });

  it("a dashed name and an upper-case color are a whole label", () => {
    const text = '- { name: "needs-review", color: "D73A4A", description: "O" }\n';
    const label = { name: "needs-review", color: "D73A4A", description: "O" };
    expect(parseLabels(text)).toEqual({ labels: [label], problems: [] });
  });

  it("a file with CRLF line ends is valid", () => {
    const text = `${VALID}- { ${N}, ${C}, ${D} }\n`.replaceAll("\n", "\r\n");
    expect(parseLabels(text)).toEqual({
      labels: [
        { name: "bug", color: "d73a4a", description: "Opis" },
        { name: "x", color: "d73a4a", description: "O" },
      ],
      problems: [],
    });
  });

  it("a merge key is an unknown key, and gives no description", () => {
    expect(parseLabels(yamlWith(`{ <<: { ${D} }, ${N}, ${C} }`)).problems).toEqual([
      problem("LABEL_UNKNOWN_KEY", 1),
      problem("LABEL_NO_DESCRIPTION", 1),
    ]);
  });

  it("constructor is a name like any other, and its duplicate is caught", () => {
    const entry = `{ name: "constructor", ${C}, ${D} }`;
    const parsed = parseLabels(`${yamlWith(entry)}- ${entry}\n`);
    expect(parsed.problems).toEqual([problem("LABEL_DUPLICATE_NAME", 2)]);
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug", "constructor"]);
  });

  it("an inherited name, color or description does not count", () => {
    const inherited = { name: "x", color: "d73a4a", description: "O" };
    for (const [key, value] of Object.entries(inherited)) {
      Object.defineProperty(Object.prototype, key, { value, writable: true, configurable: true });
    }
    try {
      expect(parseLabels("- {}\n").problems).toEqual(
        ["LABEL_INVALID_NAME", "LABEL_INVALID_COLOR", "LABEL_NO_DESCRIPTION"].map((code) =>
          problem(code as LabelErrorCode, 0),
        ),
      );
    } finally {
      for (const key of Object.keys(inherited)) Reflect.deleteProperty(Object.prototype, key);
    }
  });
});

it("every error code has one Croatian text in locales/hr.json, and nothing else is there", () => {
  const hr = JSON.parse(readFileSync(resolve(ROOT, "locales/hr.json"), "utf8")) as {
    labels: Record<string, string>;
  };
  expect(Object.keys(hr.labels)).toEqual(LABEL_ERROR_CODES.map((code) => code.toLowerCase()));
  for (const text of Object.values(hr.labels)) {
    expect(text.trim()).not.toBe("");
    expect(findForbiddenTerms(text), text).toEqual([]);
  }
});
