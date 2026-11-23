// The staging mode of the fake provider (STG-OIDC, Ductus#2055; owner decision
// of 23. 11. 2026., "Idemo B"): until an institution agrees to be the home of
// a test AAI@EduHr client, staging signs in through this provider, run as its
// own Render service (infra/fake-oidc/Dockerfile, render.staging.yaml), never
// as a route of the server (U9).
//
// It opens only with DUCTURA_DEPLOYMENT exactly "staging", read as
// server/settings/deployment.ts reads it (an own string property; any other
// value stops the provider). Without the variable nothing changes: the local
// provider keeps its loopback issuer and addresses (F-019) and its NODE_ENV
// guard (guard.ts), which staging keeps as well. In staging:
// - APP_ORIGIN is a bare https origin outside the production domain, and every
//   address the provider sends a browser or a logout token to is on it;
// - the issuer is an https address of a public host outside the production
//   domain (the same rule as isProductionHost);
// - the client secret and the cookie key come from the environment, at least
//   32 characters each and never the local ones;
// - only the invented demo-* accounts sign in, no form and no accounts file;
// - it listens on 0.0.0.0 (Render routes to the container) and every answer
//   carries X-Ductura-Deployment: staging.
// This file imports nothing from server/ (boundary of @ductura/test-fakes), so
// the two small rules it shares with deployment.ts are repeated here.

type Env = Readonly<Record<string, string | undefined>>;

export const DEPLOYMENT_VARIABLE = "DUCTURA_DEPLOYMENT";
export const STAGING = "staging";
export const PRODUCTION_DOMAIN = "ductura.org";
/** The header every answer of the staging provider carries. */
export const DEPLOYMENT_HEADER = "x-ductura-deployment";
/** The client the staging server signs in as (OIDC_CLIENT_ID in docs/STAGING.md). */
export const STAGING_CLIENT_ID = "ductura-staging";
export const MIN_SECRET_LENGTH = 32;
/** The values of the local provider; staging never takes them. */
const LOCAL_SECRETS = new Set(["ductus-local-only", "ductus-fake-oidc-local-only"]);

/** Server paths behind APP_ORIGIN (the front forwards /api/v1 to the server). */
const CALLBACK_PATH = "/api/v1/auth/callback";
const POST_LOGOUT_PATH = "/app/web/";
const BACKCHANNEL_PATH = "/api/v1/auth/backchannel-logout";

export type StagingSettings = {
  /** APP_ORIGIN: the one origin browsers and logout tokens are sent to. */
  readonly appOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly cookieKey: string;
};

/** The own value: undefined when unset, null when it is not a plain string. */
function ownValue(env: Env, name: string): string | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : null;
}

/**
 * True for the production domain and every host under it, in any letter
 * case and with or without trailing dots (server/settings/deployment.ts).
 */
export function isProductionHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, "");
  return host === PRODUCTION_DOMAIN || host.endsWith(`.${PRODUCTION_DOMAIN}`);
}

/**
 * True when DUCTURA_DEPLOYMENT is exactly "staging"; false when it is unset.
 * Any other value, empty included, stops the provider (fails closed, as the
 * server's deploymentProblems).
 */
export function isStagingMode(env: Env): boolean {
  const value = ownValue(env, DEPLOYMENT_VARIABLE);
  if (value === undefined) return false;
  if (value !== STAGING) throw new Error(`${DEPLOYMENT_VARIABLE} is not a known deployment`);
  return true;
}

// A host a browser on the internet reaches by name: not this machine, not an
// IP literal, not a single label, and not a name that only resolves locally.
function isPublicName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, "");
  if (host === "" || host.startsWith("[") || /^[\d.]+$/u.test(host)) return false;
  if (!host.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/u.test(host);
}

/** APP_ORIGIN: a bare https origin of a public host outside the production domain. */
export function stagingAppOrigin(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "")
    throw new Error("APP_ORIGIN is required in staging");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN is not an address");
  }
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("APP_ORIGIN must be a bare https origin in staging");
  if (!isPublicName(url.hostname)) throw new Error("APP_ORIGIN must be a public host in staging");
  if (isProductionHost(url.hostname))
    throw new Error("APP_ORIGIN must be outside the production domain in staging");
  return value;
}

/**
 * ISSUER: the bare https origin of a public host outside the production
 * domain: no path, trailing slash, credentials, port, query or fragment, so
 * it is exactly OIDC_ISSUER of the server and the issuer of the seed.
 */
export function stagingIssuer(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") throw new Error("ISSUER is required in staging");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ISSUER is not an address");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.origin !== value
  )
    throw new Error("ISSUER must be a bare https origin in staging");
  if (!isPublicName(url.hostname)) throw new Error("ISSUER must be a public host in staging");
  if (isProductionHost(url.hostname))
    throw new Error("ISSUER must be outside the production domain in staging");
  return value;
}

