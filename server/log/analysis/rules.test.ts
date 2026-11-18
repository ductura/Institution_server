// DAN-1010-1a/1b/1c/1d (S-1K.7-a): log analysis, rules login_failures,
// traffic_refusals, session_rejections and authz_denials, on invented entries.
// Contracts Ductus#2028 c.6964677996 (1a), c.6967029458 (1b), c.6980590578 (1c)
// and c.6981110138 (1d).
// Time is only in the entries: no clock.
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
// trafficRefusals, sessionRejections and authzDenials have their own pairs, so
// a rule given another rule's threshold fails. Every threshold of the tests is
// built on TR.
const TR = {
  trafficRefusals: { windowMs: 30_000, minCount: 4 },
  sessionRejections: { windowMs: 20_000, minCount: 5 },
  authzDenials: { windowMs: 40_000, minCount: 6 },
};
const SMALL: AnalysisThresholds = { loginFailures: { windowMs: W, minCount: 3 }, ...TR };
const FAILED = "authn.login_failed";
const SECOND = "authn.second_factor_failed";
const COOKIE = "session.cookie_rejected";
const DENIED = "authz.denied";
const OPERATOR = "authz.operator_denied";
const ORIGIN = "authz.origin_rejected";
const THRESHOLD_KEYS = [
  "loginFailures",
  "trafficRefusals",
  "sessionRejections",
  "authzDenials",
] as const;
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
// Like counts, with the rule name of each finding.
const named = (entries: unknown, t?: unknown) => {
  const result = run(entries, t);
  return result.ok ? result.value.map((f) => [f.rule, f.fromMs - T0, f.count]) : result;
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
  const one = (windowMs: number) => ({ ...TR, loginFailures: { windowMs, minCount: 1 } });

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
  // Each refusal changes one key of the pair below, which itself is accepted.
  it("accepts the base pair of thresholds", () => {
    const all = [
      ...at(FAILED, 0, 1, 2),
      ...at("traffic.rate_limited", 0, 1, 2, 3),
      ...at(COOKIE, 0, 1, 2, 3, 4),
      ...at(DENIED, 0, 1, 2, 3, 4, 5),
    ];
    expect(named(all, SMALL)).toEqual([
      ["login_failures", 0, 3],
      ["traffic_refusals", 0, 4],
      ["session_rejections", 0, 5],
      ["authz_denials", 0, 6],
    ]);
  });

  it.each(bad.map((v) => [String(v), v]))("refuses windowMs and minCount %s", (_, v) => {
    for (const rule of THRESHOLD_KEYS) {
      for (const key of ["windowMs", "minCount"]) {
        const t = { ...SMALL, [rule]: { ...SMALL[rule], [key]: v } };
        expect(run(at(FAILED, 0, 1, 2), t), `${rule}.${key}`).toEqual(BAD_THRESHOLD);
      }
    }
  });

  it("refuses a window over 24 h, missing thresholds and a missing rule", () => {
    for (const t of [
      { ...TR, loginFailures: { windowMs: MAX_WINDOW_MS + 1, minCount: 1 } },
      { ...SMALL, trafficRefusals: { windowMs: MAX_WINDOW_MS + 1, minCount: 1 } },
      { ...SMALL, sessionRejections: { windowMs: MAX_WINDOW_MS + 1, minCount: 1 } },
      { ...SMALL, authzDenials: { windowMs: MAX_WINDOW_MS + 1, minCount: 1 } },
      { loginFailures: SMALL.loginFailures },
      { ...TR },
      without(SMALL, "trafficRefusals"),
      without(SMALL, "sessionRejections"),
      without(SMALL, "authzDenials"),
      null,
      7,
      {},
      [],
    ]) {
      expect(run(at(FAILED, 0, 1, 2), t)).toEqual(BAD_THRESHOLD);
    }
  });

  it("accepts a 24 h window, minCount 1, extra keys and undefined for the defaults", () => {
    const edge = { ...TR, loginFailures: { windowMs: MAX_WINDOW_MS, minCount: 1 }, other: 1 };
    expect(counts(at(FAILED, 0), edge)).toEqual([[0, 1]]);
    const trafficEdge = { ...SMALL, trafficRefusals: { windowMs: MAX_WINDOW_MS, minCount: 1 } };
    expect(named(at("traffic.ip_denied", 0), trafficEdge)).toEqual([["traffic_refusals", 0, 1]]);
    const sessionEdge = { ...SMALL, sessionRejections: { windowMs: MAX_WINDOW_MS, minCount: 1 } };
    expect(named(at(COOKIE, 0), sessionEdge)).toEqual([["session_rejections", 0, 1]]);
    const authzEdge = { ...SMALL, authzDenials: { windowMs: MAX_WINDOW_MS, minCount: 1 } };
    expect(named(at(ORIGIN, 0), authzEdge)).toEqual([["authz_denials", 0, 1]]);
    const twenty = Array.from({ length: 20 }, () => ({ timeMs: T0, event: FAILED }));
    expect(analyzeLog(twenty, undefined)).toEqual(analyzeLog(twenty));
    expect(analyzeLog(twenty, undefined)).toMatchObject({
      ok: true,
      value: [{ count: 20, minCount: 20 }],
    });
  });

  it.each(UNREADABLE)("refuses a threshold read site that is %s", (_, make) => {
    for (const key of THRESHOLD_KEYS) {
      const rule = SMALL[key];
      const cases = [
        make(SMALL, key, rule),
        { ...SMALL, [key]: make(rule, "windowMs", rule.windowMs) },
        { ...SMALL, [key]: make(rule, "minCount", rule.minCount) },
      ];
      for (const t of cases) expect(run(at(FAILED, 0, 1, 2), t), key).toEqual(BAD_THRESHOLD);
    }
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
    const one = { ...TR, loginFailures: { windowMs: 1, minCount: 1 } };
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
    const one = { ...TR, loginFailures: { windowMs: 1, minCount: 1 } };
    const result = run([{ timeMs: -0, event: FAILED }], one);
    expect(result.ok && Object.is(result.value[0]!.fromMs, 0)).toBe(true);
    // Times of different lengths: a string sort would put 10 and 100 before 9.
    const short = [100, 9, 10].map((timeMs) => ({ timeMs, event: FAILED }));
    expect(run(short, { ...TR, loginFailures: { windowMs: 2, minCount: 2 } })).toEqual({
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
    const one = { ...TR, loginFailures: { windowMs: 1, minCount: 1 } };
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
    const thresholds = THRESHOLD_KEYS.flatMap((key) => {
      const rule = SMALL[key];
      return [
        getter(without(SMALL, key), key),
        { ...SMALL, [key]: getter({ minCount: rule.minCount }, "windowMs") },
        { ...SMALL, [key]: getter({ windowMs: rule.windowMs }, "minCount") },
      ];
    });
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
    const traffic = counted("q", { windowMs: W, minCount: 1 });
    const session = counted("s", { windowMs: W, minCount: 1 });
    const authz = counted("a", { windowMs: W, minCount: 1 });
    const all = {
      loginFailures: rule,
      trafficRefusals: traffic,
      sessionRejections: session,
      authzDenials: authz,
    };
    run(counted("list", [entry]), counted("t", all));
    // In the contract's order: every threshold first, then the list, then each entry.
    expect(reads).toEqual([
      "t.loginFailures",
      "r.windowMs",
      "r.minCount",
      "t.trafficRefusals",
      "q.windowMs",
      "q.minCount",
      "t.sessionRejections",
      "s.windowMs",
      "s.minCount",
      "t.authzDenials",
      "a.windowMs",
      "a.minCount",
      "list.length",
      "list.0",
      "e.event",
      "e.timeMs",
    ]);

    // Codex review c.6966142677: with a bad threshold the list is never read.
    reads.length = 0;
    const bad = counted("r", { windowMs: 0, minCount: 1 });
    const fine = counted("q", { windowMs: W, minCount: 1 });
    const fineSession = counted("s", { windowMs: W, minCount: 1 });
    const fineAuthz = counted("a", { windowMs: W, minCount: 1 });
    const t = counted("t", {
      loginFailures: bad,
      trafficRefusals: fine,
      sessionRejections: fineSession,
      authzDenials: fineAuthz,
    });
    expect(run(counted("list", [entry]), t)).toEqual(BAD_THRESHOLD);
    // Every threshold is read before any is checked, and the list never is.
    expect(reads).toEqual([
      "t.loginFailures",
      "r.windowMs",
      "r.minCount",
      "t.trafficRefusals",
      "q.windowMs",
      "q.minCount",
      "t.sessionRejections",
      "s.windowMs",
      "s.minCount",
      "t.authzDenials",
      "a.windowMs",
      "a.minCount",
    ]);

    // Only one later threshold bad: the list is not read either.
    for (const key of ["trafficRefusals", "sessionRejections", "authzDenials"]) {
      reads.length = 0;
      const badOne = { ...SMALL, [key]: { windowMs: W, minCount: 0 } };
      expect(run(counted("list", [entry]), badOne), key).toEqual(BAD_THRESHOLD);
      expect(reads, key).toEqual([]);
    }
  });

  // Review #288 c.6966982604: the pass over windows is linear; with the sort
  // before it the whole analysis is O(n log n).
  it("analyses 400 000 entries in one window below the threshold in O(n log n)", () => {
    const entries = Array.from({ length: 400_000 }, (_, k) => ({
      timeMs: T0 + (k % 1000),
      event: FAILED,
    }));
    expect(
      run(entries, { ...TR, loginFailures: { windowMs: MAX_WINDOW_MS, minCount: 400_001 } }),
    ).toEqual({ ok: true, value: [] });
  }, 10_000);
});

// Name, threshold key, both events, the test pair (windowMs, minCount) from
// SMALL, an event of another rule and the events the rule never counts (every
// other rule's events and the near events of its own area), all written out.
// session_rejections counts one event, so its second event is the same one.
// The last item holds the expected [fromMs − T0, count] of each table row below,
// written out per rule (rows in the order of the table).
const RULES = [
  [
    "login_failures",
    "loginFailures",
    FAILED,
    SECOND,
    W,
    3,
    "traffic.ip_denied",
    [
      ...["traffic.rate_limited", "traffic.ip_denied", COOKIE, DENIED, OPERATOR, ORIGIN],
      ...["authn.login_started", "authn.login_succeeded", "authn.logout"],
    ],
    [
      [],
      [[0, 3]],
      [[0, 4]],
      [],
      [[59_999, 3]],
      [
        [0, 3],
        [60_000, 3],
      ],
      [[0, 4]],
      [[0, 3]],
      [[0, 3]],
      [],
      [[5, 3]],
    ],
  ],
  [
    "traffic_refusals",
    "trafficRefusals",
    "traffic.rate_limited",
    "traffic.ip_denied",
    30_000,
    4,
    FAILED,
    [FAILED, SECOND, COOKIE, DENIED, OPERATOR, ORIGIN, "traffic.request"],
    [
      [],
      [[0, 4]],
      [[0, 5]],
      [],
      [[29_999, 4]],
      [
        [0, 4],
        [30_000, 4],
      ],
      [[0, 5]],
      [[0, 4]],
      [[0, 4]],
      [],
      [[5, 4]],
    ],
  ],
  [
    "session_rejections",
    "sessionRejections",
    COOKIE,
    COOKIE,
    20_000,
    5,
    "traffic.rate_limited",
    [
      ...[FAILED, SECOND, "traffic.rate_limited", "traffic.ip_denied", DENIED, OPERATOR, ORIGIN],
      ...["session.created", "session.expired", "session.revoked", "authn.logout"],
    ],
    [
      [],
      [[0, 5]],
      [[0, 6]],
      [],
      [[19_999, 5]],
      [
        [0, 5],
        [20_000, 5],
      ],
      [[0, 6]],
      [[0, 5]],
      [[0, 5]],
      [],
      [[5, 5]],
    ],
  ],
  [
    "authz_denials",
    "authzDenials",
    DENIED,
    ORIGIN,
    40_000,
    6,
    COOKIE,
    [
      ...[FAILED, SECOND, "traffic.rate_limited", "traffic.ip_denied", COOKIE],
      ...["authn.logout", "session.revoked", "traffic.request", "admin.action"],
      "authn.second_factor_succeeded",
    ],
    [
      [],
      [[0, 6]],
      [[0, 7]],
      [],
      [[39_999, 6]],
      [
        [0, 6],
        [40_000, 6],
      ],
      [[0, 7]],
      [[0, 6]],
      [[0, 6]],
      [],
      [[5, 6]],
    ],
  ],
] as const;

describe("the rules of the contract", () => {
  it("has the names, keys and events of the contract, all in the catalog", () => {
    expect(ANALYSIS_RULES.map((r) => [r.name, r.key, [...r.events]])).toEqual([
      ["login_failures", "loginFailures", [FAILED, SECOND]],
      ["traffic_refusals", "trafficRefusals", ["traffic.rate_limited", "traffic.ip_denied"]],
      ["session_rejections", "sessionRejections", [COOKIE]],
      ["authz_denials", "authzDenials", [DENIED, OPERATOR, ORIGIN]],
    ]);
  });

  // Written by hand, not read from ANALYSIS_RULES: every counted event alone,
  // minCount times, gives a finding of its rule (authz.operator_denied is in no
  // column of the table below).
  it("finds each counted event alone at the threshold of its rule", () => {
    const counted = [
      ["login_failures", 3, [FAILED, SECOND]],
      ["traffic_refusals", 4, ["traffic.rate_limited", "traffic.ip_denied"]],
      ["session_rejections", 5, [COOKIE]],
      ["authz_denials", 6, [DENIED, OPERATOR, ORIGIN]],
    ] as const;
    for (const [name, m, events] of counted) {
      for (const event of events) {
        const entries = at(event, ...Array.from({ length: m }, (_, k) => k));
        expect(named(entries), event).toEqual([[name, 0, m]]);
        expect(named(entries.slice(1)), event).toEqual([]);
      }
    }
  });

  // A misspelt event would turn a case that must not count into a silent pass.
  it("uses only events of the catalog, counted or not", () => {
    for (const [, , e1, e2, , , other, ignored] of RULES) {
      for (const event of [e1, e2, other, ...ignored, "authn.logout", "traffic.request"]) {
        expect(Object.hasOwn(EVENT_CATALOG, event), event).toBe(true);
      }
    }
  });
});

describe.each(RULES)("rule %s", (name, _key, e1, e2, w, m, other, ignored, literal) => {
  // n entries one millisecond apart, starting at `from`.
  const run1 = (event: string, from: number, n: number) =>
    at(event, ...Array.from({ length: n }, (_, k) => from + k));

  const rows: [string, AnalysisEntry[]][] = [
    ["below the threshold", run1(e1, 0, m - 1)],
    ["exactly on the threshold", [...run1(e1, 0, m - 1), ...at(e1, w - 1)]],
    ["above the threshold", run1(e1, 0, m + 1)],
    ["an entry windowMs after the first is outside", [...run1(e1, 0, m - 1), ...at(e1, w)]],
    ["a later start finds what the first window misses", [...at(e1, 0), ...run1(e1, w - 1, m)]],
    ["two bursts windowMs apart", [...run1(e1, 0, m), ...run1(e1, w, m)]],
    ["a finding takes every entry in its window", [...run1(e1, 0, m), ...at(e1, w - 1, w)]],
    ["the second event alone", run1(e2, 0, m)],
    ["both events together", [...run1(e1, 0, m - 1), ...at(e2, m)]],
    [
      "events of the other rule, logout and traffic requests do not count",
      [
        ...run1(e1, 0, m - 1),
        ...at(other, 9),
        ...at("authn.logout", 9),
        ...at("traffic.request", 9),
      ],
    ],
    ["the same millisecond", at(e1, ...Array.from({ length: m }, () => 5))],
  ];

  // minCount of each: any one of them, if counted, would be a finding alone.
  // Other rules may find their own events here, so only this rule's findings count.
  it("counts no event outside its own, minCount of each", () => {
    const mine = (entries: AnalysisEntry[]) =>
      (named(entries) as unknown[][]).filter(([rule]) => rule === name);
    const others = ignored.flatMap((e) => run1(e, 0, m));
    expect(mine(others)).toEqual([]);
    expect(mine([...others].reverse())).toEqual([]);
    expect(mine([...run1(e1, 0, m - 1), ...others])).toEqual([]);
    // The control: with its own m events the same entries give one finding.
    expect(mine([...run1(e1, 0, m), ...others])).toEqual([[name, 0, m]]);
  });

  it("has a literal expectation for every row", () => {
    expect(literal).toHaveLength(rows.length);
  });

  it.each(rows.map(([label, entries], i) => [label, entries, literal[i]!] as const))(
    "%s",
    (_, entries, expected) => {
      const want = (expected as readonly (readonly number[])[]).map(([from, count]) => [
        name,
        from,
        count,
      ]);
      expect(named(entries)).toEqual(want);
      expect(named([...entries].reverse())).toEqual(want);
    },
  );

  it("has a name and key with no forbidden term", () => {
    for (const text of [name, name.replaceAll("_", " "), _key.replace(/([A-Z])/g, " $1")]) {
      expect(findForbiddenTerms(text), text).toEqual([]);
    }
  });
});

describe("log analysis: defaults and all rules at once", () => {
  const same = (event: string, n: number) =>
    Array.from({ length: n }, () => ({ timeMs: T0, event }));

  it("uses DEFAULT_ANALYSIS_THRESHOLDS without a second argument", () => {
    expect(DEFAULT_ANALYSIS_THRESHOLDS).toEqual({
      loginFailures: { windowMs: 600_000, minCount: 20 },
      trafficRefusals: { windowMs: 300_000, minCount: 50 },
      sessionRejections: { windowMs: 300_000, minCount: 100 },
      authzDenials: { windowMs: 600_000, minCount: 50 },
    });
    expect(analyzeLog(same(FAILED, 19))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(same(FAILED, 20))).toEqual({
      ok: true,
      value: [{ rule: "login_failures", fromMs: T0, toMs: T0 + 600_000, count: 20, minCount: 20 }],
    });
    expect(analyzeLog(same("traffic.ip_denied", 49))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(same("traffic.ip_denied", 50))).toEqual({
      ok: true,
      value: [
        { rule: "traffic_refusals", fromMs: T0, toMs: T0 + 300_000, count: 50, minCount: 50 },
      ],
    });
    expect(analyzeLog(same(COOKIE, 99))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(same(COOKIE, 100))).toEqual({
      ok: true,
      value: [
        { rule: "session_rejections", fromMs: T0, toMs: T0 + 300_000, count: 100, minCount: 100 },
      ],
    });
    expect(analyzeLog(same(OPERATOR, 49))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(same(OPERATOR, 50))).toEqual({
      ok: true,
      value: [{ rule: "authz_denials", fromMs: T0, toMs: T0 + 600_000, count: 50, minCount: 50 }],
    });
  });

  it("orders findings by rule first, then by time", () => {
    // The later rules' findings are earlier in time; rule order still holds.
    const entries = [
      ...at(DENIED, -9, -8, -7, -6, -5, -4),
      ...at(COOKIE, 0, 1, 2, 3, 4),
      ...at("traffic.ip_denied", 500, 501, 502, 503),
      ...at(FAILED, 1000, 1001, 1002),
    ];
    expect(named(entries)).toEqual([
      ["login_failures", 1000, 3],
      ["traffic_refusals", 500, 4],
      ["session_rejections", 0, 5],
      ["authz_denials", -9, 6],
    ]);
  });

  it("gives one finding per rule, in rule order, for mixed entries at the same millisecond", () => {
    const entries = [
      ...same(COOKIE, 50),
      ...same("traffic.rate_limited", 25),
      ...same(FAILED, 10),
      ...same(DENIED, 17),
      ...same(COOKIE, 50),
      ...same("traffic.ip_denied", 25),
      ...same(OPERATOR, 17),
      ...same(SECOND, 10),
      ...same(ORIGIN, 16),
    ];
    expect(analyzeLog(entries)).toEqual({
      ok: true,
      value: [
        { rule: "login_failures", fromMs: T0, toMs: T0 + 600_000, count: 20, minCount: 20 },
        { rule: "traffic_refusals", fromMs: T0, toMs: T0 + 300_000, count: 50, minCount: 50 },
        { rule: "session_rejections", fromMs: T0, toMs: T0 + 300_000, count: 100, minCount: 100 },
        // 17 + 17 + 16 of the three authz events make one finding of 50.
        { rule: "authz_denials", fromMs: T0, toMs: T0 + 600_000, count: 50, minCount: 50 },
      ],
    });
  });
});

describe("log analysis: output and text", () => {
  it("gives frozen results and findings with the closed keys only, about no person", () => {
    const ok = run([
      ...at(FAILED, 0, 1, 2),
      ...at("traffic.rate_limited", 0, 1, 2, 3),
      ...at(COOKIE, 0, 1, 2, 3, 4),
      ...at(OPERATOR, 0, 1, 2, 3, 4, 5),
    ]);
    expect(ok).toEqual({
      ok: true,
      value: [
        found(0, 3),
        { rule: "traffic_refusals", fromMs: T0, toMs: T0 + 30_000, count: 4, minCount: 4 },
        { rule: "session_rejections", fromMs: T0, toMs: T0 + 20_000, count: 5, minCount: 5 },
        { rule: "authz_denials", fromMs: T0, toMs: T0 + 40_000, count: 6, minCount: 6 },
      ],
    });
    const bad = run([], null);
    const findings = ok.ok ? ok.value : [];
    for (const value of [ok, findings, ...findings, bad, !bad.ok && bad.error]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(["count", "fromMs", "minCount", "rule", "toMs"]);
    }
  });

  it("has a Croatian text for every code, no other key and no forbidden term", () => {
    const texts = (
      JSON.parse(readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8")) as {
        logAnalysis: Record<string, string>;
      }
    ).logAnalysis;
    expect(Object.keys(texts)).toEqual(ANALYSIS_ERROR_CODES.map((c) => c.toLowerCase()));
    for (const text of Object.values(texts)) {
      expect(text.length).toBeGreaterThan(0);
      expect(findForbiddenTerms(text), text).toEqual([]);
    }
  });
});
