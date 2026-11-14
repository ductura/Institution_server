// Ported from Ductus infra/fake-oidc/redirect-uris.test.mjs (DAN-729): the
// same cases, node:test replaced by vitest.
import { expect, test } from "vitest";

import { DEFAULT_POST_LOGOUT_REDIRECT_URIS, DEFAULT_REDIRECT_URIS, loopbackIssuer, redirectUriList } from "./redirect-uris.ts";

const FALLBACK = ["http://localhost:3000/x"];

// Input classes of the parser: unset, empty, blank, one address, several,
// padded, trailing separator, repeated, not an address, not http(s).
const ACCEPTED: [string, string | undefined, string[]][] = [
  ["unset uses the fallback", undefined, FALLBACK],
  ["empty uses the fallback", "", FALLBACK],
  ["blank uses the fallback", "  \t ", FALLBACK],
  ["one address", "https://localhost:3000/a", ["https://localhost:3000/a"]],
  ["two addresses keep their order", "http://localhost:3000/a,https://localhost:3000/a", ["http://localhost:3000/a", "https://localhost:3000/a"]],
  ["padding is trimmed", " http://localhost:3000/a , https://localhost:3000/a ", ["http://localhost:3000/a", "https://localhost:3000/a"]],
  ["a trailing separator adds nothing", "https://localhost:3000/a,", ["https://localhost:3000/a"]],
  ["a repeated address is kept once", "https://localhost:3000/a,https://localhost:3000/a", ["https://localhost:3000/a"]],
];
for (const [name, value, expected] of ACCEPTED) {
  test(`redirect list: ${name}`, () => expect(redirectUriList(value, FALLBACK)).toStrictEqual(expected));
}

const REFUSED: [string, string][] = [
  ["not an address", "localhost:3000/a"],
  ["a script scheme", "javascript:alert(1)"],
  ["a file scheme", "file:///etc/passwd"],
  ["one bad entry among good ones", "https://localhost:3000/a,nonsense"],
  ["only separators", " , ,"],
  // F-019: only this machine. Hosts are invented.
  ["another host", "https://ductus.example.test/api/auth/callback"],
  ["a host that starts with a loopback name", "http://localhost.example.test:3000/a"],
  ["a host that starts with a loopback address", "http://127.0.0.1.example.test:3000/a"],
  ["another loopback-looking address", "http://127.0.0.2:3000/a"],
  ["a foreign entry among local ones", "https://localhost:3000/a,https://ductus.example.test/a"],
];
for (const [name, value] of REFUSED) {
  test(`redirect list refuses ${name}`, () => expect(() => redirectUriList(value, FALLBACK)).toThrow(/redirect/i));
}

test("the defaults register the callback and the way back for http and https, on the one app origin", () => {
  expect(DEFAULT_REDIRECT_URIS).toStrictEqual([
    "http://localhost:3000/api/auth/callback",
    "https://localhost:3000/api/auth/callback",
    "https://127.0.0.1:3000/api/auth/callback",
  ]);
  expect(DEFAULT_POST_LOGOUT_REDIRECT_URIS).toStrictEqual(["http://localhost:3000/", "https://localhost:3000/", "https://127.0.0.1:3000/"]);
});

test("the issuer defaults to the local one and accepts only this machine", () => {
  expect(loopbackIssuer(undefined, "http://localhost:8080")).toBe("http://localhost:8080");
  for (const issuer of ["http://localhost:8090", "https://127.0.0.1:8090/oidc", "http://[::1]:8090"]) {
    expect(loopbackIssuer(issuer, "http://localhost:8080")).toBe(issuer);
  }
  for (const issuer of ["https://idp.example.test", "http://localhost.example.test:8090", "http://127.0.0.2:8090", "ftp://localhost", "localhost:8090", ""]) {
    expect(() => loopbackIssuer(issuer, "http://localhost:8080"), issuer).toThrow(/ISSUER/);
  }
});
