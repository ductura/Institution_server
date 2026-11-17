// DAN-852-1 (contract Ductus#1836 c.6943053415): the course body, a literal
// port of Ductus courseInput (src/server/institution/create-course.ts). Every
// value is invented. Refusals come first.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseCourseBody, parseEnrollmentCodeBody } from "./schemas.ts";

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

// DAN-852-3a (contract Ductus#1836 c.6945059378): the enrolment code body, a
// literal port of the body check and validTimestamp of Ductus
// enrollment-code-route.ts. Refusals come first.
const UNTIL = "2026-12-31T23:59:59.123456+01:00";
const at = (validUntil: unknown) => ({ validUntil });

describe("parseEnrollmentCodeBody refuses the body", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["an array", [at(UNTIL)]],
    ["a JSON string", JSON.stringify(at(UNTIL))],
    ["a number", 1],
    ["an empty object", {}],
    ["a course id too", { ...at(UNTIL), courseId: "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c01" }],
    ["an institution id too", { ...at(UNTIL), institutionId: "x" }],
    ["an inherited validUntil", Object.create(at(UNTIL)) as unknown],
    ["toString in place of the key", { toString: UNTIL }],
    ["an own __proto__", JSON.parse(`{"__proto__":"${UNTIL}"}`)],
    ["a key in another case", JSON.parse(`{"ValidUntil":"${UNTIL}"}`)],
  ])("%s", (_, value) => {
    expect(parseEnrollmentCodeBody(value)).toBeNull();
  });
});

describe("parseEnrollmentCodeBody refuses the instant", () => {
  it.each<[string, unknown]>([
    ["a number", 1_798_761_599_000],
    ["a Date", new Date(UNTIL)],
    ["null", null],
    ["February 30", "2026-02-30T12:00:00Z"],
    ["February 29 of a common year", "2026-02-29T12:00:00Z"],
    ["February 29 of 2100", "2100-02-29T12:00:00Z"],
    ["April 31", "2026-04-31T12:00:00Z"],
    ["month 00", "2026-00-10T12:00:00Z"],
    ["month 13", "2026-13-10T12:00:00Z"],
    ["day 00", "2026-01-00T12:00:00Z"],
    ["day 32", "2026-01-32T12:00:00Z"],
    ["hour 24", "2026-01-10T24:00:00Z"],
    ["minute 60", "2026-01-10T12:60:00Z"],
    ["second 60", "2026-01-10T12:00:60Z"],
    ["offset hour 16", "2026-01-10T12:00:00+16:00"],
    ["offset minute 60", "2026-01-10T12:00:00+15:60"],
    ["year 0000", "0000-01-10T12:00:00Z"],
    ["seven decimals", "2026-01-10T12:00:00.1234567Z"],
    ["no offset", "2026-01-10T12:00:00"],
    ["a lower case z", "2026-01-10T12:00:00z"],
    ["a space for T", "2026-01-10 12:00:00Z"],
    ["an offset without a colon", "2026-01-10T12:00:00+0100"],
    ["a trailing LF", `${UNTIL}\n`],
    ["a trailing CRLF", `${UNTIL}\r\n`],
    ["a trailing tab", `${UNTIL}\t`],
    ["a trailing NBSP", `${UNTIL}\u00A0`],
    ["a trailing DEL", `${UNTIL}\u007F`],
    ["a leading space", ` ${UNTIL}`],
    ["full-width digits", "\uFF12\uFF10\uFF12\uFF16-01-10T12:00:00Z"],
  ])("%s", (_, value) => {
    expect(parseEnrollmentCodeBody(at(value))).toBeNull();
  });
});

describe("parseEnrollmentCodeBody accepts", () => {
  it.each([
    "2024-02-29T12:00:00Z",
    "2000-02-29T12:00:00Z",
    "2026-01-10T12:00:00Z",
    "2026-01-10T12:00:00+15:59",
    "2026-01-10T12:00:00-12:00",
    "2026-01-10T12:00:00-00:00",
    "2026-01-10T12:00:00.1Z",
    UNTIL,
    "0001-01-01T00:00:00Z",
    // The year is judged on the written fields, not on the UTC instant.
    "0001-01-01T00:00:00+15:59",
    "9999-12-31T23:59:59-15:59",
  ])("%s, unchanged in a new object of one key", (validUntil) => {
    const input = at(validUntil);
    const parsed = parseEnrollmentCodeBody(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.keys(parsed ?? {})).toEqual(["validUntil"]);
  });
});

describe("parseEnrollmentCodeBody against the contract vectors", () => {
  type Vector = { name: string; request: { body?: unknown } };
  const file = new URL(
    "../contracts/vectors/institution.enrollment-code.post.json",
    import.meta.url,
  );
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] };
  const body = (name: string) => vectors.find((vector) => vector.name === name)?.request.body;

  it("refuses the invalid-input body and accepts the issued body", () => {
    expect(body("invalid-input")).toBeDefined();
    expect(parseEnrollmentCodeBody(body("invalid-input"))).toBeNull();
    expect(parseEnrollmentCodeBody(body("issued"))).toEqual(body("issued"));
  });
});
