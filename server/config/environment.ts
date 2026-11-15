// DAN-299 (decision on the Linear contract, 1. 11. 2026., direction 1): the
// process refuses to start without the one variable every request needs, the
// application login APP_DATABASE_URL (server/database/index.ts). Login stays
// lazy on purpose: a production build with the fake provider must start and
// refuse sign-in on the page (D-09, e2e/auth.spec.ts), and the standard E2E
// server runs without AUTH_DATABASE_URL. A bad login setup is a readiness
// signal, not a crash. Messages name a variable, never its value.
type Env = Readonly<Record<string, string | undefined>>;

const PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/** The problems of the startup environment, by variable name only; empty when it can start. */
export function environmentProblems(env: Env = process.env): string[] {
  const value = env.APP_DATABASE_URL;
  if (value === undefined || value.trim() === "") return ["APP_DATABASE_URL is not set"];
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return ["APP_DATABASE_URL is not a URL"];
  }
  if (!PROTOCOLS.has(parsed.protocol)) return ["APP_DATABASE_URL is not a postgres URL"];
  if (parsed.hostname === "") return ["APP_DATABASE_URL names no host"];
  return [];
}

// Where the server listens (S-1B-a, DAN-775). Both are optional; the default
// host is the loopback, so a process started without HOST is not reachable
// from the network by accident. A deployment sets HOST=0.0.0.0 on purpose.
export const DEFAULT_PORT = 4000;
export const DEFAULT_HOST = "127.0.0.1";
const PORT_RE = /^\d{1,5}$/u;

/** The problems of PORT and HOST, by variable name only; empty when they are usable. */
export function listenProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  const port = env.PORT;
  if (port !== undefined && (!PORT_RE.test(port) || Number(port) > 65_535)) {
    problems.push("PORT is not a port number");
  }
  const host = env.HOST;
  if (host !== undefined && (host === "" || /\s/u.test(host))) {
    problems.push("HOST is empty or has spaces");
  }
  return problems;
}

/** Host and port to listen on; call only when listenProblems is empty. */
export function listenAddress(env: Env = process.env): { host: string; port: number } {
  return {
    host: env.HOST ?? DEFAULT_HOST,
    port: env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT),
  };
}

// The origin of the application's pages (S-1B-b, DAN-777): a state-changing
// request must carry exactly this Origin (server/http/mutation-request.ts).
// Optional; without it every state-changing request is refused (403), never
// allowed. A set value must be a bare http(s) scheme://host[:port].
function canonicalOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** The problem of APP_ORIGIN, by name only; empty when unset or usable. */
export function originProblems(env: Env = process.env): string[] {
  if (env.APP_ORIGIN === undefined || canonicalOrigin(env.APP_ORIGIN) !== null) return [];
  return ["APP_ORIGIN is not a bare http(s) origin"];
}

/** APP_ORIGIN when it is usable, otherwise null (refuse every mutation). */
export function appOrigin(env: Env = process.env): string | null {
  return canonicalOrigin(env.APP_ORIGIN);
}

// Shutdown deadline (S-1B-c, DAN-778): optional, in milliseconds. The default
// stays under the 10 s a container stop waits before SIGKILL; the variable
// exists so a test does not wait that long. The whole value must be digits.
export const DEFAULT_SHUTDOWN_GRACE_MS = 8_000;
export const SHUTDOWN_GRACE_MIN_MS = 100;
export const SHUTDOWN_GRACE_MAX_MS = 30_000;
const GRACE_RE = /^[1-9]\d{0,5}$/u;

/** The problem of SHUTDOWN_GRACE_MS, by variable name only; empty when usable. */
export function shutdownProblems(env: Env = process.env): string[] {
  const value = env.SHUTDOWN_GRACE_MS;
  if (value === undefined) return [];
  const ms = GRACE_RE.test(value) ? Number(value) : Number.NaN;
  return ms >= SHUTDOWN_GRACE_MIN_MS && ms <= SHUTDOWN_GRACE_MAX_MS
    ? []
    : [
        `SHUTDOWN_GRACE_MS is not a whole number from ${SHUTDOWN_GRACE_MIN_MS} to ${SHUTDOWN_GRACE_MAX_MS}`,
      ];
}

/** The shutdown deadline; call only when shutdownProblems is empty. */
export function shutdownGraceMs(env: Env = process.env): number {
  const value = env.SHUTDOWN_GRACE_MS;
  return value === undefined ? DEFAULT_SHUTDOWN_GRACE_MS : Number(value);
}
