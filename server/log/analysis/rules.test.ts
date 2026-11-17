// DAN-1010-1 (S-1K.7-a): log analysis rules on invented entries. Contract
// Ductus#2028 c.6962315424. Time is only in the entries, so no clock is needed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { findForbiddenTerms } from "../../../scripts/forbidden-terms/index.ts";
import { EVENT_CATALOG } from "../events/index.ts";
import {
  ANALYSIS_ERROR_CODES,
  ANALYSIS_RULES,
  analyzeLog,
  DEFAULT_ANALYSIS_THRESHOLDS,
  MAX_TIME_MS,
  MAX_WINDOW_MS,
  type AnalysisEntry,
  type AnalysisThresholds,
  type RuleThreshold,
} from "./rules.ts";

const T0 = Date.UTC(2026, 10, 17, 9, 0);
const WINDOW = 60_000;
const MIN = 3;
const SMALL = { loginFailures: { windowMs: WINDOW, minCount: MIN } };
const thresholds = { ...DEFAULT_ANALYSIS_THRESHOLDS, ...SMALL };
const failure = {
  ok: false,
  error: {
    code: "ANALYSIS_THRESHOLD_INVALID",
    messageKey: "logAnalysis.analysis_threshold_invalid",
  },
};

const at = (event: string, ...offsets: number[]): AnalysisEntry[] =>
  offsets.map((ms) => ({ timeMs: T0 + ms, event }));
