import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "../forbidden-terms/index.ts";
import { LABEL_ERROR_CODES, type LabelErrorCode, parseLabels } from "./bot-labels.ts";

const VALID = '- { name: "bug", color: "d73a4a", description: "Opis !b 100%" }\n';
const [N, C, D] = ['name: "x"', 'color: "d73a4a"', 'description: "O"'];
const yamlWith = (entry: string): string => `${VALID}- ${entry}\n`;
const problem = (code: LabelErrorCode, at: number | null = null) => {
  return { code, messageKey: `labels.${code.toLowerCase()}`, at };
};
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
    ["!!merge key", `- { !!merge <<: { ${D} }, ${N}, ${C} }\n`],
    ["anchor as a key (a warning only)", `- &a: { ${N}, ${C}, ${D} }\n`],
  ]),
];

// Each explicit tag is a lexer token, whatever it resolves to (`!<>` to none).
const PLACES: Record<string, (tag: string) => string> = {
  mapping: (tag) => `- ${tag} { ${N}, ${C}, ${D} }\n`,
  sequence: (tag) => `${tag} [{ ${N}, ${C}, ${D} }]\n`,
  scalar: (tag) => `- { ${N}, ${C}, description: ${tag} "O" }\n`,
};
for (const tag of ["!", "!<>", "!!str", "!foo", "!<tag:yaml.org,2002:str>"]) {
  for (const [at, make] of Object.entries(PLACES)) {
    FILES.push(["LABELS_INVALID_YAML", `tag ${tag} on a ${at}`, make(tag)]);
  }
}

it.each(FILES)("labels.yml, %s: %s", (code, _, text) => {
  const expected = { labels: [], problems: [problem(code, null)] };
  expect(parseLabels(text)).toEqual(expected);
});

// One table per pattern of bot-labels.ts: class → representatives that pass and fail
// (`undefined` leaves the key out). Range ends and both neighbours of each range are rows.
type Classes = Record<string, { pass: unknown[]; fail: unknown[] }>;
const NAME_CLASSES: Classes = {
  "a-z": { pass: ["bug", "constructor", "fuzz"], fail: ["Bug", "\u010d", "a`", "a{"] },
  digit: { pass: ["2fa-v2", "area:v2", "v0-9"], fail: ["v\uff12", "v/"] },
  dash: { pass: ["needs-review"], fail: ["needs_review", "a.b", "a/b", "a b", "a\tb", "a\r\nb"] },
  start: { pass: ["a"], fail: ["-a", ":a", "__proto__"] },
  end: { pass: ["a1"], fail: ["a-", "a:"] },
  "double dash": { pass: ["a-b-c"], fail: ["a--b"] },
  colon: { pass: ["area:db"], fail: ["a:b:c"] },
  length: { pass: ["a".repeat(50)], fail: ["a".repeat(51)] },
  string: { pass: ["123"], fail: [123, ["bug"], null, undefined] },
};
const COLOR_CLASSES: Classes = {
  "0-9": { pass: ["012789"], fail: ["01278:", "01278/"] },
  "a-f": { pass: ["abcdef"], fail: ["abcdeg", "abcde`"] },
  "A-F": { pass: ["ABCDEF"], fail: ["ABCDEG", "ABCDE@"] },
  length: { pass: ["d73a4a"], fail: ["d73a4", "d73a4aa"] },
  "#": { pass: ["d73a4a"], fail: ["#d73a4a", "d73 4a", "d73a4a\nzz"] },
  string: { pass: ["123456"], fail: [123456] },
};
const DESCRIPTION_CLASSES: Classes = {
  string: { pass: ["O"], fail: [5, null, true, undefined] },
  "not only JS \\s": { pass: [" O "], fail: ["", "   ", "\t\r\n", "\u00a0"] },
};
const NAME_REQUIRED = ["a-z", "digit", "dash", "start", "end", "double dash"];
const PATTERNS = [
  ["name", NAME_CLASSES, "LABEL_INVALID_NAME", NAME_REQUIRED],
  ["color", COLOR_CLASSES, "LABEL_INVALID_COLOR", ["0-9", "a-f", "A-F", "length", "#"]],
  ["description", DESCRIPTION_CLASSES, "LABEL_NO_DESCRIPTION", ["string"]],
] as const;

