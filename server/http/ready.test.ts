// Readiness core (S-1E-d, DAN-839-1; port of Ductus src/server/ready.ts at
// 393b8e0) over a fake clock: each probe's own limit inside one total limit,
// an answer judged by when it ended, closed words only, and the input classes
// refused when the check is made. Contract: Ductus#1836 c.6928581107.
import { createFakeClock, type FakeClock } from "@ductura/test-fakes/clock";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import {
  createReadyCheck,
  READY_TIMEOUT_MS,
  type ReadyCapability,
  type ReadyCheckOptions,
  type ReadyReport,
} from "./ready.ts";

const CANARY = "postgres://db.invalid:5432 PostgreSQL 16.4";
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const hang = (): Promise<never> => new Promise<never>(() => {});
const ok = async () => "ok" as const;
const cap = (over: Partial<ReadyCapability> = {}): ReadyCapability => ({
  name: "database",
  required: true,
  timeoutMs: 1_000,
  probe: ok,
  ...over,
});

let clock: FakeClock;
const checkOf = (capabilities: unknown, totalMs?: number) =>
  createReadyCheck(capabilities as readonly ReadyCapability[], {
    now: () => clock.nowMs(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    ...(totalMs === undefined ? {} : { totalMs }),
  });

/**
 * Starts a check, lets what is ready at time 0 run (a real clock does not
 * jump while microtasks wait), and reports whether it ended, and with what.
 */
async function start(check: () => Promise<ReadyReport>) {
  const state: { report?: ReadyReport } = {};
  void check().then((report) => (state.report = report));
  await settle();
  return state;
}

afterEach(() => {
  clock = createFakeClock();
});
clock = createFakeClock();

describe("ready check limits", () => {
  it("a hanging probe ends at its own limit", async () => {
    const state = await start(checkOf([cap({ probe: hang })]));
    clock.advance(999);
    await settle();
    expect(state.report).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(state.report).toEqual({
      ready: false,
      capabilities: { database: "nedostupno" },
      codes: { database: "TIMEOUT" },
    });
  });

  it("an answer exactly at the limit is ok", async () => {
    const state = await start(
      checkOf([cap({ probe: async () => clock.sleep(1_000).then(() => "ok" as const) })]),
    );
    clock.advance(1_000);
    await settle();
    expect(state.report?.capabilities).toEqual({ database: "ok" });
  });

  it("synchronous work past the limit is a timeout", async () => {
    const probe = async (): Promise<"ok"> => {
      clock.advance(1_001); // stands for work that blocks the event loop
      return "ok";
    };
    const report = await checkOf([cap({ probe })])();
    expect(report.codes).toEqual({ database: "TIMEOUT" });
  });

  it("the total limit caps a longer own limit", async () => {
    const state = await start(checkOf([cap({ timeoutMs: 10_000, probe: hang })], READY_TIMEOUT_MS));
    clock.advance(READY_TIMEOUT_MS);
    await settle();
    expect(state.report?.codes).toEqual({ database: "TIMEOUT" });
  });

  it("synchronous work of one probe spends the total limit of the others", async () => {
    const busy = (ms: number) => async (): Promise<"ok"> => {
      clock.advance(ms); // stands for work that blocks the event loop
      return "ok";
    };
    const called: string[] = [];
    const later = async (): Promise<never> => {
      called.push("queue");
      return hang();
    };
    const spent = checkOf([cap({ probe: busy(80) }), cap({ name: "queue", probe: hang })], 100);
    const state = await start(spent);
    clock.advance(19);
    await settle();
    expect(state.report).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(state.report?.capabilities).toEqual({ database: "ok", queue: "nedostupno" });
    // Past the total limit before its turn: the probe is never called.
    const over = await checkOf(
      [cap({ probe: busy(120) }), cap({ name: "queue", probe: later })],
      100,
    )();
    expect(over.codes).toEqual({ database: "TIMEOUT", queue: "TIMEOUT" });
    expect(called).toEqual([]);
  });

  it("one slow probe holds no other", async () => {
    const check = checkOf([
      cap({ name: "storage", required: false, timeoutMs: 2_500, probe: hang }),
      cap({ name: "database", probe: ok }),
    ]);
    const state = await start(check);
    clock.advance(2_499);
    await settle();
    expect(state.report).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(state.report).toEqual({
      ready: true,
      capabilities: { storage: "nedostupno", database: "ok" },
      codes: { storage: "TIMEOUT" },
    });
  });

  it("a late answer changes nothing", async () => {
    const seen: unknown[] = [];
    const listen = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listen);
    try {
      let fail: (error: Error) => void = () => {};
      const probe = () => new Promise<"ok">((_, reject) => (fail = reject));
      const state = await start(checkOf([cap({ probe })]));
      clock.advance(1_000);
      await settle();
      fail(new Error(CANARY));
      await settle();
      expect(state.report?.codes).toEqual({ database: "TIMEOUT" });
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });

  it("the probe signal aborts when its part ends", async () => {
    const signals: AbortSignal[] = [];
    const probe = (signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? hang() : ok();
    };
    const state = await start(checkOf([cap({ probe }), cap({ name: "queue", probe })]));
    await settle();
    expect(signals.map((s) => s.aborted)).toEqual([false, true]);
    clock.advance(1_000);
    await settle();
    expect(state.report).toBeDefined();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });

  it("only required capabilities decide ready", async () => {
    const down = async (): Promise<"ok"> => Promise.reject(new Error("down"));
    const optional = await checkOf([cap(), cap({ name: "queue", required: false, probe: down })])();
    expect(optional.ready).toBe(true);
    const required = await checkOf([cap({ probe: async () => "nije_konfigurirano" })])();
    expect(required.ready).toBe(false);
    expect(await checkOf([])()).toEqual({ ready: true, capabilities: {}, codes: {} });
  });
});

describe("ready check after review on e440952", () => {
  it("an early answer is timed before a later probe's synchronous work", async () => {
    const busy = async (): Promise<"ok"> => {
      clock.advance(80); // stands for work that blocks the event loop
      return "ok";
    };
    const check = checkOf(
      [
        cap({ timeoutMs: 50, probe: async () => Promise.resolve("ok" as const) }),
        cap({ name: "queue", probe: busy }),
      ],
      100,
    );
    expect(await check()).toEqual({
      ready: true,
      capabilities: { database: "ok", queue: "ok" },
      codes: {},
    });
  });

  it("a timer that wakes early is not the limit", async () => {
    let early = true;
    const check = createReadyCheck(
      [cap({ probe: async () => clock.sleep(1_000).then(() => "ok" as const) })],
      {
        now: () => clock.nowMs(),
        sleep: async (ms, signal) => {
          const wait = early ? ms - 1 : ms;
          early = false;
          return clock.sleep(wait, signal);
        },
      },
    );
    const state = await start(check);
    clock.advance(999);
    await settle();
    expect(state.report).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(state.report?.capabilities).toEqual({ database: "ok" });
  });

  it("a fractional limit is waited out in whole milliseconds", async () => {
    const asked: number[] = [];
    const busy = async (): Promise<"ok"> => {
      clock.advance(0.25);
      return "ok";
    };
    const check = createReadyCheck([cap({ probe: busy }), cap({ name: "queue", probe: hang })], {
      totalMs: 100,
      now: () => clock.nowMs(),
      sleep: async (ms, signal) => {
        asked.push(ms);
        return clock.sleep(ms, signal);
      },
    });
    const state = await start(check);
    clock.advance(99);
    await settle();
    expect(state.report).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(state.report?.codes).toEqual({ queue: "TIMEOUT" });
    expect(asked.every((ms) => Number.isInteger(ms))).toBe(true);
  });

  it.each([
    ["a sparse list", new Array<ReadyCapability>(1), {}],
    ["totalMs null", [], { totalMs: null }],
    ["inherited totalMs", [], Object.create({ totalMs: 100 }) as object],
    ["null options", [], null],
  ])("refuses %s when made", (_, capabilities, options) => {
    expect(() => createReadyCheck(capabilities, options as ReadyCheckOptions)).toThrow(RangeError);
  });
});

describe("ready check answers and codes", () => {
  it.each([
    ["OK"],
    ["ok\n"],
    ["ok\r\n"],
    [" ok"],
    ["ok\t"],
    ["ok\u00a0"],
    ["ok\u007f"],
    [new String("ok")],
    [{ toString: (): string => "ok" }],
    [undefined],
    [null],
  ])("an answer of %j is nedostupno", async (answer) => {
    const report = await checkOf([cap({ probe: async () => answer as "ok" })])();
    expect(report.capabilities).toEqual({ database: "nedostupno" });
    expect(report.codes).toEqual({ database: "ERROR" });
  });

  const withCode = (code: unknown) => Object.assign(new Error(CANARY), { code });
  const inherited = Object.create({ code: "INHERITED" }) as object;
  const getter = Object.defineProperty({}, "code", {
    get: () => {
      throw new Error(CANARY);
    },
  });
  const trap = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error(CANARY);
      },
    },
  );
  it.each([
    ["CRLF", withCode("A\r\nB"), "ERROR"],
    ["trailing LF", withCode("ECONN\n"), "ERROR"],
    ["tab", withCode("A\tB"), "ERROR"],
    ["NBSP", withCode("A\u00a0B"), "ERROR"],
    ["DEL", withCode("A\u007f"), "ERROR"],
    ["Windows path", withCode("c:\\x"), "ERROR"],
    ["33 characters", withCode("A".repeat(33)), "ERROR"],
    ["number", withCode(57), "ERROR"],
    ["inherited", inherited, "ERROR"],
    ["throwing getter", getter, "ERROR"],
    ["proxy", trap, "ERROR"],
    ["primitive", CANARY, "ERROR"],
    ["null", null, "ERROR"],
    ["32 characters", withCode("A".repeat(32)), "A".repeat(32)],
    ["plain", withCode("ECONNREFUSED"), "ECONNREFUSED"],
  ])("a probe failing with %s gives code %j", async (_, error, code) => {
    const sync = () => {
      throw error;
    };
    for (const probe of [sync, async () => Promise.reject(error)]) {
      const report = await checkOf([cap({ probe: probe as ReadyCapability["probe"] })])();
      expect(report.codes).toEqual({ database: code });
      expect(JSON.stringify(report)).not.toContain("invalid");
    }
  });

  it("the report fits the ready contract", async () => {
    const ready = ROUTES.find((route) => route.id === "platform.ready.get");
    const schema = (ready?.responses[0]?.body as unknown as { properties: { capabilities: never } })
      .properties.capabilities;
    const state = await start(
      checkOf([cap(), cap({ name: "storage", probe: hang, timeoutMs: 1 })]),
    );
    clock.advance(1);
    await settle();
    expect(Value.Check(schema, state.report?.capabilities)).toBe(true);
  });
});

