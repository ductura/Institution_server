import { describe, expect, it } from "vitest";

import { AuthConfigError, loadAuthConfig } from "./config.ts";

// STG-PRIJAVA (Ductus#2055, owner decision of 23. 11. 2026.): a production
// build (NODE_ENV unset) accepts the fake provider only with
// DUCTURA_DEPLOYMENT=staging and an APP_ORIGIN outside the production domain.
// Synthetic hosts only; ductura-proba.hr stands for any staging domain.
const STAGING = {
  DUCTURA_DEPLOYMENT: "staging",
  APP_ORIGIN: "https://staging.ductura-proba.hr",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: "https://oidc.ductura-proba.hr",
  OIDC_CLIENT_ID: "ductura-staging",
  OIDC_CLIENT_SECRET: "staging-secret-that-must-not-leak",
  OIDC_REDIRECT_URI: "https://staging.ductura-proba.hr/api/v1/auth/callback",
};
const AAI = {
  DUCTUS_AUTH_PROVIDER: "aai-eduhr",
  OIDC_ISSUER: "https://idp.aai.example.hr",
  OIDC_CLIENT_ID: "ductura",
  OIDC_CLIENT_SECRET: "aai-secret-that-must-not-leak",
  OIDC_REDIRECT_URI: "https://ductura.org/api/v1/auth/callback",
};

type Env = Record<string, string | undefined>;

function refusal(env: Env): string {
  try {
    loadAuthConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthConfigError);
    const message = (error as Error).message;
    // Names, never values: neither the secret nor an address reaches the message.
    for (const name of ["OIDC_CLIENT_SECRET", "APP_ORIGIN", "OIDC_ISSUER", "OIDC_REDIRECT_URI"]) {
      const value = env[name];
      if (value !== undefined && value.length > 8) expect(message).not.toContain(value);
    }
    return message;
  }
  throw new Error("configuration was accepted");
}

const without = (env: Env, name: string): Env => {
  const copy = { ...env };
  delete copy[name];
  return copy;
};

