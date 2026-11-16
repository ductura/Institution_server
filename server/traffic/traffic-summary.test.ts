// DAN-836-1: the traffic summary on invented traffic.request records and a
// fake clock. Criterion K2 (contract Ductus#1836): the window has an upper
// bound and a larger one is refused.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_ENTRIES,
  MAX_WINDOW_MINUTES,
  TRAFFIC_SUMMARY_ERROR_CODES,
  createTrafficSummary,
} from "./traffic-summary.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 16, 9, 30);

const record = (route: unknown, status: unknown) => ({
  time: "2026-11-16T09:30:00.000Z",
  event: "traffic.request",
  requestId: "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192",
  accountKind: "anonymous",
  fields: { method: "GET", route, ip: "192.0.2.10", status, durationMs: 5 },
});

const clock = () => {
  let ms = START;
  return { now: () => ms, advance: (minutes: number) => (ms += minutes * MINUTE) };
};

const failure = (code: string) => ({
  ok: false,
  error: { code, messageKey: `trafficSummary.${code.toLowerCase()}` },
});

describe("traffic summary: windows that are refused", () => {
  const summary = createTrafficSummary({ now: clock().now });

  it("rejects a window above the bound", () => {
    for (const window of [MAX_WINDOW_MINUTES + 1, 2 ** 53, Number.MAX_VALUE, Infinity]) {
      expect(summary.summarize(window), String(window)).toEqual(
        failure("TRAFFIC_WINDOW_TOO_LARGE"),
      );
    }
  });

  it("rejects a window that is not a whole number of minutes", () => {
    const inputs: unknown[] = [0, -0, -1, -Infinity, 1.5, Number.NaN, "60", " 60", "60\r\n"];
    inputs.push(60n, null, undefined, {}, [60], { valueOf: () => 60 }, true);
    for (const window of inputs) {
      expect(summary.summarize(window), String(window)).toEqual(failure("TRAFFIC_WINDOW_INVALID"));
    }
  });

  it("has a Croatian text for every code and no other key", () => {
    const texts = JSON.parse(
      readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
    ) as { trafficSummary: Record<string, string> };
    expect(Object.keys(texts.trafficSummary)).toEqual(
      TRAFFIC_SUMMARY_ERROR_CODES.map((code) => code.toLowerCase()),
    );
    for (const text of Object.values(texts.trafficSummary)) expect(text.length).toBeGreaterThan(0);
  });
});

describe("traffic summary: records that are not counted", () => {
  const getter = record("/api/v1/ready", 200);
  Object.defineProperty(getter.fields, "route", { get: () => "/api/v1/ready", enumerable: true });
  const throwing = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("trap");
      },
    },
  );
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["array", Object.assign([], record("/api/v1/a", 200))],
    ["another event", { ...record("/api/v1/a", 200), event: "metrics.collected" }],
    ["inherited fields", Object.assign(Object.create(record("/api/v1/a", 200)) as object, {})],
    [
      "__proto__ fields",
      { event: "traffic.request", ["__proto__"]: record("/api/v1/a", 200).fields },
    ],
    ["route as getter", getter],
    ["throwing proxy", throwing],
    ["status as string", record("/api/v1/a", "200")],
    ["status 200.5", record("/api/v1/a", 200.5)],
    ["status 99", record("/api/v1/a", 99)],
    ["status 600", record("/api/v1/a", 600)],
    ["route not a string", record(7, 200)],
    ["empty route", record("", 200)],
    ["route without slash", record("api", 200)],
    ["route with tab", record("/api/v1/a\tb", 200)],
    ["route with CR", record("/api/v1/a\rb", 200)],
    ["route with LF", record("/api/v1/a\nb", 200)],
    ["route with space", record("/api/v1/a b", 200)],
    ["route with NBSP", record("/api/v1/a\u00a0b", 200)],
    ["route with DEL", record("/api/v1/a\u007fb", 200)],
    ["route with a Windows path", record("C:\\a", 200)],
    ["route with a trailing CRLF", record("/api/v1/a\r\n", 200)],
    ["route with a query", record("/api/v1/a?ip=192.0.2.10", 200)],
    ["route in upper case", record("/api/v1/Ready", 200)],
    ["route outside /api/v1", record("/admin", 200)],
    ["route with 11 segments", record(`/api/v1${"/a".repeat(11)}`, 200)],
    ["segment over 40 characters", record(`/api/v1/${"a".repeat(41)}`, 200)],
  ];
  it.each(cases)("skips %s and never throws", (_name, input) => {
    const summary = createTrafficSummary({ now: clock().now });
    expect(() => summary.observe(input)).not.toThrow();
    expect(summary.summarize(1)).toEqual({
      ok: true,
      value: { windowMinutes: 1, total: 0, rows: [] },
    });
  });

  it.each([
    ["no number", () => Number.NaN],
    [
      "a throw",
      () => {
        throw new Error("clock");
      },
    ],
  ])("skips a record and sums nothing when the clock gives %s", (_name, now) => {
    const summary = createTrafficSummary({ now });
    expect(() => summary.observe(record("/api/v1/a", 200))).not.toThrow();
    expect(summary.summarize(1)).toMatchObject({ ok: true, value: { total: 0, rows: [] } });
  });

  it("stops counting new entries at the bound and keeps counting known ones", () => {
    const summary = createTrafficSummary({ now: clock().now });
    for (let status = 100; status < 600; status += 1) {
      for (let route = 0; route < 101; route += 1)
        summary.observe(record(`/api/v1/r${route}`, status));
    }
    summary.observe(record("/api/v1/r0", 100));
    const result = summary.summarize(1);
    expect(result.ok && result.value.rows.length).toBe(MAX_ENTRIES);
    expect(result.ok && result.value.total).toBe(MAX_ENTRIES + 1);
  });
});