/** A secret from the environment: at least 32 characters, never a local one. */
export function stagingSecret(name: string, value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required in staging`);
  if (value.length < MIN_SECRET_LENGTH || LOCAL_SECRETS.has(value) || value.trim() !== value)
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters in staging`);
  return value;
}

/**
 * Addresses on APP_ORIGIN only: unset or blank gives the default path on it;
 * every entry is https, has exactly that origin, and nothing beside the path.
 */
export function addressesOnOrigin(
  name: string,
  value: string | null | undefined,
  origin: string,
  defaultPath: string,
): string[] {
  if (value === null) throw new Error(`${name} is not a string`);
  if (value === undefined || value.trim() === "") return [new URL(defaultPath, origin).href];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new Error(`${name} has no address`);
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${name} has an entry that is not an address`);
    }
    if (url.origin !== origin || url.username !== "" || url.password !== "" || /[?#]/u.test(entry))
      throw new Error(`${name} must be on APP_ORIGIN in staging`);
  }
  return [...new Set(entries)];
}

export type StagingConfig = {
  readonly issuer: string;
  readonly redirectUris: string[];
  readonly postLogoutRedirectUris: string[];
  readonly backchannelLogoutUri: string;
  readonly staging: StagingSettings;
};

/** Everything staging takes from the environment; refuses before anything listens. */
export function stagingConfigFromEnv(env: Env): StagingConfig {
  if (ownValue(env, "FAKE_OIDC_ACCOUNTS_FILE") !== undefined)
    throw new Error("FAKE_OIDC_ACCOUNTS_FILE is not allowed in staging: only demo-* accounts");
  const appOrigin = stagingAppOrigin(ownValue(env, "APP_ORIGIN"));
  const clientSecret = stagingSecret(
    "FAKE_OIDC_CLIENT_SECRET",
    ownValue(env, "FAKE_OIDC_CLIENT_SECRET"),
  );
  const cookieKey = stagingSecret("FAKE_OIDC_COOKIE_KEY", ownValue(env, "FAKE_OIDC_COOKIE_KEY"));
  if (clientSecret === cookieKey)
    throw new Error("FAKE_OIDC_CLIENT_SECRET and FAKE_OIDC_COOKIE_KEY must differ");
  const backchannel = addressesOnOrigin(
    "BACKCHANNEL_LOGOUT_URI",
    ownValue(env, "BACKCHANNEL_LOGOUT_URI"),
    appOrigin,
    BACKCHANNEL_PATH,
  );
  if (backchannel.length !== 1) throw new Error("BACKCHANNEL_LOGOUT_URI is one address");
  return {
    issuer: stagingIssuer(ownValue(env, "ISSUER")),
    redirectUris: addressesOnOrigin(
      "REDIRECT_URI",
      ownValue(env, "REDIRECT_URI"),
      appOrigin,
      CALLBACK_PATH,
    ),
    postLogoutRedirectUris: addressesOnOrigin(
      "POST_LOGOUT_REDIRECT_URI",
      ownValue(env, "POST_LOGOUT_REDIRECT_URI"),
      appOrigin,
      POST_LOGOUT_PATH,
    ),
    backchannelLogoutUri: backchannel[0] ?? "",
    staging: { appOrigin, clientId: STAGING_CLIENT_ID, clientSecret, cookieKey },
  };
}

/** The same rules for options that did not come through stagingConfigFromEnv. */
export function assertStagingOptions(options: {
  readonly issuer: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
  readonly backchannelLogoutUri: string;
  readonly accounts?: readonly unknown[];
  readonly staging: StagingSettings;
}): void {
  const { staging } = options;
  const origin = stagingAppOrigin(staging.appOrigin);
  stagingIssuer(options.issuer);
  stagingSecret("client secret", staging.clientSecret);
  stagingSecret("cookie key", staging.cookieKey);
  if (staging.clientSecret === staging.cookieKey)
    throw new Error("the client secret and the cookie key must differ");
  if (staging.clientId === "" || staging.clientId === "ductus-local")
    throw new Error("the staging client has its own id");
  if ((options.accounts ?? []).length > 0)
    throw new Error("only demo-* accounts sign in in staging");
  for (const [name, list] of [
    ["redirect URI", options.redirectUris],
    ["post-logout redirect URI", options.postLogoutRedirectUris],
    ["back-channel logout URI", [options.backchannelLogoutUri]],
  ] as const) {
    if (list.length === 0) throw new Error(`${name} list is empty`);
    for (const entry of list) {
      // addressesOnOrigin gives the default for a blank value; an option is never blank.
      if (entry.trim() === "") throw new Error(`${name} list has a blank entry`);
      addressesOnOrigin(name, entry, origin, "/");
    }
  }
}
