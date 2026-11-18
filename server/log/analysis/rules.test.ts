// DAN-1010-1a (S-1K.7-a): log analysis, rule login_failures, on invented entries.
// Contract Ductus#2028 c.6964677996. Time is only in the entries: no clock.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { findForbiddenTerms } from "../../../scripts/forbidden-terms/index.ts";
import { EVENT_CATALOG } from "../events/index.ts";
import {
  ANALYSIS_ERROR_CODES,
  ANALYSIS_RULES,
  analyzeLog,
  DEFAULT_ANALYSIS_THRESHOLDS,
  MAX_ENTRIES,
  MAX_TIME_MS,
  MAX_WINDOW_MS,
  type AnalysisEntry,
  type AnalysisThresholds,
} from "./index.ts";

const T0 = Date.UTC(2026, 10, 18, 9, 0);
const W = 60_000;
const SMALL: AnalysisThresholds = { loginFailures: { windowMs: W, minCount: 3 } };
const FAILED = "authn.login_failed";
const SECOND = "authn.second_factor_failed";
const refused = (code: string) => ({
  ok: false,
  error: { code, messageKey: `logAnalysis.${code.toLowerCase()}` },
});
const BAD_THRESHOLD = refused("ANALYSIS_THRESHOLD_INVALID");
const BAD_ENTRIES = refused("ANALYSIS_ENTRIES_INVALID");

const at = (event: string, ...offsets: number[]): AnalysisEntry[] =>
  offsets.map((ms) => ({ timeMs: T0 + ms, event }));
const run = (entries: unknown, t: unknown = SMALL) =>
  analyzeLog(entries as AnalysisEntry[], t as AnalysisThresholds);
const found = (from: number, count: number, t = SMALL.loginFailures) => ({
  rule: "login_failures",
  fromMs: T0 + from,
  toMs: T0 + from + t.windowMs,
  count,
  minCount: t.minCount,
});
const counts = (entries: unknown, t?: unknown) => {
  const result = run(entries, t);
  return result.ok ? result.value.map((f) => [f.fromMs - T0, f.count]) : result;
};

const without = (holder: object, key: string) => {
  const rest: Record<string, unknown> = { ...holder };
  delete rest[key];
  return rest;
};

// Every way a value can be unreadable: the analysis treats each one as missing.
const revoked = () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};
const trap = <T extends object>(target: T): T =>
  new Proxy(target, {
    getOwnPropertyDescriptor: () => {
      throw new Error("kanarinac");
    },
  });
const UNREADABLE: [string, (holder: object, key: string, value: unknown) => object][] = [
  ["a getter", (h, k, v) => Object.defineProperty({ ...h }, k, { get: () => v, enumerable: true })],
  [
    "a getter that throws",
    (h, k) =>
      Object.defineProperty({ ...h }, k, {
        get: () => {
          throw new Error("kanarinac");
        },
      }),
  ],
  ["inherited", (h, k, v) => Object.assign(Object.create({ [k]: v }) as object, without(h, k))],
  ["a revoked Proxy", () => revoked()],
  ["a throwing trap", (h) => trap({ ...h })],
  ["a revoked Proxy as the value", (h, k) => ({ ...h, [k]: revoked() })],
  ["a function holding the same keys", (h) => Object.assign(() => undefined, h)],
];

// Codex review c.6966404366: the bounds of the contract written out as numbers,
// not read from the constants the code uses, so changing a constant fails here.
describe("log analysis: the contract's fixed bounds", () => {
  const DAY_MS = 86_400_000;
  const DATE_LIMIT_MS = 8_640_000_000_000_000;
  const one = (windowMs: number) => ({ loginFailures: { windowMs, minCount: 1 } });

  it("has the bounds of the contract", () => {
    expect([MAX_WINDOW_MS, MAX_TIME_MS, MAX_ENTRIES]).toEqual([DAY_MS, DATE_LIMIT_MS, 1_000_000]);
  });

  it("accepts a window of 24 h and refuses one millisecond more", () => {
    expect(run(at(FAILED, 0), one(DAY_MS))).toMatchObject({ ok: true });
    expect(run(at(FAILED, 0), one(DAY_MS + 1))).toEqual(BAD_THRESHOLD);
  });

  it("counts times up to the Date limit and skips one millisecond past it", () => {
    for (const t of [DATE_LIMIT_MS, -DATE_LIMIT_MS]) {
      expect(run([{ timeMs: t, event: FAILED }], one(1))).toEqual({
        ok: true,
        value: [{ rule: "login_failures", fromMs: t, toMs: t + 1, count: 1, minCount: 1 }],
      });
    }
    for (const t of [DATE_LIMIT_MS + 1, -DATE_LIMIT_MS - 1]) {
      expect(run([{ timeMs: t, event: FAILED }], one(1)), String(t)).toEqual({
        ok: true,
        value: [],
      });
    }
  });
});

