import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "../forbidden-terms/index.ts";
import { LABEL_ERROR_CODES, type LabelErrorCode, parseLabels } from "./bot-labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const VALID = '- { name: "bug", color: "d73a4a", description: "Opis" }\n';
const [N, C, D] = ['name: "x"', 'color: "d73a4a"', 'description: "O"'];
const yamlWith = (entry: string): string => `${VALID}- ${entry}\n`;
const described = (text: string): string => yamlWith(`{ ${N}, ${C}, description: "${text}" }`);
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
    ["two documents", `${VALID}---\n${VALID}`],
    ["alias", `- { ${N}, ${C}, description: &d "O" }\n- { name: "y", ${C}, description: *d }\n`],
    ["YAML 1.1 merge key", `%YAML 1.1\n---\n- { <<: { ${D}, ${N} }, ${C} }\n`],
    ["YAML 1.2 directive", `%YAML 1.2\n---\n${VALID}`],
    ["TAG directive", `%TAG !x! tag:x.invalid,2026:\n---\n${VALID}`],
    ["unknown tag", `- { ${N}, ${C}, description: !foo "O" }\n`],
    ["!!merge key", `- { !!merge <<: { ${D} }, ${N}, ${C} }\n`],
    ["!!merge key, block", "- !!merge <<:\n    description: O\n  name: x\n  color: d73a4a\n"],
    ["verbatim merge tag", `- { !<tag:yaml.org,2002:merge> <<: { ${D} }, ${N}, ${C} }\n`],
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
    ["null entry", "null"],
  ]),
  ...of("LABEL_UNKNOWN_KEY", [
    ["extra key", `{ ${N}, ${C}, ${D}, default: true }`],
    ["__proto__ key", `{ ${N}, ${C}, ${D}, __proto__: "y" }`],
    ["constructor key", `{ ${N}, ${C}, ${D}, constructor: "y" }`],
    ["toString key", `{ ${N}, ${C}, ${D}, toString: "y" }`],
  ]),
  ...of("LABEL_INVALID_NAME", [
    ["missing name", `{ ${C}, ${D} }`],
    ["upper case name", `{ name: "Bug", ${C}, ${D} }`],
    ["space in name", `{ name: "a b", ${C}, ${D} }`],
    ["__proto__ as name", `{ name: "__proto__", ${C}, ${D} }`],
    ["51 characters", `{ name: "${"a".repeat(51)}", ${C}, ${D} }`],
  ]),
  ...of("LABEL_INVALID_COLOR", [
    ["short color", `{ ${N}, color: "d73a4", ${D} }`],
    ["color with hash", `{ ${N}, color: "#d73a4a", ${D} }`],
  ]),
  ...of("LABEL_NO_DESCRIPTION", [
    ["missing description", `{ ${N}, ${C} }`],
    ["null description", `{ ${N}, ${C}, description: null }`],
    ["number description", `{ ${N}, ${C}, description: 5 }`],
  ]),
  ...of("LABEL_DUPLICATE_NAME", [["same name", `{ name: "bug", ${C}, ${D} }`]]),
];

describe("a record with any problem is no label", () => {
  it.each(RECORDS)("%s: %s", (code, _, entry) => {
    const parsed = parseLabels(yamlWith(entry));
    expect(parsed.problems).toEqual([problem(code, 1)]);
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug"]);
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

  it("an inherited description does not count", () => {
    Object.defineProperty(Object.prototype, "description", { value: "O", configurable: true });
    try {
      const parsed = parseLabels(`- { ${N}, ${C} }\n`);
      expect(parsed.problems).toEqual([problem("LABEL_NO_DESCRIPTION", 0)]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "description");
    }
  });
});

const DESCRIPTIONS: Row[] = [
  ...of("LABEL_INVALID_DESCRIPTION", [
    ["Hangul filler", "\\u3164"],
    ["halfwidth filler", "a\\uffa0b"],
    ["combining grapheme joiner", "a\\u034f"],
    ["hieroglyph full blank", "\\U00013441"],
    ["zero width space", "a\\u200bb"],
    ["word joiner", "a\\u2060b"],
    ["NBSP", "a\\u00a0b"],
    ["ideographic space", "a\\u3000b"],
    ["tab", "a\\tb"],
    ["CRLF", "a\\r\\nb"],
    ["DEL", "a\\x7fb"],
    ["BOM inside", "a\\ufeffb"],
    ["bidi override", "a\\u202eb"],
    ["NFD č", "c\\u030c"],
    ["Cyrillic a", "\\u0430"],
    ["Croatian quotes", "\\u201ea\\u201d"],
    ["101 characters", "a".repeat(101)],
  ]),
  ...of("LABEL_NO_DESCRIPTION", [
    ["empty", ""],
    ["spaces only", "   "],
    ["punctuation only", "...!?"],
    ["section sign only", "\\u00a7"],
  ]),
];

describe("a description: Latin letters, printable ASCII and §", () => {
  it.each(DESCRIPTIONS)("%s: %s", (code, _, text) => {
    const parsed = parseLabels(described(text));
    expect(parsed.problems).toEqual([problem(code, 1)]);
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  it.each([
    ["Croatian letters (NFC)", "čćđšž ČĆĐŠŽ"],
    ["an apostrophe", "Something isn't working"],
    ["§ and digits", "SESSIONS.md §2a"],
    ["100 characters", "č".repeat(100)],
    ["one digit", "7"],
  ])("%s pass", (_, text) => {
    expect(parseLabels(described(text)).problems).toEqual([]);
    expect(names(described(text))).toEqual(["bug", "x"]);
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