describe("the fake provider in a production build (D-09)", () => {
  it("is refused without the staging variable, as before", () => {
    expect(refusal(without(STAGING, "DUCTURA_DEPLOYMENT"))).toMatch(/prohibited in production/);
    expect(refusal({ ...STAGING, NODE_ENV: "production", DUCTURA_DEPLOYMENT: undefined })).toMatch(
      /prohibited in production/,
    );
  });

  it.each([
    ["", "empty"],
    ["Staging", "another letter case"],
    ["staging ", "a trailing space"],
    ["staging\n", "a newline"],
    ["production", "production"],
    ["test", "test"],
    ["stage", "a near miss"],
  ])("is refused with DUCTURA_DEPLOYMENT %j (%s)", (value) => {
    expect(refusal({ ...STAGING, DUCTURA_DEPLOYMENT: value })).toMatch(/prohibited in production/);
  });

  it.each([
    "https://ductura.org",
    "https://www.ductura.org",
    "https://WWW.Ductura.Org",
    "https://ductura.org.",
    "https://app.ductura.org",
    "https://staging.ductura.org",
  ])("is refused with the staging variable on the production origin %s", (origin) => {
    const redirect = `${origin}/api/v1/auth/callback`;
    expect(refusal({ ...STAGING, APP_ORIGIN: origin, OIDC_REDIRECT_URI: redirect })).toMatch(
      /prohibited in production/,
    );
  });

  it.each<[string | undefined, string]>([
    [undefined, "unset"],
    ["", "empty"],
    ["http://staging.ductura-proba.hr", "plain http"],
    ["https://staging.ductura-proba.hr/", "a trailing slash"],
    ["https://staging.ductura-proba.hr/app", "a path"],
    ["https://user@staging.ductura-proba.hr", "credentials"],
    ["staging.ductura-proba.hr", "no scheme"],
  ])("is refused with APP_ORIGIN %j (%s)", (origin) => {
    expect(refusal({ ...STAGING, APP_ORIGIN: origin })).toMatch(/prohibited in production/);
  });

  it("reads only own properties: an inherited staging switch opens nothing", () => {
    const env = Object.create({ DUCTURA_DEPLOYMENT: "staging" }) as Env;
    Object.assign(env, without(STAGING, "DUCTURA_DEPLOYMENT"));
    expect(refusal(env)).toMatch(/prohibited in production/);
  });

  it("is accepted with the staging variable on a staging origin", () => {
    const config = loadAuthConfig(STAGING);
    expect(config.provider).toBe("fake-oidc");
    expect(config.issuer.href).toBe("https://oidc.ductura-proba.hr/");
    expect(config.redirectUri.origin).toBe(STAGING.APP_ORIGIN);
    expect(config.postLogoutRedirectUri.href).toBe("https://staging.ductura-proba.hr/");
    // Still a production build: TLS only, the pinned algorithm as before.
    expect(config.allowInsecureRequests).toBe(false);
    expect(config.idTokenAlg).toBe("RS256");
  });

  it("keeps the production rules of the addresses on staging", () => {
    expect(refusal({ ...STAGING, OIDC_ISSUER: "http://oidc.ductura-proba.hr" })).toMatch(
      /OIDC_ISSUER must be an https URL of a public host/,
    );
    expect(refusal({ ...STAGING, OIDC_ISSUER: "https://localhost:8090" })).toMatch(
      /OIDC_ISSUER must be an https URL of a public host/,
    );
    expect(refusal({ ...STAGING, OIDC_ISSUER: "https://10.0.0.5" })).toMatch(
      /OIDC_ISSUER must be an https URL of a public host/,
    );
  });

  it("sends the browser back only to the staging origin", () => {
    expect(
      refusal({
        ...STAGING,
        OIDC_REDIRECT_URI: "https://other.ductura-proba.hr/api/v1/auth/callback",
      }),
    ).toMatch(/OIDC_REDIRECT_URI of the fake provider on staging must be on APP_ORIGIN/);
    expect(
      refusal({ ...STAGING, OIDC_REDIRECT_URI: "https://ductura.org/api/v1/auth/callback" }),
    ).toMatch(/must be on APP_ORIGIN/);
  });

  it("refuses an issuer of the production domain on staging", () => {
    for (const issuer of ["https://ductura.org", "https://oidc.ductura.org"]) {
      expect(refusal({ ...STAGING, OIDC_ISSUER: issuer })).toMatch(
        /OIDC_ISSUER of the fake provider on staging must be outside the production domain/,
      );
    }
  });

  it("keeps refusing outside a production build only what it refused before", () => {
    // The local rules still apply under NODE_ENV development: loopback issuer only.
    expect(refusal({ ...STAGING, NODE_ENV: "development" })).toMatch(/must be a loopback host/);
  });
});

describe("AAI@EduHr is unchanged by the staging switch", () => {
  it("is accepted in production with and without it", () => {
    expect(loadAuthConfig(AAI).provider).toBe("aai-eduhr");
    const staging = {
      ...AAI,
      DUCTURA_DEPLOYMENT: "staging",
      APP_ORIGIN: "https://staging.ductura-proba.hr",
      OIDC_REDIRECT_URI: "https://staging.ductura-proba.hr/api/v1/auth/callback",
    };
    const config = loadAuthConfig(staging);
    expect(config.provider).toBe("aai-eduhr");
    expect(config.allowInsecureRequests).toBe(false);
  });

  it("takes no staging rule: the redirect need not be on APP_ORIGIN", () => {
    const config = loadAuthConfig({
      ...AAI,
      DUCTURA_DEPLOYMENT: "staging",
      APP_ORIGIN: "https://staging.ductura-proba.hr",
    });
    expect(config.redirectUri.origin).toBe("https://ductura.org");
  });
});
