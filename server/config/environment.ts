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
  if (host !== undefined && (host.trim() === "" || host.trim() !== host)) {
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
