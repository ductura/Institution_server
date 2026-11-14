// Where the db/main/local scripts run psql (DAN-324). Their default stays the
// docker invocation of the compose postgres-main container. A caller that
// imports a script (the native demo runner) may pass a native psql target
// instead; no environment variable chooses it, so the compose path keeps docker.
// Ported from Ductus db/local/psql-target.mjs at d52a92c3 (S-0.14, DAN-727);
// only the compose service name and the types changed.

export type PsqlTarget = { command: string; args: string[] };
export type NativePsqlTarget = PsqlTarget & { env: Env };
export type Env = Record<string, string | undefined>;

const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// A socket directory: POSIX `/...` or a Windows drive path, the two forms libpq
// takes as a socket rather than a host name. No comma, which would list a second host.
const SOCKET_DIR = /^(?:\/|[A-Za-z]:[\\/])[^,]*$/;
const PORT = /^[1-9][0-9]{0,4}$/;
// The only options a native target may carry, each as its own element followed by its value.
const ALLOWED: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["-h", (value: string) => SOCKET_DIR.test(value)],
  ["-p", (value: string) => PORT.test(value) && Number(value) <= 65535],
  ["-U", (value: string) => value === "ductus"],
  ["-d", (value: string) => value === "ductus"],
]);
// Environment variables libpq would read, except a password, which chooses no host.
const KEPT_PG = new Set(["PGPASSWORD", "PGPASSFILE"]);
const REFUSED =
  "the psql target must name one local socket directory with -h and only -p, -U ductus, -d ductus";

/** The docker prefix: the compose postgres-main service, or DUCTUS_PSQL_CONTAINER (a private test database). */
export function dockerExecArgs(env: Env): string[] {
  const container = env["DUCTUS_PSQL_CONTAINER"];
  if (container !== undefined && !CONTAINER.test(container))
    throw new Error("DUCTUS_PSQL_CONTAINER is not a container name");
  return container ? ["exec", "-i", container] : ["compose", "exec", "-T", "postgres-main"];
}

/**
 * Judges a native target `{ command, args }`. The args are an allowlist:
 * `-h <socket directory>` exactly once, and at most once each `-p <port>`,
 * `-U ductus` and `-d ductus`, every option and value its own element. Nothing
 * else (joined short options, `--long=`, conninfo, URI, service) gets through,
 * so psql reaches the local socket and never TCP. Returns a copy with the
 * environment psql runs in: `env` without the PG* variables (PGHOST,
 * PGHOSTADDR, PGSERVICE...) that could still pick a host.
 */
export function nativePsqlTarget(psql: unknown, env: Env = {}): NativePsqlTarget {
  const command: unknown =
    typeof psql === "object" && psql !== null ? Reflect.get(psql, "command") : undefined;
  const args: unknown =
    typeof psql === "object" && psql !== null ? Reflect.get(psql, "args") : undefined;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === "string")
  ) {
    throw new Error("the psql target is not { command, args }");
  }
  const list = args as string[];
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 2) {
    const option = list[index] as string;
    const value = list[index + 1];
    const allowed = ALLOWED.get(option);
    if (allowed === undefined || seen.has(option) || value === undefined || !allowed(value)) {
      throw new Error(REFUSED);
    }
    seen.add(option);
  }
  if (!seen.has("-h")) throw new Error(REFUSED);
  return { command, args: [...list], env: nativePsqlEnv(env) };
}

/** `env` without the libpq variables that could choose a host, whatever their case (Windows). */
function nativePsqlEnv(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !name.toUpperCase().startsWith("PG") || KEPT_PG.has(name.toUpperCase()),
    ),
  );
}
