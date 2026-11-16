// S-1K.4-b part 4b (DAN-834-4b): the metrics collector interval from the
// environment. Refusals come first; every value below is invented.
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_METRICS_INTERVAL_MS,
  METRICS_INTERVAL_MAX_MS,
  METRICS_INTERVAL_MIN_MS,
  metricsIntervalMs,
  metricsIntervalProblems,
} from "./metrics-interval.ts";

type Env = Parameters<typeof metricsIntervalProblems>[0];
const PROBLEM = "METRICS_INTERVAL_MS is not a whole number from 5000 to 3600000";
const MARKER = "invented-secret";

describe("metricsIntervalProblems refusals", () => {
  it.each([
    "",
    " ",
    "abc",
    "1e4",
    "0x2710",
    "10_000",
    "Infinity",
    "NaN",
    "-0",
    "１００００",
    "10000\n",
    "10000\r\n",
    "\t10000",
    "10000\u00a0",
    "10000\u007f",
    "C:\\metrics\\10000",
    `${MARKER}-10000`,
  ])("refuses %j by the variable name only", (value) => {
    const problems = metricsIntervalProblems({ METRICS_INTERVAL_MS: value });
    expect(problems).toEqual([PROBLEM]);
    expect(problems.join(" ")).not.toContain(MARKER);
  });

  it("refuses a value that is not a string, and never calls a getter", () => {
    expect(metricsIntervalProblems({ METRICS_INTERVAL_MS: 10_000 } as unknown as Env)).toEqual([
      PROBLEM,
    ]);
    const get = vi.fn(() => "10000");
    const env = Object.defineProperty({}, "METRICS_INTERVAL_MS", { get, enumerable: true });
    expect(metricsIntervalProblems(env)).toEqual([PROBLEM]);
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts exactly the plain whole numbers from 5000 to 3600000", () => {
    const wrong: string[] = [];
    const check = (n: number): void => {
      const plain = String(n);
      const ok = n >= 5_000 && n <= 3_600_000;
      const env = { METRICS_INTERVAL_MS: plain };
      if ((metricsIntervalProblems(env).length === 0) !== ok) wrong.push(plain);
      if (ok && metricsIntervalMs(env) !== n) wrong.push(`value ${plain}`);
      for (const variant of [
        `0${plain}`,
        `+${plain}`,
        `-${plain}`,
        ` ${plain}`,
        `${plain} `,
        `${plain}ms`,
        `${plain}.0`,
        `${plain}e0`,
      ]) {
        if (metricsIntervalProblems({ METRICS_INTERVAL_MS: variant }).length === 0) {
          wrong.push(variant);
        }
      }
    };
    for (let n = 0; n <= 12_000; n += 1) check(n);
    for (let n = 3_590_000; n <= 3_610_000; n += 1) check(n);
    expect(wrong).toEqual([]);
  });
});

describe("metricsIntervalMs", () => {
  it("defaults to 60000 ms without the variable, within the bounds", () => {
    expect(metricsIntervalProblems({})).toEqual([]);
    expect(metricsIntervalMs({})).toBe(DEFAULT_METRICS_INTERVAL_MS);
    expect([METRICS_INTERVAL_MIN_MS, DEFAULT_METRICS_INTERVAL_MS, METRICS_INTERVAL_MAX_MS]).toEqual(
      [5_000, 60_000, 3_600_000],
    );
  });

  it("reads only an own property, so a polluted prototype is ignored", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.METRICS_INTERVAL_MS = "1";
    try {
      expect(metricsIntervalProblems({})).toEqual([]);
      expect(metricsIntervalMs({})).toBe(DEFAULT_METRICS_INTERVAL_MS);
    } finally {
      delete proto.METRICS_INTERVAL_MS;
    }
  });

  it("works on an env without a prototype or with odd own keys", () => {
    const bare: Record<string, string> = Object.create(null) as Record<string, string>;
    bare.METRICS_INTERVAL_MS = "30000";
    expect(metricsIntervalProblems(bare)).toEqual([]);
    expect(metricsIntervalMs(bare)).toBe(30_000);
    const odd = JSON.parse('{"__proto__":"1","toString":"1","METRICS_INTERVAL_MS":"7000"}') as Env;
    expect(metricsIntervalProblems(odd)).toEqual([]);
    expect(metricsIntervalMs(odd)).toBe(7_000);
  });

  it("reads process.env itself", () => {
    const before = process.env.METRICS_INTERVAL_MS;
    process.env.METRICS_INTERVAL_MS = "15000";
    try {
      expect(metricsIntervalProblems(process.env)).toEqual([]);
      expect(metricsIntervalMs(process.env)).toBe(15_000);
    } finally {
      if (before === undefined) delete process.env.METRICS_INTERVAL_MS;
      else process.env.METRICS_INTERVAL_MS = before;
    }
  });
});
