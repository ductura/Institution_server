import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import type pg from "pg";

import { CLOSED_MESSAGE, createRegistry, HEALTH_TIMEOUT_MS, POOLS } from "./registry.ts";

// S-1F-a (DAN-783). The pools are fakes; every URL and password is invented
// and never dialled. CANARY is a password that must never show up in an
// error, a report or a log line.
const CANARY = "invented-canary-pw-7Q2x";
const url = (user: string) => `postgres://${user}:${CANARY}@db.invalid:5432/ductura_${user}`;
// Keys from POOLS, so the test names each variable once, where the registry does.
const MAIN = POOLS.main.variable;
const LOGS = POOLS.logs.variable;
const LEGAL = POOLS.legal.variable;
const ENV: Record<string, string | undefined> = {
  [MAIN]: url("app"),
  [POOLS.auth.variable]: url("auth"),
  [LOGS]: url("logs"),
  [LEGAL]: url("legal"),
};

type Fake = {
  config: pg.PoolConfig;
  query: Mock<(text: string) => Promise<unknown>>;
  end: Mock<() => Promise<void>>;
};

function setup(env: Record<string, string | undefined> = ENV) {
  const made: Fake[] = [];
  const registry = createRegistry(env, {
    settings: (connectionString, name) => ({ connectionString, application_name: name, max: 99 }),
    createPool: (config) => {
      const fake: Fake = {
        config,
        query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
        end: vi.fn(async () => undefined),
      };
      made.push(fake);
      return fake;
    },
  });
  const byName = (name: string) => made.find((fake) => fake.config.application_name === name);
  return { registry, made, byName };
}

// Every text a failure could carry: message, stack, cause and own fields.
function texts(value: unknown): string {
  if (!(value instanceof Error)) return JSON.stringify(value) ?? String(value);
  return [value.message, value.stack, JSON.stringify(value), texts(value.cause ?? "")].join("\n");
}

async function failureOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registry pools", () => {
  it("opens nothing until a pool is asked for, then one pool per name", () => {
    const { registry, made, byName } = setup();
    expect(made).toHaveLength(0);
    const main = registry.pool("main");
    expect(registry.pool("main")).toBe(main);
    registry.pool("logs");
    expect(made).toHaveLength(2);
    expect(byName("main")?.config).toMatchObject({ connectionString: ENV[MAIN] });
    expect(byName("logs")?.config).toMatchObject({ connectionString: ENV[LOGS] });
  });

  it("takes the limit of each pool from POOLS, not from the settings", () => {
    const { registry, byName } = setup();
    for (const name of ["main", "auth", "logs", "legal"] as const) {
      registry.pool(name);
      expect(byName(name)?.config.max).toBe(POOLS[name].max);
    }
  });

  it("refuses an unknown name instead of a default", () => {
    const { registry, made } = setup();
    expect(() => registry.pool("archive" as "main")).toThrow("unknown database pool");
    expect(() => registry.pool("__proto__" as "main")).toThrow("unknown database pool");
    expect(made).toHaveLength(0);
  });

  it("names the variable, never its value, when a pool cannot be made", async () => {
    const { registry } = setup({ ...ENV, [LOGS]: undefined, [LEGAL]: "  " });
    expect(() => registry.pool("logs")).toThrow("LOGS_DATABASE_URL is not set");
    expect(() => registry.pool("legal")).toThrow("LEGAL_DATABASE_URL is not set");

    const broken = setup({ ...ENV, [LOGS]: `not a url :${CANARY}` });
    const error = await failureOf(() => broken.registry.pool("logs"));
    expect((error as Error).message).toBe("LOGS_DATABASE_URL is not a URL");
    expect(texts(error)).not.toContain(CANARY);
    const other = setup({ ...ENV, [LOGS]: `mysql://logs:${CANARY}@db.invalid/x` });
    expect(() => other.registry.pool("logs")).toThrow("LOGS_DATABASE_URL is not a postgres URL");
  });

  it("reads the environment at first use, not when it is made", () => {
    const env: Record<string, string | undefined> = {};
    const { registry } = setup(env);
    env[LOGS] = ENV[LOGS];
    expect(() => registry.pool("logs")).not.toThrow();
  });
});

describe("registry health", () => {
  it("reports every database apart", async () => {
    const { registry, byName } = setup({ ...ENV, [LEGAL]: undefined });
    registry.pool("logs");
    byName("logs")?.query.mockRejectedValue(new Error(`connect to ${ENV[LOGS]}`));
    const report = await registry.health();
    expect(report).toEqual({ main: "ok", logs: "nedostupno", legal: "nije_konfigurirano" });
    expect(Object.isFrozen(report)).toBe(true);
    expect(texts(report)).not.toContain(CANARY);
    // A database without its variable is not dialled.
    expect(byName("legal")).toBeUndefined();
    expect(byName("auth")).toBeUndefined();
  });

  it("does not let a frozen database hold the others back", async () => {
    vi.useFakeTimers();
    const { registry, byName } = setup();
    registry.pool("logs");
    byName("logs")?.query.mockReturnValue(new Promise(() => {}));
    const pending = registry.health();
    await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ main: "ok", logs: "nedostupno", legal: "ok" });
  });

  it("reports a variable that is not a URL as nije_konfigurirano, without its value", async () => {
    const { registry } = setup({ ...ENV, [LOGS]: `x:${CANARY}` });
    const report = await registry.health();
    expect(report.logs).toBe("nije_konfigurirano");
    expect(texts(report)).not.toContain(CANARY);
  });
});

describe("registry close", () => {
  it("ends every pool it made, once, and refuses afterwards", async () => {
    const { registry, made } = setup();
    registry.pool("main");
    registry.pool("logs");
    await registry.close();
    expect(made.map((fake) => fake.end.mock.calls.length)).toEqual([1, 1]);
    expect(() => registry.pool("main")).toThrow(CLOSED_MESSAGE);
    expect(() => registry.pool("legal")).toThrow(CLOSED_MESSAGE);
    expect(made).toHaveLength(2);
    await expect(registry.health()).resolves.toEqual({
      main: "nedostupno",
      logs: "nedostupno",
      legal: "nedostupno",
    });
    expect(made.map((fake) => fake.query.mock.calls.length)).toEqual([0, 0]);
  });

  it("ends the other pools when one fails to end, and says how many failed", async () => {
    const { registry, made, byName } = setup();
    registry.pool("main");
    registry.pool("logs");
    registry.pool("legal");
    byName("logs")?.end.mockRejectedValue(new Error(`end ${ENV[LOGS]}`));
    const error = await failureOf(() => registry.close());
    expect((error as Error).message).toBe("1 database pool(s) did not close");
    expect(texts(error)).not.toContain(CANARY);
    expect(made.map((fake) => fake.end.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("makes no pool to close it", async () => {
    const { registry, made } = setup();
    await registry.close();
    expect(made).toHaveLength(0);
  });
});
