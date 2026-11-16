// The metrics sampling of the entry point (S-1K.4-b part 5a, DAN-834-5a;
// contract Ductus#1836 c.6932720649). Fake clock, fake health and store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetricsSampling, serverShutdownHooks } from "./metrics-sampling.ts";
import { createShutdownCoordinator, installShutdown } from "./shutdown.ts";

const MARKER = "postgres://logs:invented-canary-5a17@db.invalid/x";
const health = () =>
  Promise.resolve({ main: "ok", logs: "nedostupno", legal: "nije_konfigurirano" });

type Query = (text: string, values: unknown[]) => unknown;

function setup(query: Query) {
  const store = { query: vi.fn(query) };
  const log = vi.fn();
  const sampling = createMetricsSampling({ intervalMs: 5_000, health, store, log });
  return { store, log, sampling };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createMetricsSampling", () => {
  it("a store that throws or rejects: the round is skipped and logged by reason only", async () => {
    let calls = 0;
    const { store, log, sampling } = setup(() => {
      calls += 1;
      if (calls === 1) throw new Error(MARKER);
      if (calls === 2) return Promise.reject(new Error(MARKER));
      return Promise.resolve();
    });
    sampling.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.mock.calls).toEqual([
      ["warn", "metrics.round_skipped", { reason: "write_failed" }],
      ["warn", "metrics.round_skipped", { reason: "write_failed" }],
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.query).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("invented-canary");
    await sampling.hook.run();
  });

  it("a store that hangs: write_failed at the deadline, and again until the query settles", async () => {
    let settle: () => void = () => undefined;
    const { store, log, sampling } = setup(() => new Promise<void>((r) => (settle = r)));
    sampling.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(log.mock.calls).toEqual([["warn", "metrics.round_skipped", { reason: "write_failed" }]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.query).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.query).toHaveBeenCalledTimes(2);
    await sampling.hook.run();
  });

  it("nothing before the interval; then one write of database_connections, no other text", async () => {
    const { store, sampling } = setup(() => Promise.resolve());
    sampling.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.query).toHaveBeenCalledTimes(1);
    const [, values] = store.query.mock.calls[0] ?? [];
    expect(JSON.parse(String((values as unknown[])[0]))).toEqual([
      { metric: "database_connections", value: 1, labels: { database: "main" } },
      { metric: "database_connections", value: 0, labels: { database: "logs" } },
    ]);
    await sampling.hook.run();
  });

  it("the hook waits for the round in progress, and no round runs after it", async () => {
    let settle: () => void = () => undefined;
    const { store, sampling } = setup(() => new Promise<void>((r) => (settle = r)));
    expect(sampling.hook.name).toBe("metrics");
    sampling.start();
    await vi.advanceTimersByTimeAsync(5_000);
    let stopped = false;
    const stopping = Promise.resolve(sampling.hook.run()).then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);
    settle();
    await stopping;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.query).toHaveBeenCalledTimes(1);
  });
});

describe("serverShutdownHooks", () => {
  it("stops metrics, then flushes the logs, then closes the databases", () => {
    const metrics = { hook: { name: "metrics", run: () => undefined } };
    const hooks = serverShutdownHooks({ metrics, databases: { close: () => Promise.resolve() } });
    expect(hooks.map((hook) => hook.name)).toEqual(["metrics", "logs", "databases"]);
  });

  it("through installShutdown, closing the databases waits until metrics have stopped", async () => {
    vi.useRealTimers();
    const order: string[] = [];
    let settle: () => void = () => undefined;
    const metrics = {
      hook: {
        name: "metrics",
        run: () => new Promise<void>((r) => (settle = r)).then(() => void order.push("metrics")),
      },
    };
    const close = vi.fn(() => (order.push("databases"), Promise.resolve()));
    let onSignal: () => void = () => undefined;
    const exited = new Promise<number>((exit) =>
      installShutdown(
        { on: (_, listener) => (onSignal = listener), off: () => undefined },
        {
          coordinator: createShutdownCoordinator({ graceMs: 5_000 }),
          listener: { stopAccepting: () => undefined, closeAllConnections: () => undefined },
          hooks: serverShutdownHooks({ metrics, databases: { close } }),
          exit,
        },
      ),
    );
    onSignal();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(close).not.toHaveBeenCalled();
    settle();
    expect(await exited).toBe(0);
    expect(order).toEqual(["metrics", "databases"]);
  });
});
