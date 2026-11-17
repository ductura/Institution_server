// DAN-909 (S-M-3): the work language parser, ported from Ductus
// src/domain/assignment/work-language.test.ts at 4651a25 (DAN-386), with the
// classes of input of the contract (Ductus#1836 c.6935013407).
import { describe, expect, it } from "vitest";

import { parseWorkLanguage, WORK_LANGUAGES } from "./work-language.ts";

describe("work language parser", () => {
  it("is the closed set of the database CHECK", () => {
    expect(WORK_LANGUAGES).toEqual(["hr", "en"]);
  });

  it.each([
    ["hr", "hr"],
    ["en", "en"],
    ["de", null],
    ["HR", null],
    ["En", null],
    [" hr", null],
    ["hr ", null],
    ["hr\t", null],
    ["hr\r\n", null],
    ["hr ", null],
    ["hr\u007f", null],
    ["hr-HR", null],
    ["en-GB", null],
    ["", null],
    ["toString", null],
    ["__proto__", null],
    ["constructor", null],
    [null, null],
    [undefined, null],
    [0, null],
    [["hr"], null],
    [{ toString: () => "hr" }, null],
    [new String("hr"), null],
    [Object.assign(Object.create(null) as object, { valueOf: () => "hr" }), null],
  ])("%j reads as %j", (value, expected) => {
    expect(parseWorkLanguage(value)).toBe(expected);
  });
});
