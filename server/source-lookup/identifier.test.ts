import { describe, expect, it } from "vitest";

import { parseSourceIdentifier } from "./index.ts";

const DOI = { kind: "doi", value: "10.99999/demo(1)/dio" } as const;
const ISBN = { kind: "isbn", value: "9780000000422" } as const;

describe("source identifiers", () => {
  it.each([
    ["doi", " 10.99999/DEMO(1)/dio ", DOI],
    ["doi", "doi:10.99999/demo(1)/dio", DOI],
    ["doi", "https://doi.org/10.99999/demo(1)/dio?x=1", DOI],
    ["doi", "https://doi.org/10.99999%2Fdemo%281%29%2Fdio?x=1", DOI],
    ["doi", "10.99999/primjer#2", { kind: "doi", value: "10.99999/primjer#2" }],
    ["doi", "https://example.invalid/10.99999/demo", null],
    ["doi", "https://doi.org/10.99999/%zz", null],
    ["doi", "10.99999/demo riječ", null],
    ["doi", "10.99999/demo\u0000", null],
    ["doi", "10.99999/\ud800", null],
    ["doi", "10.99999/", null],
    ["doi", "", null],
    ["doi", "10.99999/" + "a".repeat(512), null],
    ["isbn", "ISBN: 978 0 0000-0042-2", ISBN],
    ["isbn", "ISBN-13 978 0 0000-0042-2", ISBN],
    ["isbn", "0-000-00023-x", { kind: "isbn", value: "000000023X" }],
    ["isbn", "9780000000420", null],
    ["isbn", "978000000042X", null],
    ["isbn", "9770000000423", null],
    ["isbn", "0000004280", null],
    ["isbn", "00000042X8", null],
    ["title", "Izmišljeni naslov", null],
    ["doi", 42, null],
  ])("normalizes %s input %j", (kind, raw, expected) => {
    expect(parseSourceIdentifier(kind, raw)).toEqual(expected);
  });
});
