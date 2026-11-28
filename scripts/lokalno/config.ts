// `pnpm lokalno` (Ductus#2028, contract c.6993786629 §1 and §3.2): the
// configuration of the one-command local start, as pure functions so the
// tests need no PostgreSQL. Local development only (D-09): the server gets the
// fake OIDC provider, which the server and the provider both refuse outside
// NODE_ENV development and test.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type EvidenceSetup, type S3Credentials, serverEvidenceEnv } from "../stack/index.ts";

/** The ports of contract §1. */
export const PORTS = Object.freeze({ edge: 8000, server: 4000, oidc: 8090, s3: 4192 });
/** The issuer of the simulator; db/main/local/seed.sql stores the same spelling. */
export const ISSUER = `http://localhost:${PORTS.oidc}`;
/** The browser's one origin, the edge proxy of the Preloader (contract §1). */
export const EDGE_ORIGIN = `http://localhost:${PORTS.edge}`;
/** The origin with `--izravno`: the browser talks to the server itself, without the edge. */
export const DIRECT_ORIGIN = `http://localhost:${PORTS.server}`;
/** The database every migration and login of the main database names (scripts/db/databases.ts). */
export const DATABASE = "ductus";
/** The fake provider's one client, public local-only values (packages/test-fakes/oidc/server.ts). */
export const LOCAL_OIDC_CLIENT = Object.freeze({ id: "ductus-local", secret: "ductus-local-only" });

export type Env = Readonly<Record<string, string | undefined>>;

