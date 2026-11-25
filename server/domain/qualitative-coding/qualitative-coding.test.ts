// The domain of qualitative coding (SRV-V18-KODIRANJE-BAZA): the text and its
// paragraphs, the anchor that must be exactly the quote, the codebook and its
// order, and qualitative-export-v1. All values are invented.
import { describe, expect, it } from "vitest";

import {
  QUALITATIVE_EXPORT_SCHEMA,
  buildQualitativeExport,
  isAnchorOfText,
  isCodeDescription,
  isCodeName,
  isMaterialBody,
  isMaterialKind,
  isMaterialTitle,
  isMemo,
  moveCode,
  normalizeBody,
  paragraphsOf,
  sameCodeName,
  type CodebookEntry,
  type ExportSegmentInput,
} from "./index.ts";

const TEXT = "Prvi redak: kompost je važan.\n\nTreći redak: šuma šuti.";

describe("material", () => {
  it("knows the two kinds and no other", () => {
    expect(isMaterialKind("interview")).toBe(true);
    expect(isMaterialKind("note")).toBe(true);
    expect(isMaterialKind("audio")).toBe(false);
    expect(isMaterialKind(null)).toBe(false);
  });
  it("turns every line break into a line feed", () => {
    expect(normalizeBody("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  it("checks the title and the text", () => {
    expect(isMaterialTitle("Intervju A")).toBe(true);
    expect(isMaterialTitle(" Intervju A")).toBe(false);
    expect(isMaterialTitle("")).toBe(false);
    expect(isMaterialTitle("a".repeat(201))).toBe(false);
    expect(isMaterialBody(TEXT)).toBe(true);
    expect(isMaterialBody("a".repeat(100_000))).toBe(true);
    expect(isMaterialBody("a".repeat(100_001))).toBe(false);
    expect(isMaterialBody("  \n\t")).toBe(false);
    expect(isMaterialBody("a\u0001b")).toBe(false);
    expect(isMaterialBody("a\rb")).toBe(false);
    expect(isMaterialBody("a\tb")).toBe(true);
  });
  it("counts characters, not units: an astral letter is one", () => {
    expect(isMaterialBody("😀".repeat(100_000))).toBe(true);
    expect(isMaterialBody("😀".repeat(100_001))).toBe(false);
  });
  it("splits into lines, the empty one included", () => {
    expect(paragraphsOf(TEXT)).toEqual([
      "Prvi redak: kompost je važan.",
      "",
      "Treći redak: šuma šuti.",
    ]);
    expect(paragraphsOf("a\n")).toEqual(["a", ""]);
  });
});

describe("anchor", () => {
  it("accepts a quote that is exactly the characters of its line", () => {
    expect(isAnchorOfText(TEXT, { paragraph: 0, start: 0, end: 4, quote: "Prvi" })).toBe(true);
    expect(isAnchorOfText(TEXT, { paragraph: 2, start: 13, end: 17, quote: "šuma" })).toBe(true);
    expect(isAnchorOfText(TEXT, { paragraph: 2, start: 13, end: 23, quote: "šuma šuti." })).toBe(
      true,
    );
  });
  it.each([
    ["a quote that is not the text", { paragraph: 0, start: 0, end: 4, quote: "Pravi" }],
    ["a shifted offset", { paragraph: 0, start: 1, end: 5, quote: "Prvi" }],
    ["an end that does not fit the quote", { paragraph: 0, start: 0, end: 5, quote: "Prvi" }],
    ["the right quote in the wrong line", { paragraph: 2, start: 0, end: 4, quote: "Prvi" }],
    ["a line that is not there", { paragraph: 3, start: 0, end: 1, quote: "T" }],
    ["the empty line", { paragraph: 1, start: 0, end: 1, quote: "x" }],
    ["a negative line", { paragraph: -1, start: 0, end: 4, quote: "Prvi" }],
    ["an empty quote", { paragraph: 0, start: 4, end: 4, quote: "" }],
    ["a quote of a space", { paragraph: 0, start: 5, end: 6, quote: " " }],
    ["a fractional offset", { paragraph: 0, start: 0.5, end: 4, quote: "Prvi" }],
    [
      "a quote past the end of the line",
      { paragraph: 2, start: 13, end: 24, quote: "šuma šuti.?" },
    ],
  ])("refuses %s", (_name, anchor) => {
    expect(isAnchorOfText(TEXT, anchor)).toBe(false);
  });
  it("refuses a quote over 500 characters", () => {
    const text = "a".repeat(600);
    expect(isAnchorOfText(text, { paragraph: 0, start: 0, end: 500, quote: "a".repeat(500) })).toBe(
      true,
    );
    expect(isAnchorOfText(text, { paragraph: 0, start: 0, end: 501, quote: "a".repeat(501) })).toBe(
      false,
    );
  });
  it("cuts by characters when the line has an astral letter", () => {
    expect(isAnchorOfText("😀 kompost", { paragraph: 0, start: 2, end: 9, quote: "kompost" })).toBe(
      true,
    );
  });
  it("checks the memo", () => {
    expect(isMemo("Prva\nbilješka")).toBe(true);
    expect(isMemo("")).toBe(false);
    expect(isMemo("a".repeat(1001))).toBe(false);
    expect(isMemo("a\u0001")).toBe(false);
  });
});

const CODEBOOK: CodebookEntry[] = [
  { id: "k1", name: "Kompost", description: "", order: 1 },
  { id: "k2", name: "Šuma", description: "O šumi", order: 2 },
  { id: "k3", name: "Tišina", description: "", order: 3 },
];

describe("codebook", () => {
  it("checks the name and the description", () => {
    expect(isCodeName("Kompost")).toBe(true);
    expect(isCodeName("")).toBe(false);
    expect(isCodeName("a".repeat(81))).toBe(false);
    expect(isCodeDescription("")).toBe(true);
    expect(isCodeDescription("a".repeat(500))).toBe(true);
    expect(isCodeDescription("a".repeat(501))).toBe(false);
    expect(isCodeDescription("a\nb")).toBe(false);
  });
  it("takes a name in another case for the same", () => {
    expect(sameCodeName("Šuma", "šuma")).toBe(true);
    expect(sameCodeName("Šuma", "Šume")).toBe(false);
  });
  it("moves a code and keeps the order of the others", () => {
    expect(moveCode(CODEBOOK, "k3", 1)?.map((entry) => entry.id)).toEqual(["k3", "k1", "k2"]);
    expect(moveCode(CODEBOOK, "k1", 3)?.map((entry) => `${entry.id}${entry.order}`)).toEqual([
      "k21",
      "k32",
      "k13",
    ]);
    expect(moveCode(CODEBOOK, "k2", 2)?.map((entry) => entry.id)).toEqual(["k1", "k2", "k3"]);
  });
  it("refuses a code that is not there and a place outside the codebook", () => {
    expect(moveCode(CODEBOOK, "k9", 1)).toBeUndefined();
    expect(moveCode(CODEBOOK, "k1", 0)).toBeUndefined();
    expect(moveCode(CODEBOOK, "k1", 4)).toBeUndefined();
    expect(moveCode(CODEBOOK, "k1", 1.5)).toBeUndefined();
  });
});

const segment = (
  materialId: string,
  materialRank: number,
  codeId: string,
  paragraph: number,
  start: number,
  quote: string,
): ExportSegmentInput => ({
  materialId,
  materialRank,
  codeId,
  paragraph,
  start,
  end: start + quote.length,
  quote,
  memo: null,
});

describe("qualitative-export-v1", () => {
  const SEGMENTS = [
    segment("m2", 2, "k3", 0, 0, "Kratka"),
    segment("m1", 1, "k3", 2, 13, "šuma"),
    segment("m2", 2, "k1", 0, 18, "kompos"),
    segment("m1", 1, "k1", 2, 0, "Treći"),
    segment("m1", 1, "k1", 0, 0, "Prvi"),
    segment("m1", 1, "k1", 0, 6, "redak"),
  ];
  const result = buildQualitativeExport(CODEBOOK, SEGMENTS);

  it("names its schema and holds the codebook in its order", () => {
    expect(result.schema).toBe(QUALITATIVE_EXPORT_SCHEMA);
    expect(result.codebook.map((entry) => entry.code)).toEqual(["k1", "k2", "k3"]);
    expect(Object.keys(result.codebook[0] ?? {}).sort()).toEqual(["code", "description", "name"]);
  });
  it("orders the passages by codebook, then material, then text, never by count", () => {
    expect(result.segments.map((entry) => `${entry.code}${entry.material}:${entry.quote}`)).toEqual(
      ["k1m1:Prvi", "k1m1:redak", "k1m1:Treći", "k1m2:kompos", "k3m1:šuma", "k3m2:Kratka"],
    );
  });
  it("counts per code and material, in that same order, not by n", () => {
    expect(result.counts).toEqual([
      { code: "k1", material: "m1", n: 3 },
      { code: "k1", material: "m2", n: 1 },
      { code: "k3", material: "m1", n: 1 },
      { code: "k3", material: "m2", n: 1 },
    ]);
  });
  it("gives the same bytes for the same input, whatever the order it came in", () => {
    const again = buildQualitativeExport([...CODEBOOK].reverse(), [...SEGMENTS].reverse());
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
  it("is empty and still has the codebook when nothing is marked", () => {
    const empty = buildQualitativeExport(CODEBOOK, []);
    expect(empty.segments).toEqual([]);
    expect(empty.counts).toEqual([]);
    expect(empty.codebook).toHaveLength(3);
  });
  it("refuses a passage with a code that is not in the codebook", () => {
    expect(() => buildQualitativeExport(CODEBOOK, [segment("m1", 1, "k9", 0, 0, "x")])).toThrow();
  });
});
