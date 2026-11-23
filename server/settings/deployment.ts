// The staging deployment (STG-PRIJAVA, Ductus#2055; owner decision of
// 23. 11. 2026., "b i a, postavi staging s migracijske grane"). Staging runs
// the production build (NODE_ENV unset), so isNonProductionBuild still calls
// it production. DUCTURA_DEPLOYMENT=staging is the one explicit switch that
// marks it; it opens the fake OIDC provider (external/srce-auth/config.ts)
// only together with an APP_ORIGIN outside the production domain. Every other
// combination fails closed: an unknown value is a startup problem, and so is
// staging on a production origin. Only an own data property counts, as in
// test-mode.ts. Problems name the variable, never its value.

type Env = Readonly<Record<string, string | undefined>>;

export const DEPLOYMENT_VARIABLE = "DUCTURA_DEPLOYMENT";
const STAGING = "staging";

/**
 * The production domain. The apex and every name under it are production
 * hosts: staging never runs on them, so a fake login never shares a host or a
 * parent domain with the real one.
 */
export const PRODUCTION_DOMAIN = "ductura.org";

/** The own value: undefined when unset, null when it is not a plain string. */
function ownValue(env: Env, name: string): string | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : null;
}

/**
 * True for the production domain and every host under it, in any letter
 * case and with or without trailing dots (the same host in DNS).
 */
export function isProductionHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, "");
  return host === PRODUCTION_DOMAIN || host.endsWith(`.${PRODUCTION_DOMAIN}`);
}

/**
 * APP_ORIGIN when it is a bare https origin outside the production domain,
 * otherwise null. "Bare" as server/config reads it: the whole value is the
 * origin, so no path, query, credentials or trailing slash.
 */
function stagingOrigin(env: Env): string | null {
  const value = ownValue(env, "APP_ORIGIN");
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) return null;
    return isProductionHost(url.hostname) ? null : value;
  } catch {
    return null;
  }
}

/** The problem of DUCTURA_DEPLOYMENT, by variable name only; empty when unset or usable. */
export function deploymentProblems(env: Env): string[] {
  const deployment = ownValue(env, DEPLOYMENT_VARIABLE);
  if (deployment === undefined) return [];
  if (deployment !== STAGING) return [`${DEPLOYMENT_VARIABLE} is not a known deployment`];
  return stagingOrigin(env) === null
    ? [`${DEPLOYMENT_VARIABLE} staging needs an https APP_ORIGIN outside the production domain`]
    : [];
}

/**
 * The staging origin when DUCTURA_DEPLOYMENT is exactly "staging" and
 * APP_ORIGIN is a bare https origin outside the production domain; null in
 * every other case, which is production as before.
 */
export function stagingDeploymentOrigin(env: Env): string | null {
  return ownValue(env, DEPLOYMENT_VARIABLE) === STAGING ? stagingOrigin(env) : null;
}

/** True only when stagingDeploymentOrigin finds a staging origin. */
export function isStagingDeployment(env: Env): boolean {
  return stagingDeploymentOrigin(env) !== null;
}