describe("ready check input", () => {
  const extra = { ...cap(), extra: 1 };
  const proto = Object.assign(Object.create({ required: true }) as object, {
    name: "database",
    timeoutMs: 1,
    probe: ok,
  });
  it.each([
    ["not an array", { 0: cap() }],
    ["unknown name", [cap({ name: "sms" as never })]],
    ["__proto__", [cap({ name: "__proto__" as never })]],
    ["toString", [cap({ name: "toString" as never })]],
    ["duplicate", [cap(), cap()]],
    ["required not boolean", [cap({ required: "true" as never })]],
    ["probe not function", [cap({ probe: "ok" as never })]],
    ["extra key", [extra]],
    ["inherited key", [proto]],
    ["null entry", [null]],
    ...[0, -1, Number.NaN, Infinity, 1.5, "100", 2 ** 31].map(
      (limit) => [`limit ${String(limit)}`, [cap({ timeoutMs: limit as number })]] as const,
    ),
  ] as [string, unknown][])("refuses %s when made", (_, capabilities) => {
    expect(() => checkOf(capabilities)).toThrow(RangeError);
  });

  it.each([0, Number.NaN, 2 ** 31, 1.5])("refuses a total limit of %s", (totalMs) => {
    expect(() => checkOf([cap()], totalMs)).toThrow(RangeError);
  });

  it("keeps its own frozen copy", async () => {
    const list = [cap()];
    const check = checkOf(list);
    list[0] = cap({ probe: async () => Promise.reject(new Error("changed")) });
    expect((await check()).capabilities).toEqual({ database: "ok" });
  });
});

describe("ready check defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the default timer ends a hanging probe and is let go after an answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pending = createReadyCheck([cap({ probe: hang })])();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).codes).toEqual({ database: "TIMEOUT" });
    await createReadyCheck([cap()])();
    expect(vi.getTimerCount()).toBe(0);
  });
});
