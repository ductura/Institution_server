// DAN-759, D-09: the stack will start the fake OIDC provider (DAN-759 b), so it
// runs only as `local` or `ci`, named on the command line alone, and only under
// a NODE_ENV the provider's guard accepts (packages/test-fakes/oidc/guard.ts,
// which tools may not import; config.test.ts keeps the lists equal).
export const ALLOWED_NODE_ENV: ReadonlySet<string> = new Set(["", "development", "test"]);
export const STACK_ENVS = ["local", "ci"] as const;
export type StackEnv = (typeof STACK_ENVS)[number];
export type Command = "up" | "down";
// Ports 3000 to 3004 belong to other stacks on the same machine; never ours.
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3001, 3002, 3003, 3004];
export const DEFAULT_PORTS = { postgres: 54360, server: 4100, oidc: 4180 } as const;
export type Ports = { postgres: number; server: number; oidc: number };
export type StackConfig = { env: StackEnv; ports: Ports };
// Same origin: preloader at `/`, web at `/app/`; slots only, filled later.
export const SLOTS = Object.freeze({
  preloader: Object.freeze({ path: "/", artifact: null }),
  web: Object.freeze({ path: "/app/", artifact: null }),
});
type Env = Readonly<Record<string, string | undefined>>;

/** The command and environment from argv; anything unknown or repeated is refused. */
export function parseArgs(argv: readonly string[]): { command: Command; env: StackEnv } {
  const [command, flag, value, ...extra] = argv;
  if (command === "down" && flag === undefined) return { command, env: "local" };
  if (command !== "up" || extra.length > 0)
    throw new Error("usage: vs1.ts up [--env local|ci] | down");
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
  };
  const values = Object.values(ports);
  if (values.some((value) => FORBIDDEN_PORTS.includes(value))) {
    throw new Error("ports 3000-3004 are reserved for other stacks");
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
