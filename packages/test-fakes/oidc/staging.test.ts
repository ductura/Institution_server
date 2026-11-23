// STG-OIDC (Ductus#2055): the staging mode of the fake provider opens only
// with DUCTURA_DEPLOYMENT=staging, and never weakens the local mode (F-019).
import { afterEach, describe, expect, test, vi } from "vitest";

import { createFakeOidc, fakeOidcConfigFromEnv, type FakeOidcOptions } from "./server.ts";
import { isProductionHost, isStagingMode, STAGING_CLIENT_ID } from "./staging.ts";

afterEach(() => vi.unstubAllEnvs());

const APP = "https://ductura-staging.vercel.app";
const ISSUER = "https://ductura-fake-oidc-staging.onrender.com";
// Invented test values of the required length, not secrets of any service.
const SECRET = "test-client-secret-0123456789abcdef";
const COOKIE = "test-cookie-key-0123456789abcdefghij";

// Environment names as entries: they are fixed outside this code.
const STAGING_ENV: Readonly<Record<string, string>> = Object.fromEntries([
  ["DUCTURA_DEPLOYMENT", "staging"],
  ["APP_ORIGIN", APP],
  ["ISSUER", ISSUER],
  ["FAKE_OIDC_CLIENT_SECRET", SECRET],
  ["FAKE_OIDC_COOKIE_KEY", COOKIE],
  ["PORT", "10000"],
]);
const COOKIE_KEY = "FAKE_OIDC_COOKIE_KEY";

const config = (changes: Readonly<Record<string, string | undefined>>) => {
  const env: Record<string, string> = { ...STAGING_ENV };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(env, name);
    else env[name] = value;
  }
  return fakeOidcConfigFromEnv(env);
};

describe("without DUCTURA_DEPLOYMENT the local provider is as before", () => {
  test("a public issuer is refused", () => {
    for (const issuer of [ISSUER, "https://example.test", "http://0.0.0.0:8080"]) {
      expect(() => fakeOidcConfigFromEnv({ NODE_ENV: "test", ISSUER: issuer })).toThrow(/ISSUER/);
    }
  });

  test("a redirect off this machine is refused", () => {
    expect(() =>
      fakeOidcConfigFromEnv({ NODE_ENV: "test", REDIRECT_URI: `${APP}/api/v1/auth/callback` }),
    ).toThrow(/redirect URI/);
  });

  test("it never listens on 0.0.0.0, and the staging variables do not open anything", () => {
    const rest = Object.fromEntries(
      Object.entries(STAGING_ENV).filter(
        ([name]) => name !== "DUCTURA_DEPLOYMENT" && name !== "ISSUER",
      ),
    );
    const { host, options } = fakeOidcConfigFromEnv({ ...rest, NODE_ENV: "test" });
    expect(host).toBe("127.0.0.1");
    expect(options.staging).toBeUndefined();
    expect(options.issuer).toBe("http://localhost:10000");
  });

  test("createFakeOidc refuses a public issuer", () => {
    const local: FakeOidcOptions = {
      issuer: ISSUER,
      redirectUris: ["http://localhost:3000/api/auth/callback"],
      postLogoutRedirectUris: ["http://localhost:3000/"],
      backchannelLogoutUri: "http://localhost:3000/api/auth/backchannel-logout",
      mode: "success",
    };
    expect(() => createFakeOidc(local)).toThrow(/ISSUER/);
  });

  test("a production NODE_ENV stops it with or without staging (D-09)", () => {
    expect(() => fakeOidcConfigFromEnv({ NODE_ENV: "production" })).toThrow(/NODE_ENV/);
    expect(() => config({ NODE_ENV: "production" })).toThrow(/NODE_ENV/);
  });
});

