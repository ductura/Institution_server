// DAN-805, plan of attack ductura/server#98 part A. Every token is invented.
import { describe, expect, it } from "vitest";

import { sessionTokenFromCookie } from "./cookie.ts";

const NAME = "__Host-ductus_session";
const A = "A".repeat(21) + "-_" + "b".repeat(20);
const B = "z".repeat(43);

describe("sessionTokenFromCookie", () => {
  it("reads exactly one well-formed session cookie among others", () => {
    expect(sessionTokenFromCookie(`${NAME}=${A}`)).toBe(A);
    expect(sessionTokenFromCookie(`theme=dark; ${NAME}=${A}; lang=hr`)).toBe(A);
    expect(sessionTokenFromCookie(`x=1;\t${NAME}=${A}`)).toBe(A);
    expect(sessionTokenFromCookie(["x=1", `${NAME}=${A}`])).toBe(A);
  });

  it("A1, A2: no header, an empty one or only separators give no token", () => {
    for (const header of [undefined, "", ";", " ; ; ", "   ", []]) {
      expect(sessionTokenFromCookie(header)).toBeUndefined();
    }
  });

  it("A3, A4: two session cookies give no token, in one header or in two", () => {
    expect(sessionTokenFromCookie(`${NAME}=${A}; ${NAME}=${B}`)).toBeUndefined();
    expect(sessionTokenFromCookie(`${NAME}=${A}; ${NAME}=${A}`)).toBeUndefined();
    expect(sessionTokenFromCookie([`${NAME}=${A}`, `${NAME}=${B}`])).toBeUndefined();
    // A malformed planted twin still makes the pair ambiguous.
    expect(sessionTokenFromCookie(`${NAME}=; ${NAME}=${A}`)).toBeUndefined();
    expect(sessionTokenFromCookie(`${NAME}=${A}; ${NAME}`)).toBe(A);
  });

  it("A5: another name, case or spelling is not the session cookie", () => {
    for (const name of [
      "ductus_session",
      "__host-ductus_session",
      "__HOST-ductus_session",
      "__Host-ductus_Session",
      "__Host-ductus%5Fsession",
      "__Secure-ductus_session",
      `${NAME} `,
      ` ${NAME}x`,
    ]) {
      expect(sessionTokenFromCookie(`${name}=${A}`)).toBeUndefined();
    }
  });

  it("A6: a value is never unquoted, trimmed or decoded", () => {
    for (const value of [
      `"${A}"`,
      ` ${A}`,
      `${A} `,
      `${A}\t`,
      `%41${A.slice(1)}`,
      `${A.slice(0, 40)}%3D`,
    ]) {
      expect(sessionTokenFromCookie(`${NAME}=${value}`)).toBeUndefined();
      expect(sessionTokenFromCookie(`${NAME}=${value}; x=1`)).toBeUndefined();
    }
  });

  it("A7: only 43 base64url characters are a token", () => {
    for (const value of [
      A.slice(1),
      `${A}x`,
      `${A.slice(1)}+`,
      `${A.slice(1)}/`,
      `${A.slice(1)}=`,
      `${A.slice(1)}\u0000`,
      `${A.slice(1)}\u0007`,
      `${A.slice(1)}é`,
      `${A.slice(1)}а`,
      `${A.slice(1)}ÿ`,
      `${A.slice(1)}\n`,
    ]) {
      expect(sessionTokenFromCookie(`${NAME}=${value}`)).toBeUndefined();
    }
  });

  it("A9: ended-session marks and other __Host- cookies change nothing", () => {
    const header = `ductus-ended-0123456789abcdef=1; ductus-ended=aa.bb; __Host-other=${B}; ${NAME}=${A}`;
    expect(sessionTokenFromCookie(header)).toBe(A);
  });

  it("A10: a pair without = or with an empty value is not a token; = inside a value fails the form", () => {
    expect(sessionTokenFromCookie(NAME)).toBeUndefined();
    expect(sessionTokenFromCookie(`${NAME}=`)).toBeUndefined();
    expect(sessionTokenFromCookie(`${NAME}==${A.slice(1)}`)).toBeUndefined();
    expect(sessionTokenFromCookie(`${NAME}=${A}=`)).toBeUndefined();
  });

  it("A11: prototype names neither change the outcome nor throw", () => {
    const noise = "__proto__=x; constructor=y; hasOwnProperty=z; toString=w";
    expect(sessionTokenFromCookie(noise)).toBeUndefined();
    expect(sessionTokenFromCookie(`${noise}; ${NAME}=${A}`)).toBe(A);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});