describe.each(PATTERNS)("%s classes", (key, classes, code, required) => {
  it("every required class is there, each with a passing and a failing row", () => {
    expect(Object.keys(classes)).toEqual(expect.arrayContaining([...required]));
    for (const { pass, fail } of Object.values(classes)) {
      expect([pass.length > 0, fail.length > 0]).toEqual([true, true]);
    }
  });

  const rows = Object.entries(classes).flatMap(([name, { pass, fail }]) => [
    ...pass.map((value) => [name, "passes", value] as const),
    ...fail.map((value) => [name, "fails", value] as const),
  ]);
  it.each(rows)("%s: %s with %j", (_, outcome, value) => {
    const record = { name: "x", color: "d73a4a", description: "O", [key]: value };
    const parsed = parseLabels(`- ${JSON.stringify(record)}\n`);
    const fails = { labels: [], problems: [problem(code, 0)] };
    expect(parsed).toEqual(outcome === "passes" ? { labels: [record], problems: [] } : fails);
  });
});

// Two records of one name: valid or invalid (color "zz"), first or second.
const named = (color: string): string => `- { ${N}, color: "${color}", ${D} }\n`;
it.each([
  ["valid, then valid", "d73a4a", "0e8a16", ["d73a4a"], "LABEL_DUPLICATE_NAME", [1]],
  ["invalid, then valid", "zz", "0e8a16", ["0e8a16"], "LABEL_INVALID_COLOR", [0]],
  ["valid, then invalid", "d73a4a", "zz", ["d73a4a"], "LABEL_INVALID_COLOR", [1]],
  ["invalid, then invalid", "zz", "zz", [], "LABEL_INVALID_COLOR", [0, 1]],
] as const)("two records of one name, %s", (_, first, second, colors, code, ats) => {
  const parsed = parseLabels(named(first) + named(second));
  expect(parsed.labels.map((label) => label.color)).toEqual(colors);
  expect(parsed.problems).toEqual(ats.map((at) => problem(code, at)));
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
];

describe("a record with any problem is no label", () => {
  it.each(RECORDS)("%s: %s", (code, _, entry) => {
    const parsed = parseLabels(yamlWith(entry));
    expect(parsed.problems).toEqual([problem(code, 1)]);
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  it("a file with CRLF line ends reads as the same two labels", () => {
    const text = `${VALID}- { ${N}, ${C}, ${D} }\n`;
    expect(parseLabels(text.replaceAll("\n", "\r\n"))).toEqual(parseLabels(text));
    expect(names(text)).toEqual(["bug", "x"]);
  });

  it("a merge key is an unknown key, and gives no description", () => {
    expect(parseLabels(yamlWith(`{ <<: { ${D} }, ${N}, ${C} }`)).problems).toEqual([
      problem("LABEL_UNKNOWN_KEY", 1),
      problem("LABEL_NO_DESCRIPTION", 1),
    ]);
  });

  it("an inherited name, color or description does not count", () => {
    const inherited = { name: "x", color: "d73a4a", description: "O" };
    for (const [key, value] of Object.entries(inherited)) {
      Object.defineProperty(Object.prototype, key, { value, writable: true, configurable: true });
    }
    try {
      const codes = ["LABEL_INVALID_NAME", "LABEL_INVALID_COLOR", "LABEL_NO_DESCRIPTION"] as const;
      expect(parseLabels("- {}\n").problems).toEqual(codes.map((code) => problem(code, 0)));
    } finally {
      for (const key of Object.keys(inherited)) Reflect.deleteProperty(Object.prototype, key);
    }
  });
});

it("every error code has one Croatian text in locales/hr.json, and nothing else is there", () => {
  const hr = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../locales/hr.json"), "utf8"),
  ) as {
    labels: Record<string, string>;
  };
  expect(Object.keys(hr.labels)).toEqual(LABEL_ERROR_CODES.map((code) => code.toLowerCase()));
  for (const text of Object.values(hr.labels)) {
    expect(text.trim()).not.toBe("");
    expect(findForbiddenTerms(text), text).toEqual([]);
  }
});
