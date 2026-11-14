import { expect, test } from "vitest";

import { createFakeOidc, listenPort, type FakeOidcOptions } from "./server.ts";

// Input classes of PORT: unset is the default, a whole number in range is
// itself, anything else stops the provider with a message naming PORT.
const ACCEPTED: [string | undefined, number][] = [
  [undefined, 8080],
  ["0", 0],
  ["8090", 8090],
  ["65535", 65535],
  ["08090", 8090],
];
for (const [value, port] of ACCEPTED) {
  test(`PORT ${JSON.stringify(value)} is ${port}`, () => expect(listenPort(value)).toBe(port));
}
for (const value of [
  "",
  " ",
  "abc",
  "-1",
  "65536",
  "99999",
  "80.5",
  "1e3",
  " 8090",
  "8090 ",
  "0x1f90",
  "123456",
]) {
  test(`PORT ${JSON.stringify(value)} is refused`, () =>
    expect(() => listenPort(value)).toThrow(/PORT/));
}

test("createFakeOidc refuses a mode outside the four, as the environment does", () => {
  const options = {
    issuer: "http://localhost:8080",
    redirectUris: ["http://localhost:3000/api/auth/callback"],
    postLogoutRedirectUris: ["http://localhost:3000/"],
    backchannelLogoutUri: "http://localhost:3000/api/auth/backchannel-logout",
    mode: "bogus",
  } as unknown as FakeOidcOptions;
  expect(() => createFakeOidc(options)).toThrow(/FAKE_OIDC_MODE/);
  expect(() => createFakeOidc({ ...options, mode: "refuse" })).not.toThrow();
});