describe("DUCTURA_DEPLOYMENT is read as the server reads it", () => {
  test("only exactly staging opens the mode; any other value stops the provider", () => {
    expect(isStagingMode({})).toBe(false);
    expect(isStagingMode({ DUCTURA_DEPLOYMENT: "staging" })).toBe(true);
    for (const value of ["", "Staging", "STAGING", " staging", "staging ", "production", "local"]) {
      expect(() => isStagingMode({ DUCTURA_DEPLOYMENT: value })).toThrow(/DUCTURA_DEPLOYMENT/);
      expect(() => config({ DUCTURA_DEPLOYMENT: value })).toThrow(/DUCTURA_DEPLOYMENT/);
    }
  });

  test("an inherited value is not the variable", () => {
    const env = Object.create({ DUCTURA_DEPLOYMENT: "staging" }) as Record<string, string>;
    expect(isStagingMode(env)).toBe(false);
  });

  test("the production domain is ductura.org and every name under it", () => {
    for (const host of [
      "ductura.org",
      "DUCTURA.ORG",
      "ductura.org.",
      "www.ductura.org",
      "a.b.ductura.org",
    ]) {
      expect(isProductionHost(host), host).toBe(true);
    }
    for (const host of ["ductura.org.evil.test", "notductura.org", "ductura.com"]) {
      expect(isProductionHost(host), host).toBe(false);
    }
  });
});

describe("staging refuses", () => {
  test("an issuer or an APP_ORIGIN on the production domain", () => {
    for (const host of ["ductura.org", "auth.ductura.org", "Login.Ductura.Org", "ductura.org."]) {
      expect(() => config({ ISSUER: `https://${host}` }), host).toThrow(/ISSUER/);
      expect(() => config({ APP_ORIGIN: `https://${host}` }), host).toThrow(/APP_ORIGIN/);
    }
  });

  test("an issuer that is not a plain https address of a public host", () => {
    for (const issuer of [
      undefined,
      "",
      "http://ductura-fake-oidc-staging.onrender.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.5",
      "https://fake-oidc",
      "https://fake-oidc.internal",
      "https://user:pw@ductura-fake-oidc-staging.onrender.com",
      "https://ductura-fake-oidc-staging.onrender.com:8443",
      "https://ductura-fake-oidc-staging.onrender.com/?x=1",
      "not an address",
    ]) {
      expect(() => config({ ISSUER: issuer }), String(issuer)).toThrow(/ISSUER/);
    }
  });

  test("an APP_ORIGIN that is missing, http, or not a bare origin", () => {
    for (const origin of [
      undefined,
      "",
      "http://ductura-staging.vercel.app",
      `${APP}/`,
      `${APP}/app`,
      "https://localhost",
    ]) {
      expect(() => config({ APP_ORIGIN: origin }), String(origin)).toThrow(/APP_ORIGIN/);
    }
  });

  test("a redirect, post-logout or back-channel address outside APP_ORIGIN", () => {
    for (const name of ["REDIRECT_URI", "POST_LOGOUT_REDIRECT_URI", "BACKCHANNEL_LOGOUT_URI"]) {
      for (const address of [
        "https://evil.example.test/api/v1/auth/callback",
        "http://ductura-staging.vercel.app/api/v1/auth/callback",
        "https://ductura-staging.vercel.app:444/api/v1/auth/callback",
        "https://preview-git-x.vercel.app/api/v1/auth/callback",
        "https://ductura.org/api/v1/auth/callback",
        "http://localhost:3000/api/auth/callback",
        `${APP}/api/v1/auth/callback,https://evil.example.test/`,
        `https://user@ductura-staging.vercel.app/`,
        `${APP}/?next=https://evil.example.test`,
      ]) {
        expect(() => config({ [name]: address }), `${name} ${address}`).toThrow(new RegExp(name));
      }
    }
  });

  test("a client secret or cookie key that is missing, short, local or shared", () => {
    for (const name of ["FAKE_OIDC_CLIENT_SECRET", "FAKE_OIDC_COOKIE_KEY"]) {
      for (const value of [
        undefined,
        "",
        "short",
        "x".repeat(31),
        "ductus-local-only",
        "ductus-fake-oidc-local-only",
        ` ${"y".repeat(32)}`,
      ]) {
        expect(() => config({ [name]: value }), `${name} ${String(value)}`).toThrow(
          new RegExp(name),
        );
      }
    }
    expect(() => config({ [COOKIE_KEY]: SECRET })).toThrow(/must differ/);
  });

  test("an accounts file: only the demo-* accounts sign in", () => {
    expect(() =>
      config(Object.fromEntries([["FAKE_OIDC_ACCOUNTS_FILE", "/tmp/racuni.json"]])),
    ).toThrow(/demo-\*/);
  });
});

