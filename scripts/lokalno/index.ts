// Public interface of scripts/lokalno (`pnpm lokalno`, docs/LOKALNO.md).
export {
  ACCOUNTS_FILE,
  accountsFileFor,
  adminTarget,
  assertLocal,
  baseEnv,
  DATABASE,
  DIRECT_ORIGIN,
  EDGE_ORIGIN,
  ensureSecrets,
  LOCAL_OIDC_CLIENT,
  ISSUER,
  loginUrl,
  oidcEnv,
  PORTS,
  seedStatements,
  SEED_ACCOUNTS_FILE,
  serverEnv,
  stackOptions,
  TOKEN_FILE,
} from "./config.ts";
export type { AdminTarget, Env, LocalEvidence, LocalSecrets, StackOptions } from "./config.ts";
export { localLogins, provision } from "./database.ts";
export { databaseUrl, LOCAL_DIR, parseFlags, startStack } from "./lokalno.ts";
export { signInSession } from "./seed-predaja.ts";
