import { describe, expect, it } from "vitest";

import { ENDED_MARK_COOKIE, liveSessionToken, liveSessionTokenFromCookie } from "./ended-mark.ts";
import { sessionTag } from "./principal.ts";
import { SESSION_COOKIE_NAME } from "./session-token.ts";

// Invented tokens: 43 characters of the base64url alphabet, never a real cookie.
const TOKEN = "A".repeat(42) + "b";
const OTHER = "C".repeat(42) + "d";
const TAG = sessionTag(TOKEN)!;
const OTHER_TAG = sessionTag(OTHER)!;

function jar(cookies: Record<string, string>) {
  return { get: (name: string) => (name in cookies ? { value: cookies[name]! } : undefined) };
}

const mark = (tag: string) => `${ENDED_MARK_COOKIE}-${tag}`;

// The input classes of the contract on #1836 (D-288 t. a), one row each.
describe("liveSessionToken: input classes", () => {
  const rows: Array<[string, Record<string, string>, string | undefined]> = [
    ["1 no session cookie", { [mark(TAG)]: "1" }, undefined],
    ["2 malformed session cookie", { [SESSION_COOKIE_NAME]: "kratko", [mark(TAG)]: "1" }, "kratko"],
    ["3 valid cookie, no marks", { [SESSION_COOKIE_NAME]: TOKEN }, TOKEN],
    ["4 own mark", { [SESSION_COOKIE_NAME]: TOKEN, [mark(TAG)]: "1" }, undefined],
    [
      "5 only another session's mark",
      { [SESSION_COOKIE_NAME]: TOKEN, [mark(OTHER_TAG)]: "1" },
      TOKEN,
    ],
    [
      "6 own mark with an empty value",
      { [SESSION_COOKIE_NAME]: TOKEN, [mark(TAG)]: "" },
      undefined,
    ],
    [
      "7 legacy list holding the own tag",
      { [SESSION_COOKIE_NAME]: TOKEN, [ENDED_MARK_COOKIE]: `${OTHER_TAG}.${TAG}` },
      undefined,
    ],
    [
      "8 legacy list without the own tag",
      { [SESSION_COOKIE_NAME]: TOKEN, [ENDED_MARK_COOKIE]: `${OTHER_TAG}.abc` },
      TOKEN,
    ],
    [
      "9 own tag in upper case",
      {
        [SESSION_COOKIE_NAME]: TOKEN,
        [mark(TAG.toUpperCase())]: "1",
        [ENDED_MARK_COOKIE]: TAG.toUpperCase(),
      },
      TOKEN,
    ],
    [
      "10 several marks, the own among them",
      { [SESSION_COOKIE_NAME]: TOKEN, [mark(OTHER_TAG)]: "1", [mark(TAG)]: "1" },
      undefined,
    ],
    [
      "11 a name that only starts with the own tag",
      {
        [SESSION_COOKIE_NAME]: TOKEN,
        [`${mark(TAG)}x`]: "1",
        [ENDED_MARK_COOKIE]: `${TAG}x.x${TAG}`,
      },
      TOKEN,
    ],
  ];

  it.each(rows)("%s", (ignored, cookies, expected) => {
    expect(liveSessionToken(jar(cookies))).toBe(expected);
  });

  it("asks for nothing but cookies by name and changes none", () => {
    const asked: string[] = [];
    const cookies = { [SESSION_COOKIE_NAME]: TOKEN, [mark(TAG)]: "1" };
    liveSessionToken({
      get: (name) => {
        asked.push(name);
        return jar(cookies).get(name);
      },
    });
    expect(asked).toEqual([SESSION_COOKIE_NAME, mark(TAG)]);
    expect(cookies).toEqual({ [SESSION_COOKIE_NAME]: TOKEN, [mark(TAG)]: "1" });
  });
});

// DAN-851-1d1 (contract Ductus#1836 c.6938624974): the same rule over a raw
// Cookie header, as node:http gives it.
describe("liveSessionTokenFromCookie", () => {
  const session = `${SESSION_COOKIE_NAME}=${TOKEN}`;
  it.each<[string, string | readonly string[] | undefined, string | undefined]>([
    ["no header", undefined, undefined],
    ["only the session cookie", session, TOKEN],
    ["a list of headers", ["a=b", session], TOKEN],
    ["a tab before the pair", `a=b;\t${session}`, TOKEN],
    ["two session cookies", `${session}; ${session}`, undefined],
    ["a malformed session cookie", `${SESSION_COOKIE_NAME}=kratko`, undefined],
    ["its own mark", `${session}; ${mark(TAG)}=1`, undefined],
    ["its own mark with an empty value", `${mark(TAG)}=; ${session}`, undefined],
    ["its own mark in a second header", [session, `${mark(TAG)}=1`], undefined],
    ["another session's mark", `${session}; ${mark(OTHER_TAG)}=1`, TOKEN],
    ["the old list naming it", `${session}; ${ENDED_MARK_COOKIE}=${OTHER_TAG}.${TAG}`, undefined],
    ["the old list without it", `${session}; ${ENDED_MARK_COOKIE}=${OTHER_TAG}`, TOKEN],
    [
      "a second old list naming it",
      `${ENDED_MARK_COOKIE}=${OTHER_TAG}; ${session}; ${ENDED_MARK_COOKIE}=${TAG}`,
      undefined,
    ],
    ["a tag only as a prefix in the old list", `${session}; ${ENDED_MARK_COOKIE}=${TAG}x`, TOKEN],
    ["the mark name upper-cased", `${session}; ${mark(TAG).toUpperCase()}=1`, TOKEN],
  ])("%s", (_name, header, expected) => {
    expect(liveSessionTokenFromCookie(header)).toBe(expected);
  });
});