const ALLOWED_NODE_ENV = new Set(["", "development", "test"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws unless the caller's NODE_ENV says local development (D-09). */
export function assertLocal(env: Env): void {
  const value = env.NODE_ENV ?? "";
  if (!ALLOWED_NODE_ENV.has(value))
    throw new Error("pnpm lokalno runs only with NODE_ENV unset, development or test");
}

export type AdminTarget = {
  /** Host as the URL writes it (`[::1]` in brackets). */
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
};

/**
 * DATABASE_URL: a superuser of a PostgreSQL on this machine. Its database may
 * be empty, `postgres` or `ductus`; the stack always uses `ductus`, so the
 * migrator never takes over another database. Errors never echo the value.
 */
export function adminTarget(raw: string | undefined): AdminTarget {
  if (raw === undefined || raw.trim() === "")
    throw new Error(
      "DATABASE_URL is not set (example: postgres://postgres:<password>@localhost:5432/ductus); see docs/LOKALNO.md",
    );
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("DATABASE_URL is not a postgres URL");
  if (!LOOPBACK.has(url.hostname))
    throw new Error("DATABASE_URL must name localhost, 127.0.0.1 or [::1]");
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!["", "postgres", DATABASE].includes(database))
    throw new Error(`DATABASE_URL must name the database ${DATABASE} (or none)`);
  const extra = [...url.searchParams.keys()].filter((key) => key !== "sslmode");
  if (extra.length > 0) throw new Error("DATABASE_URL may carry only sslmode in its query");
  const user = decodeURIComponent(url.username);
  if (user === "") throw new Error("DATABASE_URL names no user");
  return {
    host: url.hostname,
    port: url.port === "" ? "5432" : url.port,
    user,
    password: decodeURIComponent(url.password),
  };
}

/** A connection URL of `target` as `user`, to `database`; `role` for dbmate's migrator. */
export function loginUrl(
  target: Pick<AdminTarget, "host" | "port">,
  user: string,
  password: string,
  database: string,
  role?: string,
): string {
  const url = new URL(`postgres://${target.host}:${target.port}/${database}`);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.searchParams.set("sslmode", "disable");
  if (role !== undefined) url.searchParams.set("role", role);
  return url.href;
}

/** The generated local secrets, kept in .local/lokalno-tajne.json. */
export type LocalSecrets = {
  readonly appPassword: string;
  readonly authPassword: string;
  readonly provisioningToken: string;
};

const SECRETS_FILE = "lokalno-tajne.json";
/** One line, read by Aplication_server's local start (contract §2). */
export const TOKEN_FILE = "provisioning-token";
/** The simulator's named accounts (packages/test-fakes/oidc/simulated-accounts.ts). */
export const ACCOUNTS_FILE = "oidc-racuni.json";
/**
 * The committed accounts of the local seed (SRV-01 and SRV-17),
 * relative to the repository root.
 */
export const SEED_ACCOUNTS_FILE = "db/main/local/lazni-oidc-racuni.json";

/**
 * The accounts file the simulator gets: .local/oidc-racuni.json when the
 * developer keeps one (it replaces the seed's), else the seed's committed file.
 */
export function accountsFileFor(
  root: string,
  localDir: string,
  exists: (path: string) => boolean,
): string | undefined {
  const local = join(localDir, ACCOUNTS_FILE);
  if (exists(local)) return local;
  const seed = join(root, SEED_ACCOUNTS_FILE);
  return exists(seed) ? seed : undefined;
}

const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const newSecret = (): string => randomBytes(32).toString("base64url");

function writePrivate(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  // No effect on Windows; the folder is in .gitignore either way.
  chmodSync(file, 0o600);
}

/**
 * The secrets of `dir` (.local/), made once and kept: the passwords of the two
 * local logins and DUCTURA_PROVISIONING_TOKEN (at least 32 characters,
 * contract §2). A damaged file stops the start; it is never replaced quietly.
 */
export function ensureSecrets(dir: string): LocalSecrets {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, SECRETS_FILE);
  let secrets: LocalSecrets;
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${SECRETS_FILE} is not JSON; delete it to make new secrets`);
    }
    const value = parsed as Record<string, unknown>;
    const fields = ["appPassword", "authPassword", "provisioningToken"] as const;
    if (!fields.every((name) => typeof value[name] === "string" && SECRET_RE.test(value[name])))
      throw new Error(`${SECRETS_FILE} is damaged; delete it to make new secrets`);
    secrets = {
      appPassword: value.appPassword as string,
      authPassword: value.authPassword as string,
      provisioningToken: value.provisioningToken as string,
    };
  } else {
    secrets = {
      appPassword: newSecret(),
      authPassword: newSecret(),
      provisioningToken: newSecret(),
    };
    writePrivate(file, `${JSON.stringify(secrets, null, 2)}\n`);
  }
  writePrivate(join(dir, TOKEN_FILE), `${secrets.provisioningToken}\n`);
  return secrets;
}

export type StackOptions = {
  /** The browser's origin: EDGE_ORIGIN, or DIRECT_ORIGIN with --izravno. */
  readonly origin: string;
  readonly serverPort: number;
  readonly oidcPort: number;
  /** The issuer the server and the seed use. */
  readonly issuer: string;
  /** The named accounts file, when it exists. */
  readonly accountsFile?: string;
};

/** The default options of contract §1. */
export function stackOptions(
  direct: boolean,
  accountsFile?: string,
  origin?: string,
): StackOptions {
  return {
    origin: origin ?? (direct ? DIRECT_ORIGIN : EDGE_ORIGIN),
    serverPort: PORTS.server,
    oidcPort: PORTS.oidc,
    issuer: ISSUER,
    ...(accountsFile === undefined ? {} : { accountsFile }),
  };
}

// Variables a child never takes from the caller: database and login steering,
// and NODE_ENV, which each child gets from here.
const STEERING =
  /^(?:PG|PSQL|DBMATE_|DATABASE_URL$|APP_|AUTH_|OIDC_|DUCTUS_|DUCTURA_|NODE_ENV$|NODE_OPTIONS$|HOST$|PORT$|ISSUER$|REDIRECT_URI$|POST_LOGOUT_REDIRECT_URI$|BACKCHANNEL_LOGOUT_URI$|FAKE_OIDC_|EVIDENCE_|VS1_)/iu;

/**
 * The caller's environment without anything that steers a database, a login
 * or a listener. The rest stays: on Windows a child needs SystemRoot and its
 * kin to resolve names and make random numbers.
 */
export function baseEnv(env: Env): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !STEERING.test(name)) base[name] = value;
  }
  return base;
}

const callback = (origin: string): string => `${origin}/api/v1/auth/callback`;

/** The fake provider's own variables (packages/test-fakes/oidc/README.md). */
export function oidcEnv(options: StackOptions): Record<string, string> {
  return {
    NODE_ENV: "development",
    PORT: String(options.oidcPort),
    ISSUER: options.issuer,
    REDIRECT_URI: callback(options.origin),
    POST_LOGOUT_REDIRECT_URI: `${options.origin}/`,
    // Server to server, not through the edge.
    BACKCHANNEL_LOGOUT_URI: `http://127.0.0.1:${options.serverPort}/api/v1/auth/backchannel-logout`,
    ...(options.accountsFile === undefined
      ? {}
      : { FAKE_OIDC_ACCOUNTS_FILE: options.accountsFile }),
  };
}

