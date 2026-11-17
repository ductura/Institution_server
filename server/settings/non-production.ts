// The one definition of production (moved verbatim from
// server/external/srce-auth/config.ts for S-1H.7, DAN-938-1, so the startup
// check of the test mode and the login configuration share it; the entry
// point and server/config may not import external/srce-auth).

// The only environments where the fake provider and plain http may run.
const NON_PRODUCTION = new Set(["development", "test"]);

/**
 * The deployment gate of everything that exists only locally and in CI: the
 * fake provider here, the development receipt signer of evidence ingest.
 * An allowlist, so an unset, empty or misspelt NODE_ENV is production.
 */
export function isNonProductionBuild(nodeEnv: string | undefined): boolean {
  return NON_PRODUCTION.has(nodeEnv ?? "");
}