const findings = (entries: unknown[], t: AnalysisThresholds = thresholds) => {
  const result = analyzeLog(entries as AnalysisEntry[], t);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe("log analysis: thresholds that are refused", () => {
  const bad: unknown[] = [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    "3",
    " 3\r\n",
    null,
    undefined,
    3n,
    { valueOf: () => 3 },
  ];
  it.each(bad.map((v) => [String(v), v]))("refuses windowMs and minCount %s", (_, value) => {
    for (const key of ["windowMs", "minCount"]) {
      const rule = { ...SMALL.loginFailures, [key]: value };
      expect(analyzeLog([], { ...thresholds, loginFailures: rule } as AnalysisThresholds)).toEqual(
        failure,
      );
    }
  });

  it("refuses a window above 24 h, a missing rule and an inherited one", () => {
    const over = { ...thresholds, loginFailures: { windowMs: MAX_WINDOW_MS + 1, minCount: MIN } };
    const missing: { -readonly [K in keyof AnalysisThresholds]?: RuleThreshold } = {
      ...thresholds,
    };
    delete missing.loginFailures;
    const inherited = Object.assign(
      Object.create({ loginFailures: SMALL.loginFailures }) as object,
      missing,
    );
    for (const t of [over, missing, inherited, null, [], Object.create(thresholds) as object]) {
      expect(analyzeLog([], t as AnalysisThresholds)).toEqual(failure);
    }
  });

  // Codex review c.6963971482 (2): each field of a rule threshold must be an own data property.
  it("refuses a windowMs or minCount that is inherited or a getter", () => {
    for (const key of ["windowMs", "minCount"] as const) {
      const { [key]: value, ...restOfRule } = SMALL.loginFailures;
      const inherited = Object.assign(Object.create({ [key]: value }) as object, restOfRule);
      const getter = Object.defineProperty({ ...restOfRule }, key, {
        get: () => value,
        enumerable: true,
      });
      for (const rule of [inherited, getter]) {
        expect(
          analyzeLog([], { ...thresholds, loginFailures: rule } as AnalysisThresholds),
          key,
        ).toEqual(failure);
      }
    }
  });

  it("has a Croatian text for every code and no other key", () => {
    const texts = JSON.parse(
      readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
    ) as {
      logAnalysis: Record<string, string>;
    };
    expect(Object.keys(texts.logAnalysis)).toEqual(
      ANALYSIS_ERROR_CODES.map((c) => c.toLowerCase()),
    );
    for (const text of Object.values(texts.logAnalysis)) {
      expect(text.length).toBeGreaterThan(0);
      expect(findForbiddenTerms(text)).toEqual([]);
    }
  });
});

describe("log analysis: entry times", () => {
  // Codex review c.6963024962 (1): above 2 ** 53 the window end rounds onto its start.
  const one = { ...thresholds, loginFailures: { windowMs: 1, minCount: 1 } };
  const single = (timeMs: number) => findings([{ timeMs, event: "authn.login_failed" }], one);

  it("counts integer times up to the Date limit in both directions", () => {
    for (const timeMs of [MAX_TIME_MS, -MAX_TIME_MS, 0]) {
      expect(single(timeMs)).toEqual([
        { rule: "login_failures", fromMs: timeMs, toMs: timeMs + 1, count: 1, minCount: 1 },
      ]);
    }
  });

  it("skips times past the Date limit or with a fraction", () => {
    for (const timeMs of [
      MAX_TIME_MS + 1,
      -MAX_TIME_MS - 1,
      2 ** 53,
      -(2 ** 53),
      Number.MAX_VALUE,
      T0 + 0.5,
      -0,
    ]) {
      expect(single(timeMs), String(timeMs)).toEqual(Object.is(timeMs, -0) ? single(0) : []);
    }
  });
});

// Codex review c.6964260032: every value the analysis reads must be an own data
// property. One table covers each read site (entry event and time, the rule key in
// the thresholds, windowMs, minCount) with a getter and with an inherited value;
// in each row the rest of the input is valid and would otherwise give a finding.
describe("log analysis: only own data properties are read", () => {
  const getterOf = (base: object, key: string, value: unknown): object =>
    Object.defineProperty({ ...base }, key, { get: () => value, enumerable: true });
  const inheritedOf = (base: object, key: string, value: unknown): object => {
    const rest: Record<string, unknown> = { ...base };
    delete rest[key];
    return Object.assign(Object.create({ [key]: value }) as object, rest);
  };
  const ways = [
    ["a getter", getterOf],
    ["inherited", inheritedOf],
  ] as const;
  const valid = at("authn.login_failed", 0, 1, 2);

  it.each(ways)("skips an entry whose event or timeMs is %s", (_, make) => {
    expect(findings(valid)).toHaveLength(1);
    for (const key of ["event", "timeMs"] as const) {
      const odd = make(valid[2]!, key, valid[2]![key]);
      expect(findings([valid[0], valid[1], odd]), key).toEqual([]);
    }
  });

  it.each(ways)("refuses thresholds whose rule key, windowMs or minCount is %s", (_, make) => {
    for (const ruleKey of ["loginFailures", "trafficRefusals"] as const) {
      const rule = thresholds[ruleKey];
      const cases = [
        make(thresholds, ruleKey, rule),
        { ...thresholds, [ruleKey]: make(rule, "windowMs", rule.windowMs) },
        { ...thresholds, [ruleKey]: make(rule, "minCount", rule.minCount) },
      ];
      for (const t of cases) {
        expect(analyzeLog(valid, t as AnalysisThresholds), ruleKey).toEqual(failure);
      }
    }
  });
});

describe("log analysis: entries that are not counted", () => {
  it("skips entries without a finite time or a string event, and inherited names", () => {
    const getter = Object.defineProperty({ timeMs: T0 }, "event", {
      get: () => "authn.login_failed",
      enumerable: true,
    });
    const odd: unknown[] = [
      null,
      7,
      "authn.login_failed",
      getter,
      Object.create(at("authn.login_failed", 0)[0]!) as object,
    ];
    for (const timeMs of [Number.NaN, Infinity, -Infinity, String(T0), null])
      odd.push({ timeMs, event: "authn.login_failed" });
    for (const event of [
      "__proto__",
      "toString",
      "constructor",
      " authn.login_failed",
      "authn.login_failed\r\n",
      "AUTHN.LOGIN_FAILED",
      "authn.login_failed\t",
      "authn.login_failed\u00a0",
      "authn.login_failed\u007f",
      1,
    ]) {
      odd.push(...[0, 1, 2].map((ms) => ({ timeMs: T0 + ms, event })));
    }
    expect(findings([...odd, ...at("authn.login_failed", 0, 1)])).toEqual([]);
  });
});

describe("log analysis: work grows linearly with the entries", () => {
  // Codex ductura/server#280 r4606571759: a dense batch below the threshold
  // must not rescan the rest of the window for every entry.
  it("analyses 200 000 entries in one window below the threshold", () => {
    const n = 200_000;
    const entries = Array.from({ length: n }, (_, k) => ({
      timeMs: T0 + (k % 1000),
      event: "authn.login_failed",
    }));
    const big = { ...thresholds, loginFailures: { windowMs: MAX_WINDOW_MS, minCount: n + 1 } };
    expect(findings(entries, big)).toEqual([]);
  }, 2000);
});

// Written out here, not read from the implementation: dropping an event from a rule must fail a test.
// Rule name of the contract (Ductus#2028 c.6962315424), threshold key, events.
const RULE_EVENTS: [string, string, string[]][] = [
  ["login_failures", "loginFailures", ["authn.login_failed", "authn.second_factor_failed"]],
  ["traffic_refusals", "trafficRefusals", ["traffic.rate_limited", "traffic.ip_denied"]],
];

describe("log analysis: rules and defaults", () => {
  it("has exactly the rules and events of the contract", () => {
    expect(ANALYSIS_RULES.map((r) => [r.name, r.key, [...r.events]])).toEqual(RULE_EVENTS);
  });

  // Codex review c.6963352885 (2): a call with entries only uses the named defaults.
  it("uses DEFAULT_ANALYSIS_THRESHOLDS when no thresholds are passed", () => {
    expect(DEFAULT_ANALYSIS_THRESHOLDS).toEqual({
      loginFailures: { windowMs: 600_000, minCount: 20 },
      trafficRefusals: { windowMs: 300_000, minCount: 50 },
    });
    const run = (n: number) =>
      Array.from({ length: n }, (_, k) => ({ timeMs: T0 + k, event: "authn.login_failed" }));
    expect(analyzeLog(run(19))).toEqual({ ok: true, value: [] });
    expect(analyzeLog(run(20))).toEqual({
      ok: true,
      value: [{ rule: "login_failures", fromMs: T0, toMs: T0 + 600_000, count: 20, minCount: 20 }],
    });
  });
});

describe("log analysis: both rules in one call", () => {
  // Codex review c.6963686634: entries at the same millisecond all count, for every rule at once.
  it("counts every entry at the same millisecond and gives one finding per rule", () => {
    const same = (event: string, n: number) =>
      Array.from({ length: n }, () => ({ timeMs: T0, event }));
    const entries = [
      ...same("traffic.rate_limited", 25),
      ...same("authn.login_failed", 10),
      ...same("traffic.ip_denied", 25),
      ...same("authn.second_factor_failed", 10),
    ];
    expect(analyzeLog(entries)).toEqual({
      ok: true,
      value: [
        { rule: "login_failures", fromMs: T0, toMs: T0 + 600_000, count: 20, minCount: 20 },
        { rule: "traffic_refusals", fromMs: T0, toMs: T0 + 300_000, count: 50, minCount: 50 },
      ],
    });
  });
});

describe.each(ANALYSIS_RULES.map((r) => [r.name, r] as const))("rule %s", (name, rule) => {
  const own = { ...thresholds, [rule.key]: { windowMs: WINDOW, minCount: MIN } };
  const [first, second] = RULE_EVENTS.find(([contract]) => contract === name)![2];

  it("reads only event kinds from the catalog", () => {
    for (const event of rule.events) expect(Object.hasOwn(EVENT_CATALOG, event)).toBe(true);
  });

  it.each([
    ["below the threshold", at(first!, 0, 1), []],
    ["exactly on the threshold", at(first!, 0, 1, WINDOW - 1), [[0, 3]]],
    ["above the threshold", at(first!, 0, 1, 2, 3), [[0, 4]]],
    ["an entry exactly windowMs after the first is outside", at(first!, 0, 1, WINDOW), []],
    // Codex review c.6963352885 (1): each event alone is needed to reach the threshold.
    ["the first event reaches the threshold alone", at(first!, 0, 1, 2), [[0, 3]]],
    ["the second event reaches the threshold alone", at(second!, 0, 1, 2), [[0, 3]]],
    [
      "the second event is needed for the threshold",
      [...at(first!, 0, 1), ...at(second!, 2)],
      [[0, 3]],
    ],
    ["other events do not count", [...at(first!, 0, 1), ...at("authn.logout", 2)], []],
    [
      "two bursts windowMs apart give two findings",
      at(first!, 0, 1, 2, WINDOW, WINDOW + 1, WINDOW + 2),
      [
        [0, 3],
        [WINDOW, 3],
      ],
    ],
    [
      "a finding takes every entry in its window",
      at(first!, 0, 1, 2, WINDOW - 1, WINDOW, WINDOW + 1),
      [[0, 4]],
    ],
    // Codex review c.6963024962 (2): a window that fails moves its start by one entry, not past the window.
    [
      "a later start finds what the first window misses",
      at(first!, 0, WINDOW - 1, WINDOW, WINDOW + 1),
      [[WINDOW - 1, 3]],
    ],
  ])("%s", (_, entries, expected) => {
    const want = expected.map(([from, count]) => ({
      rule: name,
      fromMs: T0 + from!,
      toMs: T0 + from! + WINDOW,
      count,
      minCount: MIN,
    }));
    expect(findings(entries, own)).toEqual(want);
    expect(findings([...entries].reverse(), own)).toEqual(want);
  });

  it("gives findings only with the closed keys, frozen, about no person", () => {
    const result = findings(at(first!, 0, 1, 2), own);
    expect(Object.isFrozen(result)).toBe(true);
    for (const finding of result) {
      expect(Object.keys(finding).sort()).toEqual(["count", "fromMs", "minCount", "rule", "toMs"]);
      expect(Object.isFrozen(finding)).toBe(true);
    }
  });

  it("has a name with no forbidden term in either language", () => {
    for (const text of [name.replaceAll("_", " "), rule.key.replace(/([A-Z])/g, " $1")]) {
      expect(findForbiddenTerms(text)).toEqual([]);
    }
  });
});