/**
 * The evidence storage and receipt key of the local stack (INT-08): the
 * institution of the seed, the signing seed file outside the checkout and the
 * credentials of this run's local S3 (scripts/stack/evidence.ts).
 */
export type LocalEvidence = EvidenceSetup & {
  readonly s3Port: number;
  readonly credentials: S3Credentials;
};

/**
 * The server's own variables: the fake provider, both logins and the
 * provisioning token; with `evidence` also EVIDENCE_STORAGE_DOMAINS, the S3
 * credentials and DUCTUS_DEV_SIGNING_KEY_FILE, so that a commit reaches the
 * storage and the signer instead of answering 503.
 */
export function serverEnv(
  options: StackOptions,
  database: Pick<AdminTarget, "host" | "port">,
  secrets: LocalSecrets,
  evidence?: LocalEvidence,
): Record<string, string> {
  return {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(options.serverPort),
    APP_ORIGIN: options.origin,
    APP_DATABASE_URL: loginUrl(database, "ductus_app_local", secrets.appPassword, DATABASE),
    AUTH_DATABASE_URL: loginUrl(database, "ductus_auth_local", secrets.authPassword, DATABASE),
    DUCTUS_AUTH_PROVIDER: "fake-oidc",
    OIDC_ISSUER: options.issuer,
    OIDC_CLIENT_ID: LOCAL_OIDC_CLIENT.id,
    OIDC_CLIENT_SECRET: LOCAL_OIDC_CLIENT.secret,
    OIDC_REDIRECT_URI: callback(options.origin),
    DUCTURA_PROVISIONING_TOKEN: secrets.provisioningToken,
    ...(evidence === undefined
      ? {}
      : serverEvidenceEnv(evidence, evidence.s3Port, evidence.credentials)),
  };
}

/**
 * The local-only switches the caller may hand to the server. baseEnv drops every
 * DUCTUS_* variable, so the analysis switch of SRV-ANALIZA-LOKALNO
 * (server/http/analysis/index.ts) passes only here, and only as exactly "1";
 * the server still checks its own local stack marker.
 */
export function localSwitches(env: Env): Record<string, string> {
  return env.DUCTUS_ANALYSIS_LOCAL === "1" ? { DUCTUS_ANALYSIS_LOCAL: "1" } : {};
}

/**
 * db/main/local/seed.sql without its psql guard (the `\set` … `\endif` block
 * that refuses TCP): pnpm lokalno reaches the database over loopback TCP, as
 * Windows has no socket, and checks the loopback host itself (adminTarget).
 * Anything else that psql alone reads stops it.
 */
export function seedStatements(sql: string): string {
  const stripped = sql.replace(/^\\set ON_ERROR_STOP on\n[\s\S]*?^\\endif\n/mu, "");
  if (stripped === sql) throw new Error("seed.sql: the psql guard was not found");
  if (/^\s*\\/mu.test(stripped)) throw new Error("seed.sql: a psql command is left");
  return stripped;
}
