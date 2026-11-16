import { describe, expect, it } from "vitest";

import { previousSessionToken, sessionSetCookie } from "./login-cookie.ts";
import { SESSION_COOKIE_NAME } from "./session-token.ts";

const TOKEN = "a".repeat(43);

describe("previousSessionToken", () => {
  it.each([
    [null, undefined],
    ["", undefined],
    [`${SESSION_COOKIE_NAME}=${TOKEN}`, TOKEN],
    [`other=1; ${SESSION_COOKIE_NAME} = ${TOKEN} ; x=2`, TOKEN],
    [`${SESSION_COOKIE_NAME}=first; ${SESSION_COOKIE_NAME}=second`, "first"],
    [`x${SESSION_COOKIE_NAME}=${TOKEN}`, undefined],
    [`${SESSION_COOKIE_NAME.toLowerCase()}=${TOKEN}`, undefined],
    [`=${TOKEN}; ${SESSION_COOKIE_NAME}`, undefined],
  ])("reads %j as %j", (header, expected) => {
    expect(previousSessionToken(header)).toBe(expected);
  });
});

describe("sessionSetCookie", () => {
  it("sets the __Host- cookie with HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, and Expires", () => {
    const expires = new Date("2030-01-01T12:00:00Z");
    expect(sessionSetCookie(TOKEN, expires)).toBe(
      `${SESSION_COOKIE_NAME}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Tue, 01 Jan 2030 12:00:00 GMT`,
    );
    expect(sessionSetCookie(TOKEN, expires)).not.toMatch(/Domain/i);
  });
});