describe("staging accepts", () => {
  test("a public issuer, the defaults on APP_ORIGIN, the secrets from the environment, every interface", () => {
    const { port, host, options } = config({});
    expect(port).toBe(10000);
    expect(host).toBe("0.0.0.0");
    expect(options).toMatchObject({
      issuer: ISSUER,
      redirectUris: [`${APP}/api/v1/auth/callback`],
      postLogoutRedirectUris: [`${APP}/app/web/`],
      backchannelLogoutUri: `${APP}/api/v1/auth/backchannel-logout`,
      mode: "success",
      accounts: [],
      staging: {
        appOrigin: APP,
        clientId: STAGING_CLIENT_ID,
        clientSecret: SECRET,
        cookieKey: COOKIE,
      },
    });
  });

  test("addresses named on APP_ORIGIN", () => {
    const { options } = config({
      REDIRECT_URI: `${APP}/api/v1/auth/callback, ${APP}/drugi/callback`,
      POST_LOGOUT_REDIRECT_URI: `${APP}/`,
    });
    expect(options.redirectUris).toEqual([`${APP}/api/v1/auth/callback`, `${APP}/drugi/callback`]);
    expect(options.postLogoutRedirectUris).toEqual([`${APP}/`]);
  });
});

describe("createFakeOidc with staging options", () => {
  const { options } = config({});

  test("is refused in a process without DUCTURA_DEPLOYMENT=staging", () => {
    expect(() => createFakeOidc(options)).toThrow(/DUCTURA_DEPLOYMENT/);
    vi.stubEnv("DUCTURA_DEPLOYMENT", "staging");
    expect(() => createFakeOidc(options, { NODE_ENV: "test" })).toThrow(/DUCTURA_DEPLOYMENT/);
  });

  test("is built in a staging process, and refused when an option leaves the rules", () => {
    vi.stubEnv("DUCTURA_DEPLOYMENT", "staging");
    expect(() => createFakeOidc(options)).not.toThrow();
    const staging = options.staging!;
    const refused: FakeOidcOptions[] = [
      { ...options, issuer: "https://auth.ductura.org" },
      { ...options, issuer: "http://localhost:8090" },
      { ...options, redirectUris: ["https://evil.example.test/cb"] },
      { ...options, redirectUris: [] },
      { ...options, postLogoutRedirectUris: ["http://localhost:3000/"] },
      { ...options, backchannelLogoutUri: "https://evil.example.test/bc" },
      {
        ...options,
        accounts: [
          { role: "student", user: "x", domain: "fpzg.hr", givenName: "Iva", familyName: "Ivić" },
        ],
      },
      { ...options, staging: { ...staging, appOrigin: "https://ductura.org" } },
      { ...options, staging: { ...staging, clientSecret: "ductus-local-only" } },
      { ...options, staging: { ...staging, cookieKey: staging.clientSecret } },
      { ...options, staging: { ...staging, clientId: "ductus-local" } },
    ];
    for (const bad of refused) expect(() => createFakeOidc(bad)).toThrow();
  });

  test("local options in a staging process stay on loopback (F-019)", () => {
    vi.stubEnv("DUCTURA_DEPLOYMENT", "staging");
    const local: FakeOidcOptions = {
      issuer: options.issuer,
      redirectUris: options.redirectUris,
      postLogoutRedirectUris: options.postLogoutRedirectUris,
      backchannelLogoutUri: options.backchannelLogoutUri,
      mode: options.mode,
    };
    expect(() => createFakeOidc(local)).toThrow(/ISSUER/);
  });
});
