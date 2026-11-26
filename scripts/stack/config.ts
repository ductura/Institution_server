// DAN-759, D-09: the stack starts the fake OIDC provider (DAN-787), so it
// runs only as `local` or `ci`, named on the command line alone, and only under
// a NODE_ENV the provider's guard accepts (packages/test-fakes/oidc/guard.ts,
// which tools may not import; config.test.ts keeps the lists equal).
export const ALLOWED_NODE_ENV: ReadonlySet<string> = new Set(["", "development", "test"]);
export const STACK_ENVS = ["local", "ci"] as const;
export type StackEnv = (typeof STACK_ENVS)[number];
export type Command = "up" | "down" | "status";
// Ports 3000 to 3004 belong to other stacks on the same machine; never ours.
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3001, 3002, 3003, 3004];
// Linux hands outgoing connections a source port from 32768-60999; a listener
// default inside it can find its port held by a client of the same job (CI: the
// PostgreSQL of the stack, FATAL could not create any TCP/IP sockets). Every
// default stays below the range.
export const EPHEMERAL_PORTS = { from: 32_768, to: 60_999 } as const;
export const DEFAULT_PORTS = { postgres: 25360, server: 4100, oidc: 4180, s3: 4191 } as const;
// Ports the Fetch standard blocks (undici refuses them with "bad port"): the
// server reaches the local S3 through fetch, so none of these may be a stack port.
export const FETCH_BAD_PORTS: readonly number[] = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
];
export type Ports = { postgres: number; server: number; oidc: number; s3: number };
export type StackConfig = { env: StackEnv; ports: Ports };
// Same origin: preloader at `/`, web at `/app/`; slots only, filled later.
export const SLOTS = Object.freeze({
  preloader: Object.freeze({ path: "/", artifact: null }),
  web: Object.freeze({ path: "/app/", artifact: null }),
});
// pg_ctl hands -o to /bin/sh, and a Unix socket path has at most 107 bytes.
export const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/u;
type Env = Readonly<Record<string, string | undefined>>;

/** The command and environment from argv; anything unknown or repeated is refused. */
export function parseArgs(argv: readonly string[]): { command: Command; env: StackEnv } {
  const [command, flag, value, ...extra] = argv;
  if ((command === "down" || command === "status") && flag === undefined)
    return { command, env: "local" };
  if (command !== "up" || extra.length > 0)
    throw new Error("usage: vs1.ts up [--env local|ci] | down | status");
  if (flag === undefined) return { command, env: "local" };
  if (flag !== "--env" || !STACK_ENVS.includes(value as StackEnv)) {
    throw new Error(
      `the VS-1 stack runs only as local or ci (--env), not ${JSON.stringify(value)}`,
    );
  }
  return { command, env: value as StackEnv };
}

function port(env: Env, name: string, fallback: number): number {
  const value = env[name] ?? String(fallback);
  const parsed = /^\d{4,5}$/u.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= 1024 && parsed <= 65_535)) throw new Error(`${name} is not a port 1024-65535`);
  return parsed;
}

/** The ports of the stack; refuses 3000-3004 and a port used twice. */
export function stackPorts(env: Env): Ports {
  const ports = {
    postgres: port(env, "VS1_POSTGRES_PORT", DEFAULT_PORTS.postgres),
    server: port(env, "VS1_SERVER_PORT", DEFAULT_PORTS.server),
    oidc: port(env, "VS1_OIDC_PORT", DEFAULT_PORTS.oidc),
    s3: port(env, "VS1_S3_PORT", DEFAULT_PORTS.s3),
  };
  const values = Object.values(ports);
  if (values.some((value) => FORBIDDEN_PORTS.includes(value))) {
    throw new Error("ports 3000-3004 are reserved for other stacks");
  }
  if (values.some((value) => FETCH_BAD_PORTS.includes(value))) {
    throw new Error("a stack port is one fetch refuses (bad port)");
  }
  if (new Set(values).size !== values.length) throw new Error("the stack ports must differ");
  return ports;
}

/** The validated configuration; throws before anything starts. */
export function stackConfig(stackEnv: StackEnv, env: Env): StackConfig {
  if (!STACK_ENVS.includes(stackEnv)) throw new Error("the VS-1 stack runs only as local or ci");
  if (!ALLOWED_NODE_ENV.has(env.NODE_ENV ?? "")) {
    throw new Error(
      "the stack starts the fake OIDC provider: NODE_ENV must be unset, development or test",
    );
  }
  return { env: stackEnv, ports: stackPorts(env) };
}

const inside = (path: string, root: string): boolean => path.startsWith(`${root}/`);

/**
 * The stack directory: `<root>/.stack/vs1`, or VS1_STACK_DIR when it is a safe
 * absolute path inside `<root>/.stack` or the temporary directory (tests),
 * before and after symbolic links are resolved. `real` resolves links.
 */
export function stackDir(
  root: string, // without a trailing /
  env: Env,
  tmp: string,
  real: (path: string) => string,
): string {
  const value = env.VS1_STACK_DIR ?? `${root}/.stack/vs1`;
  const roots = [`${root}/.stack`, tmp];
  try {
    roots.push(real(tmp));
  } catch {
    // A temp dir that does not exist adds no resolved root.
  }
  const ok = (path: string): boolean => roots.some((base) => inside(path, base));
  const parts = value.split("/");
  const where = "the stack directory (VS1_STACK_DIR or .stack/vs1)";
  if (
    !SAFE_PATH.test(value) ||
    parts.includes("..") ||
    parts.includes(".") ||
    // An empty segment (a trailing / or //): lstat of "link/" follows the link.
    parts.slice(1).includes("") ||
    !ok(value)
  ) {
    throw new Error(
      `${where} must be an absolute path of letters, digits, . _ - and / in .stack/ or the temp dir`,
    );
  }
  // The nearest existing ancestor with its links resolved, then the rest:
  // a link anywhere on the way may not lead out (mkdir would follow it).
  for (let at = parts.length; at > 1; at -= 1) {
    let base: string;
    try {
      base = real(parts.slice(0, at).join("/"));
    } catch (error) {
      if (Reflect.get(error as object, "code") === "ENOENT") continue;
      throw error;
    }
    if (!ok([base, ...parts.slice(at)].join("/")))
      throw new Error(`${where} leads outside .stack/ or the temp dir`);
    break;
  }
  return value;
}
