// `pnpm stog:gore` (INT-01): the configuration of the whole local stack as pure
// functions, so the tests need no Docker, PostgreSQL or front. Local
// development only (D-09): the login is the fake OIDC provider of `pnpm lokalno`.
import { join, resolve } from "node:path";

import { LOCAL_OIDC_CLIENT, PORTS } from "./config.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** The port of the Next.js front; `STOG_FRONT_PORT` overrides it. */
export const FRONT_PORT = 3000;
/** The compose database of `pnpm db:up` (compose.yaml, postgres-main). */
export const COMPOSE_DATABASE_URL = "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
export const COMPOSE_DATABASE_PORT = 54329;
/** Where the front lives when `STOG_FRONT_DIR` is not set: the sibling folder. */
export const DEFAULT_FRONT_DIR = "../Institution_front_web_chrome";
/** Where `pnpm stog:gore` keeps the pid of its supervisor, for `pnpm stog:dolje`. */
export const PID_FILE = "stog.pid";

export type StogOptions = {
  readonly frontDir: string;
  readonly frontPort: number;
  /** The browser's one origin: the front, whose /api/v1 proxy reaches the server. */
  readonly origin: string;
  /** Start PostgreSQL in Docker (default), or use `DATABASE_URL` (`STOG_BAZA=vanjska`). */
  readonly composeDatabase: boolean;
};

/** Options from the caller's environment; `root` is this repository. */
export function stogOptions(root: string, env: Env): StogOptions {
  const port = env.STOG_FRONT_PORT === undefined ? FRONT_PORT : Number(env.STOG_FRONT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("STOG_FRONT_PORT must be a port from 1024 to 65535");
  if (port === PORTS.server || port === PORTS.oidc)
    throw new Error("STOG_FRONT_PORT collides with the server or the simulator");
  const baza = env.STOG_BAZA ?? "docker";
  if (baza !== "docker" && baza !== "vanjska")
    throw new Error("STOG_BAZA must be docker or vanjska");
  const dir = env.STOG_FRONT_DIR?.trim();
  return {
    frontDir: resolve(root, dir === undefined || dir === "" ? DEFAULT_FRONT_DIR : dir),
    frontPort: port,
    origin: `http://localhost:${port}`,
    composeDatabase: baza === "docker",
  };
}

/**
 * The front's start script: `next:dev` once WEB-01 has landed, else the `dev`
 * script of the Vite front. Undefined when the folder has neither.
 */
export function frontScript(packageJson: unknown): string | undefined {
  const scripts = (packageJson as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
  return ["next:dev", "dev"].find((name) => typeof scripts[name] === "string");
}

/**
 * The front's environment: where /api/v1 goes (the server, not the edge), the
 * port, and nothing from the caller that steers a database or a login.
 */
export function frontEnv(
  options: StogOptions,
  base: Record<string, string>,
): Record<string, string> {
  return {
    ...base,
    NODE_ENV: "development",
    PORT: String(options.frontPort),
    INSTITUTION_SERVER_URL: `http://127.0.0.1:${PORTS.server}`,
    NEXT_PUBLIC_API_BASE: "/api/v1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** The database the server stack gets: compose's, or the caller's `DATABASE_URL`. */
export function databaseFor(options: StogOptions, env: Env): string | undefined {
  return options.composeDatabase ? COMPOSE_DATABASE_URL : env.DATABASE_URL;
}

export type HealthTarget = {
  readonly name: string;
  readonly url?: string;
  /** A TCP port, for PostgreSQL. */
  readonly port?: number;
  /** The status that counts as alive. */
  readonly status?: number;
};

/** What `pnpm stog:zdravlje` asks: every service of the stack must answer. */
export function healthTargets(options: StogOptions): HealthTarget[] {
  return [
    ...(options.composeDatabase ? [{ name: "postgres", port: COMPOSE_DATABASE_PORT }] : []),
    {
      name: "oidc",
      url: `http://127.0.0.1:${PORTS.oidc}/.well-known/openid-configuration`,
      status: 200,
    },
    { name: "server", url: `http://127.0.0.1:${PORTS.server}/api/v1/health`, status: 200 },
    // The local S3 answers only signed requests, so it counts as up when it listens (INT-08).
    { name: "s3", port: PORTS.s3 },
    { name: "front", url: `http://127.0.0.1:${options.frontPort}/`, status: 200 },
    {
      name: "front→server",
      url: `http://127.0.0.1:${options.frontPort}/api/v1/health`,
      status: 200,
    },
  ];
}

/** The login URL a person opens first; the server returns to the front. */
export function loginLink(options: StogOptions): string {
  return `${options.origin}/api/v1/auth/login?returnTo=/`;
}

/** The public local client of the simulator, for the docs table only. */
export const OIDC_CLIENT_ID = LOCAL_OIDC_CLIENT.id;

export const pidFile = (localDir: string): string => join(localDir, PID_FILE);