describe("log analysis: thresholds that are refused", () => {
  const bad: unknown[] = [0, -0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  bad.push("3", " 3\r\n", null, undefined, 3n, new Number(3), { valueOf: () => 3 });
  it.each(bad.map((v) => [String(v), v]))("refuses windowMs and minCount %s", (_, v) => {
    for (const key of ["windowMs", "minCount"]) {
      expect(
        run(at(FAILED, 0, 1, 2), { loginFailures: { ...SMALL.loginFailures, [key]: v } }),
      ).toEqual(BAD_THRESHOLD);
    }
  });

  it("refuses a window over 24 h, missing thresholds and a missing rule", () => {
    for (const t of [
      { loginFailures: { windowMs: MAX_WINDOW_MS + 1, minCount: 1 } },
      null,
      7,
      {},
      [],
    ]) {
      expect(run(at(FAILED, 0, 1, 2), t)).toEqual(BAD_THRESHOLD);
    }
  });

  it("accepts a 24 h window, minCount 1, extra keys and undefined for the defaults", () => {
    const edge = { loginFailures: { windowMs: MAX_WINDOW_MS, minCount: 1 }, other: 1 };
    expect(counts(at(FAILED, 0), edge)).toEqual([[0, 1]]);
    const twenty = Array.from({ length: 20 }, () => ({ timeMs: T0, event: FAILED }));
    expect(analyzeLog(twenty, undefined)).toEqual(analyzeLog(twenty));
    expect(analyzeLog(twenty, undefined)).toMatchObject({
      ok: true,
      value: [{ count: 20, minCount: 20 }],
    });
  });

  it.each(UNREADABLE)("refuses a threshold read site that is %s", (_, make) => {
    const rule = SMALL.loginFailures;
    const cases = [
      make(SMALL, "loginFailures", rule),
      { loginFailures: make(rule, "windowMs", rule.windowMs) },
      { loginFailures: make(rule, "minCount", rule.minCount) },
    ];
    for (const t of cases) expect(run(at(FAILED, 0, 1, 2), t)).toEqual(BAD_THRESHOLD);
  });

  it("reports the threshold error first when the entries are bad too", () => {
    for (const list of [null, revoked(), trap([])]) {
      expect(run(list, null)).toEqual(BAD_THRESHOLD);
    }
  });
});

describe("log analysis: entries that are skipped or refused", () => {
  const three = at(FAILED, 0, 1, 2);

  it.each(UNREADABLE)("skips an entry whose event or timeMs is %s", (_, make) => {
    for (const key of ["event", "timeMs"] as const) {
      const odd = make(three[2]!, key, three[2]![key]);
      expect(counts([three[0], three[1], odd]), key).toEqual([]);
      expect(counts([...three, odd]), key).toEqual([[0, 3]]);
    }
  });

  it("skips a list index that is a getter, a throwing getter or behind a throwing trap", () => {
    const getter = Object.defineProperty([three[0], three[1]], 2, { get: () => three[2] });
    const throwing = Object.defineProperty([three[0], three[1]], 2, {
      get: () => {
        throw new Error("kanarinac");
      },
    });
    const trapped = new Proxy([...three], {
      getOwnPropertyDescriptor: (t, k) => {
        if (k === "2") throw new Error("kanarinac");
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    for (const list of [getter, throwing, trapped]) expect(counts(list)).toEqual([]);
    expect(counts(three)).toEqual([[0, 3]]);
  });

  it("skips holes, also with a polluted Array.prototype", () => {
    const holed: unknown[] = [];
    holed[0] = three[0];
    holed[2] = three[1];
    expect(counts(holed)).toEqual([]);
    // The polluted prototype is in place only for the call, so no other code sees it.
    let result: unknown;
    try {
      Object.defineProperty(Array.prototype, 1, {
        value: three[2],
        configurable: true,
        writable: true,
      });
      result = run(holed);
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[1];
    }
    expect(result).toEqual({ ok: true, value: [] });
  });

  // Codex review c.6965183659 (1): the analysis writes its own lists without
  // going through Array.prototype, so read-only indexes there change nothing.
  // Codex review c.6965474040 (1): an accessor stays unreadable even when
  // Object.prototype carries a `value` that a descriptor would inherit.
  // Codex review c.6965854147: every field a property descriptor can carry,
  // inherited from Object.prototype at once; the analysis must still give the
  // right findings and never throw.
  it("gives the right findings with descriptor fields on Object.prototype", () => {
    const fields = {
      get: () => FAILED,
      set: () => undefined,
      value: FAILED,
      writable: false,
      enumerable: false,
      configurable: false,
    };
    let result: unknown;
    try {
      for (const [key, value] of Object.entries(fields)) {
        // A prototype-free descriptor, so the fields already set do not leak into it.
        const descriptor = Object.create(null) as PropertyDescriptor;
        descriptor.value = value;
        descriptor.configurable = true;
        descriptor.writable = true;
        Object.defineProperty(Object.prototype, key, descriptor);
      }
      result = run(at(FAILED, 0, 1, 2, W, W + 1, W + 2));
    } finally {
      for (const key of Object.keys(fields))
        delete (Object.prototype as Record<string, unknown>)[key];
    }
    expect(result).toEqual({ ok: true, value: [found(0, 3), found(W, 3)] });
  });

  it("skips a getter entry field when Object.prototype has a value", () => {
    for (const [key, polluted] of [
      ["event", FAILED],
      ["timeMs", T0 + 2],
    ] as const) {
      const odd = Object.defineProperty({ ...three[2]! }, key, {
        get: () => polluted,
        enumerable: true,
      });
      let result: unknown;
      try {
        Object.defineProperty(Object.prototype, "value", {
          value: polluted,
          configurable: true,
          writable: true,
        });
        result = run([three[0], three[1], odd]);
      } finally {
        delete (Object.prototype as Record<string, unknown>).value;
      }
      expect(result, key).toEqual({ ok: true, value: [] });
    }
  });

  it("ignores read-only indexes on Array.prototype", () => {
    const entries = at(FAILED, 0, 1, 2, W, W + 1, W + 2);
    let result: unknown;
    try {
      for (let k = 0; k < 8; k += 1) {
        Object.defineProperty(Array.prototype, k, { value: three[0], configurable: true });
      }
      result = run(entries);
    } finally {
      for (let k = 0; k < 8; k += 1)
        delete (Array.prototype as unknown as Record<number, unknown>)[k];
    }
    expect(result).toEqual({ ok: true, value: [found(0, 3), found(W, 3)] });
  });

  it("skips bad times and events, and counts times up to the Date limit", () => {
    const odd: unknown[] = [null, 7, FAILED, Object.create(three[0]!) as object];
    for (const t of [
      Number.NaN,
      Infinity,
      -Infinity,
      String(T0),
      T0 + 0.5,
      MAX_TIME_MS + 1,
      -MAX_TIME_MS - 1,
      2 ** 53,
    ]) {
      odd.push({ timeMs: t, event: FAILED });
    }
    for (const e of [
      ` ${FAILED}`,
      `${FAILED}\r\n`,
      `${FAILED}\t`,
      `${FAILED} `,
      `${FAILED}\u007f`,
    ]) {
      odd.push({ timeMs: T0, event: e });
    }
    for (const e of [FAILED.toUpperCase(), "__proto__", "toString", new String(FAILED), 1])
      odd.push({ timeMs: T0, event: e });
    expect(counts([...odd, three[0], three[1]])).toEqual([]);
    const one = { loginFailures: { windowMs: 1, minCount: 1 } };
    for (const t of [MAX_TIME_MS, -MAX_TIME_MS]) {
      expect(run([{ timeMs: t, event: FAILED }], one)).toEqual({
        ok: true,
        value: [{ rule: "login_failures", fromMs: t, toMs: t + 1, count: 1, minCount: 1 }],
      });
    }
    // Alone, with minCount 1: each of these would be a finding if it were counted.
    for (const t of [MAX_TIME_MS + 1, -MAX_TIME_MS - 1, 2 ** 53, -(2 ** 53), T0 + 0.5]) {
      expect(run([{ timeMs: t, event: FAILED }], one), String(t)).toEqual({ ok: true, value: [] });
    }
  });

  it("turns -0 into 0 and sorts times as numbers", () => {
    const one = { loginFailures: { windowMs: 1, minCount: 1 } };
    const result = run([{ timeMs: -0, event: FAILED }], one);
    expect(result.ok && Object.is(result.value[0]!.fromMs, 0)).toBe(true);
    // Times of different lengths: a string sort would put 10 and 100 before 9.
    const short = [100, 9, 10].map((timeMs) => ({ timeMs, event: FAILED }));
    expect(run(short, { loginFailures: { windowMs: 2, minCount: 2 } })).toEqual({
      ok: true,
      value: [{ rule: "login_failures", fromMs: 9, toMs: 11, count: 2, minCount: 2 }],
    });
  });

  it("refuses a list that is no array, throws, or is longer than MAX_ENTRIES", () => {
    const { proxy, revoke } = Proxy.revocable([...three], {});
    revoke();
    const long = new Proxy([], {
      getOwnPropertyDescriptor: (t, k) =>
        k === "length"
          ? { value: MAX_ENTRIES + 1, writable: true }
          : Reflect.getOwnPropertyDescriptor(t, k),
    });
    // Codex review c.6965183659 (2): a length that is no count of entries.
    const lengths = [-1, -MAX_ENTRIES, 1.5, Number.NaN, Infinity, "3", null, 2 ** 53];
    const lying = lengths.map(
      (value) =>
        new Proxy([...three], {
          getOwnPropertyDescriptor: (t, k) =>
            k === "length" ? { value, writable: true } : Reflect.getOwnPropertyDescriptor(t, k),
        }),
    );
    for (const list of [
      null,
      undefined,
      {},
      "entries",
      { length: 3, 0: three[0] },
      proxy,
      trap([...three]),
      long,
      ...lying,
    ]) {
      expect(run(list)).toEqual(BAD_ENTRIES);
    }
    // Codex review c.6965474040 (2): at exactly MAX_ENTRIES the last index is
    // still read, and a valid entry there changes the result; one more is refused.
    const lastOnly = (length: number) =>
      new Proxy([], {
        getOwnPropertyDescriptor: (t, k) => {
          if (k === "length") return { value: length, writable: true };
          if (k === String(length - 1)) {
            return {
              value: { timeMs: T0, event: FAILED },
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
    const one = { loginFailures: { windowMs: 1, minCount: 1 } };
    expect(run(lastOnly(MAX_ENTRIES), one)).toEqual({
      ok: true,
      value: [found(0, 1, one.loginFailures)],
    });
    expect(run(lastOnly(MAX_ENTRIES + 1), one)).toEqual(BAD_ENTRIES);
  });

  // Codex review c.6966691133: a getter is never called, at any read site; a
  // getter that counts and then throws must leave the count at zero.
  it("never calls a getter, at any read site", () => {
    let calls = 0;
    const getter = <T extends object>(target: T, key: string): T =>
      Object.defineProperty(target, key, {
        get: () => {
          calls += 1;
          throw new Error("kanarinac");
        },
        enumerable: true,
      });
    const valid = { timeMs: T0, event: FAILED };
    const lists = [
      getter([valid, valid, valid], "2"),
      [valid, valid, getter({ timeMs: T0 }, "event")],
      [valid, valid, getter({ event: FAILED }, "timeMs")],
    ];
    for (const list of lists) expect(run(list)).toEqual({ ok: true, value: [] });
    const rule = SMALL.loginFailures;
    const thresholds = [
      getter({}, "loginFailures"),
      { loginFailures: getter({ minCount: rule.minCount }, "windowMs") },
      { loginFailures: getter({ windowMs: rule.windowMs }, "minCount") },
    ];
    for (const t of thresholds) expect(run(at(FAILED, 0, 1, 2), t)).toEqual(BAD_THRESHOLD);
    expect(calls).toBe(0);
  });

  it("reads each key of the list, an entry and the thresholds exactly once", () => {
    const reads: string[] = [];
    const counted = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        getOwnPropertyDescriptor: (t, k) => {
          reads.push(`${name}.${String(k)}`);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        // Any other kind of read is a read too, and must not happen.
        get: (t, k, r) => (reads.push(`${name}.get ${String(k)}`), Reflect.get(t, k, r)),
        has: (t, k) => (reads.push(`${name}.has ${String(k)}`), Reflect.has(t, k)),
        ownKeys: (t) => (reads.push(`${name}.ownKeys`), Reflect.ownKeys(t)),
      });
    const entry = counted("e", { timeMs: T0, event: FAILED });
    const rule = counted("r", { windowMs: W, minCount: 1 });
    run(counted("list", [entry]), counted("t", { loginFailures: rule }));
    // In the contract's order: thresholds first, then the list, then each entry.
    expect(reads).toEqual([
      "t.loginFailures",
      "r.windowMs",
      "r.minCount",
      "list.length",
      "list.0",
      "e.event",
      "e.timeMs",
    ]);

    // Codex review c.6966142677: with a bad threshold the list is never read.
    reads.length = 0;
    const bad = counted("r", { windowMs: 0, minCount: 1 });
    expect(run(counted("list", [entry]), counted("t", { loginFailures: bad }))).toEqual(
      BAD_THRESHOLD,
    );
    expect(reads.filter((r) => !r.startsWith("t.") && !r.startsWith("r."))).toEqual([]);
  });

  it("analyses 400 000 entries in one window below the threshold in linear time", () => {
    const entries = Array.from({ length: 400_000 }, (_, k) => ({
      timeMs: T0 + (k % 1000),
      event: FAILED,
    }));
    expect(run(entries, { loginFailures: { windowMs: MAX_WINDOW_MS, minCount: 400_001 } })).toEqual(
      { ok: true, value: [] },
    );
  }, 10_000);
});

describe("rule login_failures", () => {
  it("has the name, key and events of the contract, all in the catalog", () => {
    expect(ANALYSIS_RULES.map((r) => [r.name, r.key, [...r.events]])).toEqual([
      ["login_failures", "loginFailures", [FAILED, SECOND]],
    ]);
    for (const event of [FAILED, SECOND]) expect(Object.hasOwn(EVENT_CATALOG, event)).toBe(true);
  });

  it.each([
    ["below the threshold", at(FAILED, 0, 1), []],
    ["exactly on the threshold", at(FAILED, 0, 1, W - 1), [[0, 3]]],
    ["above the threshold", at(FAILED, 0, 1, 2, 3), [[0, 4]]],
    ["an entry windowMs after the first is outside", at(FAILED, 0, 1, W), []],
    [
      "a later start finds what the first window misses",
      at(FAILED, 0, W - 1, W, W + 1),
      [[W - 1, 3]],
    ],
    [
      "two bursts windowMs apart",
      at(FAILED, 0, 1, 2, W, W + 1, W + 2),
      [
        [0, 3],
        [W, 3],
      ],
    ],
    ["a finding takes every entry in its window", at(FAILED, 0, 1, 2, W - 1, W, W + 1), [[0, 4]]],
    ["the second event alone", at(SECOND, 0, 1, 2), [[0, 3]]],
    ["both events together", [...at(FAILED, 0, 1), ...at(SECOND, 2)], [[0, 3]]],
    [
      "other events do not count",
      [...at(FAILED, 0, 1), ...at("authn.logout", 2), ...at("traffic.ip_denied", 2)],
      [],
    ],
    ["the same millisecond", at(FAILED, 5, 5, 5), [[5, 3]]],
  ])("%s", (_, entries, expected) => {
    expect(counts(entries)).toEqual(expected);
    expect(counts([...entries].reverse())).toEqual(expected);
  });

  it("uses DEFAULT_ANALYSIS_THRESHOLDS without a second argument", () => {
    expect(DEFAULT_ANALYSIS_THRESHOLDS).toEqual({
      loginFailures: { windowMs: 600_000, minCount: 20 },
    });
    const n = (k: number) => Array.from({ length: k }, () => ({ timeMs: T0, event: FAILED }));
    expect(analyzeLog(n(19))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(n(20))).toEqual({
      ok: true,
      value: [found(0, 20, DEFAULT_ANALYSIS_THRESHOLDS.loginFailures)],
    });
  });
});

describe("log analysis: output and text", () => {
  it("gives frozen results and findings with the closed keys only, about no person", () => {
    const ok = run(at(FAILED, 0, 1, 2));
    expect(ok).toEqual({ ok: true, value: [found(0, 3)] });
    const bad = run([], null);
    for (const value of [ok, ok.ok && ok.value, ok.ok && ok.value[0], bad, !bad.ok && bad.error]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.keys(ok.ok ? ok.value[0]! : {}).sort()).toEqual([
      "count",
      "fromMs",
      "minCount",
      "rule",
      "toMs",
    ]);
  });

  it("has a Croatian text for every code, no other key and no forbidden term", () => {
    const texts = (
      JSON.parse(readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8")) as {
        logAnalysis: Record<string, string>;
      }
    ).logAnalysis;
    expect(Object.keys(texts)).toEqual(ANALYSIS_ERROR_CODES.map((c) => c.toLowerCase()));
    for (const text of [...Object.values(texts), "login failures", "login Failures"]) {
      expect(text.length).toBeGreaterThan(0);
      expect(findForbiddenTerms(text), text).toEqual([]);
    }
  });
});
