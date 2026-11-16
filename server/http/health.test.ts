// Health (S-1M-a, DAN-795) over a fake registry and a fake clock: which state
// each database word gives, the deadline, one check for many requests, and
// that nothing of a failed check reaches the answer or the log.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_VERSION, MIN_CLIENT_VERSION } from "../contracts/index.ts";
import type { HealthReport } from "../database/index.ts";
import { CHECK_DEADLINE_MS, CHECK_REUSE_MS, createHealthRoute } from "./health.ts";

const CANARY = "invented-canary-h795";
const UP: HealthReport = { main: "ok", logs: "ok", legal: "ok" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { status: number; headers: Record<string, string>; body: Record<string, unknown> };

async function ask(route: ReturnType<typeof createHealthRoute>): Promise<Answer> {
  const answer = { status: 0, headers: {} as Record<string, string>, text: "" };
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      answer.headers = headers;
    },
    end(text: string) {
      answer.text = text;
    },
  } as unknown as ServerResponse;
  await route.handle({} as IncomingMessage, response);
  const body = JSON.parse(answer.text) as Record<string, unknown>;
  return { status: answer.status, headers: answer.headers, body };
}

const routeOver = (health: () => Promise<HealthReport>, now?: () => number) =>
  createHealthRoute({ health, serverVersion: "4.5.6", ...(now ? { now } : {}) });

describe("health", () => {
  it("answers the closed body of its contract, 200 and no-store", async () => {
    const route = routeOver(async () => UP);
    const answer = await ask(route);
    expect(answer.status).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).toEqual({
      status: "ok",
      state: "ok",
      apiVersion: API_VERSION,
      serverVersion: "4.5.6",
      minClientVersion: MIN_CLIENT_VERSION,
    });
    // The deprecated `version` is never sent.
    expect(Object.keys(answer.body).sort()).toEqual(
      ["apiVersion", "minClientVersion", "serverVersion", "state", "status"].sort(),
    );
    expect(Value.Check(route.contract.responses[0]?.body as never, answer.body)).toBe(true);
  });

  it.each([
    ["main down", { ...UP, main: "nedostupno" }, "degraded"],
    ["main not configured", { ...UP, main: "nije_konfigurirano" }, "degraded"],
    ["logs down", { ...UP, logs: "nedostupno" }, "ok"],
    ["legal not configured", { ...UP, legal: "nije_konfigurirano" }, "ok"],
    ["logs and legal down", { main: "ok", logs: "nedostupno", legal: "nedostupno" }, "ok"],
  ] as const)("%s → %s", async (_, report, state) => {
    const answer = await ask(routeOver(async () => report));
    expect([answer.status, answer.body.state, answer.body.status]).toEqual([200, state, "ok"]);
  });

  it.each([
    ["rejects", async () => Promise.reject(new Error(`connect ${CANARY}.invalid:5432 ${CANARY}`))],
    [
      "throws before a promise",
      () => {
        throw new Error(`password authentication failed for user "${CANARY}"`);
      },
    ],
    ["answers a word outside the list", async () => ({ ...UP, main: CANARY }) as never],
  ])("a check that %s is degraded, and nothing of it is answered or logged", async (_, health) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answer = await ask(routeOver(health as () => Promise<HealthReport>));
    expect(answer.body.state).toBe("degraded");
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  it("a check that never settles is degraded at the deadline, not later", async () => {
    vi.useFakeTimers();
    const route = routeOver(async () => new Promise<HealthReport>(() => undefined));
    let settled = false;
    const pending = ask(route).then((answer) => ((settled = true), answer));
    await vi.advanceTimersByTimeAsync(CHECK_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).body.state).toBe("degraded");
  });

  it("many requests at once make one check; it is reused for CHECK_REUSE_MS only", async () => {
    let clock = 1_000;
    let release: (report: HealthReport) => void = () => undefined;
    const health = vi.fn(
      async () =>
        new Promise<HealthReport>((resolve) => {
          release = resolve;
        }),
    );
    const route = routeOver(health, () => clock);
    const many = Array.from({ length: 10 }, async () => ask(route));
    await Promise.resolve();
    release(UP);
    expect((await Promise.all(many)).map((a) => a.body.state)).toEqual(Array(10).fill("ok"));
    expect(health).toHaveBeenCalledTimes(1);

    clock += CHECK_REUSE_MS - 1;
    await ask(route);
    expect(health).toHaveBeenCalledTimes(1);

    clock += 1;
    health.mockImplementation(async () => ({ ...UP, main: "nedostupno" }));
    expect((await ask(route)).body.state).toBe("degraded");
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("a failed check is not kept past CHECK_REUSE_MS: the next one may be ok", async () => {
    let clock = 0;
    let report: HealthReport = { ...UP, main: "nedostupno" };
    const route = routeOver(
      async () => report,
      () => clock,
    );
    expect((await ask(route)).body.state).toBe("degraded");
    report = UP;
    clock += CHECK_REUSE_MS;
    expect((await ask(route)).body.state).toBe("ok");
  });

  // QA (adversarial pass on 6e4f610), F1: a throw while reading the report
  // left the shared check rejected, and every later request answered 500.
  it("a report that cannot be read is degraded, and the next check runs again", async () => {
    let clock = 0;
    let report: HealthReport | undefined;
    const route = routeOver(
      async () => report as HealthReport,
      () => clock,
    );
    expect((await ask(route)).body.state).toBe("degraded");
    report = UP;
    clock += CHECK_REUSE_MS;
    expect((await ask(route)).body.state).toBe("ok");
  });

  // QA (adversarial pass on 6e4f610), F2: a clock stepped back kept the last
  // state for as long as the step.
  it("a clock stepped back does not keep the last state", async () => {
    let clock = 3_600_000;
    let report: HealthReport = { ...UP, main: "nedostupno" };
    const route = routeOver(
      async () => report,
      () => clock,
    );
    expect((await ask(route)).body.state).toBe("degraded");
    report = UP;
    clock -= 3_600_000;
    expect((await ask(route)).body.state).toBe("ok");
  });
});
