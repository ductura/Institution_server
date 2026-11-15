// DAN-759: what the VS-1 stack may run with, decided before any process starts.
// D-09: the stack starts the fake OIDC provider, so it runs only as `local` or
// `ci`, named on the command line alone, and only under a NODE_ENV the fake
// provider itself accepts. Nothing else (a variable, a file) can name another.
// The allow list is that of packages/test-fakes/oidc/guard.ts, which tools may
// not import (local/no-fake-server-import); config.test.ts keeps them equal.
export const ALLOWED_NODE_ENV: ReadonlySet<string> = new Set(["", "development", "test"]);

export const STACK_ENVS = ["local", "ci"] as const;
export type StackEnv = (typeof STACK_ENVS)[number];
export const COMMANDS = ["up", "down", "status"] as const;
export type Command = (typeof COMMANDS)[number];

// Ports 3000 to 3004 belong to other stacks on the same machine; never ours.
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3001, 3002, 3003, 3004];
export const DEFAULT_PORTS = { postgres: 54360, server: 4100, oidc: 4180 } as const;
export type Ports = { postgres: number; server: number; oidc: number };

// The same-origin pieces VS-1 adds later: the preloader at `/` and the web
// app at `/app/`. Only the place to attach a built artifact; nothing is
// cloned or served until a follow-up fills `artifact`.
export type Slot = { readonly path: string; readonly artifact: string | null };
export const SLOTS: Readonly<Record<"preloader" | "web", Slot>> = Object.freeze({
  preloader: Object.freeze({ path: "/", artifact: null }),
  web: Object.freeze({ path: "/app/", artifact: null }),
});

export type StackConfig = { env: StackEnv; ports: Ports };
type Env = Readonly<Record<string, string | undefined>>;

const USAGE = "usage: vs1.ts up [--env local|ci] | down | status";

/** The command and environment from argv; anything unknown or repeated is refused. */
export function parseArgs(argv: readonly string[]): { command: Command; env: StackEnv } {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) throw new Error(USAGE);
  if (rest.length === 0) return { command: command as Command, env: "local" };
  const [flag, value, ...extra] = rest;
  if (command !== "up" || flag !== "--env" || extra.length > 0) throw new Error(USAGE);
  if (!STACK_ENVS.includes(value as StackEnv)) {
    throw new Error(`the VS-1 stack runs only as local or ci, not ${JSON.stringify(value)}`);
  }
  return { command, env: value as StackEnv };
}

function port(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
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
