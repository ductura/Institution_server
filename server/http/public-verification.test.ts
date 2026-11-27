// DIZAJN-27-11 1.1 (3): what POST /api/v1/public/verification/code takes
// before any read. Every code here is invented.
import { describe, expect, it } from "vitest";

import { publicVerificationCodePost } from "../contracts/index.ts";

import { isJsonMedia, parseCheckBody } from "./public-verification.ts";

const schema = publicVerificationCodePost.request.body;
const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("the body of the check by code", () => {
  it("takes a code of four groups of four, upper case", () => {
    expect(parseCheckBody(schema, bytes({ code: "DK7M-4Q9P-X2HT-R8VN" }))).toEqual({
      ok: true,
      value: { code: "DK7M-4Q9P-X2HT-R8VN" },
    });
    expect(parseCheckBody(schema, bytes({ code: "0123-4567-89AB-CDEF" })).ok).toBe(true);
  });

  it.each([
    // The receipt prints the code upper case and the database keeps it so: no normalising.
    ["lower case", "dk7m-4q9p-x2ht-r8vn"],
    ["one character short", "DK7M-4Q9P-X2HT-R8V"],
    ["one character long", "DK7M-4Q9P-X2HT-R8VNA"],
    ["no dashes", "DK7M4Q9PX2HTR8VN"],
    ["a trailing newline", "DK7M-4Q9P-X2HT-R8VN\n"],
    ["a U outside the alphabet", "DK7M-4Q9P-X2HT-R8VU"],
    ["an I outside the alphabet", "DK7M-4Q9P-X2HT-R8VI"],
    ["an O outside the alphabet", "DK7M-4Q9P-X2HT-R8VO"],
    ["an L outside the alphabet", "DK7M-4Q9P-X2HT-R8VL"],
  ])("refuses a code with %s as 422", (_name, code) => {
    expect(parseCheckBody(schema, bytes({ code }))).toEqual({ ok: false, status: 422 });
  });

  it.each([
    ["an unknown field", { code: "DK7M-4Q9P-X2HT-R8VN", email: "student@example.invalid" }],
    ["no code", {}],
    ["a code that is no string", { code: 42 }],
    ["an array", ["DK7M-4Q9P-X2HT-R8VN"]],
  ])("refuses %s as 422", (_name, body) => {
    expect(parseCheckBody(schema, bytes(body))).toEqual({ ok: false, status: 422 });
  });

  it.each([
    ["cut JSON", '{"code":'],
    ["plain text", "DK7M-4Q9P-X2HT-R8VN"],
    ["an empty body", ""],
  ])("refuses %s as 400", (_name, raw) => {
    expect(parseCheckBody(schema, bytes(raw))).toEqual({ ok: false, status: 400 });
  });
});

describe("the media type of the check", () => {
  it.each([["application/json"], ["application/json; charset=utf-8"], ["Application/JSON"]])(
    "takes %j",
    (media) => {
      expect(isJsonMedia([media])).toBe(true);
    },
  );

  it.each<[string, string[] | undefined]>([
    ["none", undefined],
    ["text/plain", ["text/plain"]],
    ["form data", ["application/x-www-form-urlencoded"]],
    ["two headers", ["application/json", "application/json"]],
  ])("refuses %s, so the route answers 415", (_name, media) => {
    expect(isJsonMedia(media)).toBe(false);
  });
});
