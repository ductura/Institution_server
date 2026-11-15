import { describe, expect, test } from "vitest";

import { assertFakeOidcAllowed } from "./guard.ts";
import { fakeOidcMode } from "./modes.ts";

// D-09: the fake provider runs only locally and in CI. Input classes of
// NODE_ENV: unset and the two local values start; production in any spelling,
// any other environment name and padded values stop it (an allow list, so a
// value nobody thought of is refused, not let through).
describe("NODE_ENV guard", () => {
  const ALLOWED: [string, string | undefined][] = [
    ["unset", undefined],
    ["empty", ""],
    ["development", "development"],
    ["test", "test"],
  ];
  for (const [name, value] of ALLOWED) {
    test(`starts with NODE_ENV ${name}`, () => {
      expect(() => assertFakeOidcAllowed({ NODE_ENV: value })).not.toThrow();
    });
  }
  test("starts with no NODE_ENV key at all", () => {
    expect(() => assertFakeOidcAllowed({})).not.toThrow();
  });

  const REFUSED = [
    "production",
    "Production",
    "PRODUCTION",
    " production",
    "production ",
    "prod",
    "staging",
    " test ",
    "Test",
    "development\n",
  ];
  for (const value of REFUSED) {
    test(`refuses NODE_ENV ${JSON.stringify(value)}`, () => {
      expect(() => assertFakeOidcAllowed({ NODE_ENV: value })).toThrow(/fake OIDC/);
    });
  }
});

// Input classes of FAKE_OIDC_MODE: unset and empty mean success, the four
// names are themselves, any other spelling stops the provider.
describe("FAKE_OIDC_MODE", () => {
  const ACCEPTED: [string | undefined, string][] = [
    [undefined, "success"],
    ["", "success"],
    ["success", "success"],
    ["refuse", "refuse"],
    ["expired", "expired"],
    ["unavailable", "unavailable"],
  ];
  for (const [value, mode] of ACCEPTED) {
    test(`${JSON.stringify(value)} is ${mode}`, () => expect(fakeOidcMode(value)).toBe(mode));
  }
  for (const value of [
    "SUCCESS",
    "expire",
    " refuse",
    "refuse ",
    "none",
    "toString",
    "__proto__",
  ]) {
    test(`refuses ${JSON.stringify(value)}`, () =>
      expect(() => fakeOidcMode(value)).toThrow(/FAKE_OIDC_MODE/));
  }
});
