// DAN-852-1 (contract Ductus#1836 c.6943053415): the course body, a literal
// port of Ductus courseInput (src/server/institution/create-course.ts). Every
// value is invented. Refusals come first.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseCourseBody } from "./schemas.ts";

const VALID = { name: "Izmišljeni kolegij A", academicYear: "2026/2027", aiPolicy: "encouraged" };
const withName = (name: string) => ({ ...VALID, name });
const withYear = (academicYear: string) => ({ ...VALID, academicYear });
const EMOJI = "\u{1F600}";

describe("parseCourseBody refuses", () => {
  it.each([
    ["null", null],
    ["an array", [VALID]],
    ["a string", JSON.stringify(VALID)],
    ["a number", 3],
    ["a missing key", { name: VALID.name, academicYear: VALID.academicYear }],
    ["an institution id", { ...VALID, institutionId: "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c01" }],
    ["a user id", { ...VALID, userId: "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c02" }],
    ["inherited keys", Object.create(VALID) as unknown],
    ["toString in place of a key", { name: VALID.name, academicYear: "2026/2027", toString: "x" }],
    [
      "an own __proto__",
      JSON.parse(`{"name":"A","academicYear":"2026/2027","__proto__":"encouraged"}`),
    ],
    [
      "a key in another case",
      JSON.parse(`{"Name":"A","academicYear":"2026/2027","aiPolicy":"encouraged"}`),
    ],
  ])("%s", (_, value) => {
    expect(parseCourseBody(value)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["empty", ""],
    ["161 units", "a".repeat(161)],
    ["81 emoji (162 units)", EMOJI.repeat(81)],
    ...[" ", "\t", "\r\n", "\n", " ", "﻿", " ", "　"].flatMap((space) => [
      [`${JSON.stringify(space)} at the start`, `${space}Kolegij`] as [string, unknown],
      [`${JSON.stringify(space)} at the end`, `Kolegij${space}`] as [string, unknown],
    ]),
    ["not a string", 7],
  ])("a name: %s", (_, name) => {
    expect(parseCourseBody({ ...VALID, name })).toBeNull();
  });

  it.each([
    "2026/2028",
    "2026/2026",
    "2027/2026",
    "2026-2027",
    "26/27",
    "2026/2027\n",
    " 2026/2027",
    "２０２６/２０２７",
    "9999/10000",
  ])("the year %j", (year) => {
    expect(parseCourseBody(withYear(year))).toBeNull();
  });

  it.each(["allowed", "Encouraged", "ENCOURAGED", "", 1, null])("the policy %j", (aiPolicy) => {
    expect(parseCourseBody({ ...VALID, aiPolicy })).toBeNull();
  });
});

describe("parseCourseBody accepts", () => {
  it.each([
    ["a plain name", "Izmišljeni kolegij A"],
    ["one unit", "A"],
    ["160 units", "a".repeat(160)],
    ["80 emoji (160 units)", EMOJI.repeat(80)],
    ["an inner NBSP", "Kolegij A"],
    // The parser lets DEL through as Ductus does; the RPC's is_plain_label refuses it (ZD422).
    ["an inner DEL", "Kolegij\u007FA"],
  ])("%s", (_, name) => {
    expect(parseCourseBody(withName(name))).toEqual(withName(name));
  });

  it.each(["2026/2027", "0999/1000", "1999/2000"])("the year %j", (year) => {
    expect(parseCourseBody(withYear(year))).toEqual(withYear(year));
  });

  it.each(["prohibited", "partially_allowed", "encouraged"])("the policy %s", (aiPolicy) => {
    expect(parseCourseBody({ ...VALID, aiPolicy })).toEqual({ ...VALID, aiPolicy });
  });

  it("answers a new object with exactly the three keys", () => {
    const value = { ...VALID };
    const parsed = parseCourseBody(value);
    expect(parsed).not.toBe(value);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["academicYear", "aiPolicy", "name"]);
  });
});

describe("parseCourseBody against the contract vectors", () => {
  type Vector = { name: string; request: { body?: unknown } };
  const file = new URL("../contracts/vectors/institution.courses.post.json", import.meta.url);
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] };
  const body = (name: string) => vectors.find((vector) => vector.name === name)?.request.body;

  it("refuses the invalid-input body and accepts the created body", () => {
    expect(body("invalid-input")).toBeDefined();
    expect(parseCourseBody(body("invalid-input"))).toBeNull();
    expect(parseCourseBody(body("created"))).toEqual(body("created"));
  });
});