describe("traffic summary: sums", () => {
  it("accepts the bounds", () => {
    const summary = createTrafficSummary({ now: clock().now });
    expect(summary.summarize(1)).toMatchObject({ ok: true, value: { windowMinutes: 1 } });
    expect(summary.summarize(MAX_WINDOW_MINUTES)).toMatchObject({ ok: true });
    expect(MAX_WINDOW_MINUTES).toBe(1440);
  });

  it("sums by route and status inside the window", () => {
    const time = clock();
    const summary = createTrafficSummary({ now: time.now });
    summary.observe(record("/api/v1/old", 200));
    time.advance(10);
    summary.observe(record("/api/v1/ready", 503));
    time.advance(50);
    summary.observe(record("/api/v1/ready", 200));
    summary.observe(record("/api/v1/ready", 200));
    summary.observe(record("none", 404));
    expect(summary.summarize(60)).toEqual({
      ok: true,
      value: {
        windowMinutes: 60,
        total: 4,
        rows: [
          { route: "/api/v1/ready", status: 200, count: 2 },
          { route: "/api/v1/ready", status: 503, count: 1 },
          { route: "none", status: 404, count: 1 },
        ],
      },
    });
    expect(summary.summarize(61)).toMatchObject({ value: { total: 5 } });
    expect(summary.summarize(1)).toMatchObject({ value: { total: 3 } });
  });

  it("drops minutes older than the bound", () => {
    const time = clock();
    const summary = createTrafficSummary({ now: time.now });
    summary.observe(record("/api/v1/a", 200));
    time.advance(MAX_WINDOW_MINUTES);
    summary.observe(record("/api/v1/a", 201));
    time.advance(-MAX_WINDOW_MINUTES);
    expect(summary.summarize(1)).toMatchObject({ value: { total: 0 } });
  });

  it("does not count a minute after the clock when the clock goes back", () => {
    const time = clock();
    const summary = createTrafficSummary({ now: time.now });
    time.advance(5);
    summary.observe(record("/api/v1/a", 200));
    time.advance(-5);
    summary.observe(record("/api/v1/a", 200));
    expect(summary.summarize(10)).toMatchObject({ value: { total: 1 } });
    time.advance(5);
    expect(summary.summarize(10)).toMatchObject({ value: { total: 2 } });
  });

  it("keeps no IP or request id", () => {
    const summary = createTrafficSummary({ now: clock().now });
    summary.observe(record("/api/v1/a", 200));
    const result = summary.summarize(5);
    const text = JSON.stringify(result);
    expect(text).not.toContain("192.0.2.10");
    expect(text).not.toContain("3f2a7c1e");
    expect(Object.isFrozen(result.ok && result.value.rows[0])).toBe(true);
    expect(Object.keys(result.ok ? result.value.rows[0]! : {})).toEqual([
      "route",
      "status",
      "count",
    ]);
  });
});
