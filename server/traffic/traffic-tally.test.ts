// DAN-834-3: the traffic tally on invented traffic.request records. The
// criterion "a sample carries no personal data" is also checked as a property
// in traffic-tally.property.test.ts.
import { describe, expect, it } from "vitest";

import { checkEvent } from "../log/index.ts";
import { LATENCY_BUCKETS_MS, createTrafficTally } from "./traffic-tally.ts";
import { MAX_DURATION_MS } from "./traffic-record.ts";

const ZERO = [
  { metric: "request_count", value: 0 },
  { metric: "error_count", value: 0 },
  { metric: "latency_p95_ms", value: 0 },
];

const record = (status: unknown, durationMs: unknown, extra: object = {}) => ({
  time: "2026-11-16T09:30:00.000Z",
  event: "traffic.request",
  requestId: "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192",
  accountKind: "anonymous",
  fields: { method: "GET", route: "none", ip: "192.0.2.10", status, durationMs, ...extra },
});

const tallyOf = (inputs: readonly unknown[]) => {
  const tally = createTrafficTally();
  for (const input of inputs) tally.observe(input);
  return tally.take();
};

const throwing = new Proxy(
  {},
  {
    get: () => {
      throw new Error("trap");
    },
    getOwnPropertyDescriptor: () => {
      throw new Error("trap");
    },
    getPrototypeOf: () => {
      throw new Error("trap");
    },
  },
);
const revoked = Proxy.revocable([], {});
revoked.revoke();

describe("traffic tally: inputs that are not counted", () => {
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["number", 5],
    ["string", "traffic.request"],
    ["array with own event", Object.assign([], record(200, 5))],
    ["another event", { ...record(200, 5), event: "metrics.collected" }],
    ["status as string", record("500", 5)],
    ["status 500.5", record(500.5, 5)],
    ["status NaN", record(Number.NaN, 5)],
    ["status Infinity", record(Infinity, 5)],
    ["status 99", record(99, 5)],
    ["status 600", record(600, 5)],
    ["status -1", record(-1, 5)],
    ["duration -1", record(200, -1)],
    ["duration 1.5", record(200, 1.5)],
    ["duration over the catalogue", record(200, MAX_DURATION_MS + 1)],
    ["duration as string", record(200, "5")],
    ["no fields", { event: "traffic.request" }],
    ["null fields", { event: "traffic.request", fields: null }],
    ["inherited event and fields", Object.create(record(200, 5))],
    [
      "inherited status",
      { event: "traffic.request", fields: Object.create({ status: 200, durationMs: 5 }) },
    ],
    [
      "__proto__ key",
      JSON.parse(
        '{"__proto__":{"event":"traffic.request","fields":{"status":200,"durationMs":5}}}',
      ),
    ],
    ["throwing proxy", throwing],
    ["throwing proxy as fields", { event: "traffic.request", fields: throwing }],
    ["revoked proxy", revoked.proxy],
  ];
  it.each(cases)("%s: not counted and never throws", (_, input) => {
    expect(tallyOf([input])).toEqual(ZERO);
  });

  it("never calls a getter on the record", () => {
    let calls = 0;
    const fields = { durationMs: 5 };
    Object.defineProperty(fields, "status", { enumerable: true, get: () => (calls++, 200) });
    expect(tallyOf([{ event: "traffic.request", fields }])).toEqual(ZERO);
    expect(calls).toBe(0);
  });
});

describe("traffic tally: samples", () => {
  it("are three frozen samples with only metric and value, in a closed alphabet", () => {
    const samples = tallyOf([record(200, 12), record(503, 40)]);
    expect(Object.isFrozen(samples)).toBe(true);
    for (const sample of samples) {
      expect(Object.isFrozen(sample)).toBe(true);
      expect(Reflect.ownKeys(sample)).toEqual(["metric", "value"]);
      expect(Number.isSafeInteger(sample.value) && sample.value >= 0).toBe(true);
    }
    expect(JSON.stringify(samples)).toMatch(/^[[\]{}":,a-z0-9_]*$/);
  });

  it("are metrics.collected fields the catalogue accepts", () => {
    for (const { metric, value } of tallyOf([record(200, 12)])) {
      const event = { ...record(0, 0), event: "metrics.collected", fields: { metric, value } };
      expect(checkEvent(event, { routes: new Set() }).ok, metric).toBe(true);
    }
  });

  it("count requests and errors: 5xx is an error, 499 and 404 are not", () => {
    const samples = tallyOf([500, 503, 499, 404, 200].map((status) => record(status, 1)));
    expect(samples.slice(0, 2)).toEqual([
      { metric: "request_count", value: 5 },
      { metric: "error_count", value: 2 },
    ]);
  });

  it("take empties the window", () => {
    const tally = createTrafficTally();
    tally.observe(record(500, 7));
    expect(tally.take()).not.toEqual(ZERO);
    expect(tally.take()).toEqual(ZERO);
  });
});

describe("traffic tally: p95", () => {
  const p95 = (durations: readonly number[]) =>
    tallyOf(durations.map((ms) => record(200, ms)))[2]!.value;

  it("has increasing buckets that end at the catalogue's longest duration", () => {
    expect([...LATENCY_BUCKETS_MS].sort((a, b) => a - b)).toEqual(LATENCY_BUCKETS_MS);
    expect(new Set(LATENCY_BUCKETS_MS).size).toBe(LATENCY_BUCKETS_MS.length);
    expect(LATENCY_BUCKETS_MS.at(-1)).toBe(MAX_DURATION_MS);
  });

  it("is the bound of the first bucket the duration fits, edges included", () => {
    expect(p95([0])).toBe(5);
    expect(p95([5])).toBe(5);
    expect(p95([6])).toBe(10);
    expect(p95([60_000])).toBe(60_000);
    expect(p95([60_001])).toBe(MAX_DURATION_MS);
    expect(p95([MAX_DURATION_MS])).toBe(MAX_DURATION_MS);
  });

  it("takes rank ceil(0.95 n): 19 of 20, 20 of 21", () => {
    expect(p95([...Array<number>(19).fill(1), 1000])).toBe(5);
    expect(p95([...Array<number>(19).fill(1), 1000, 1000])).toBe(1000);
  });
});
