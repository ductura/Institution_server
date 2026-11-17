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

describe.each(ANALYSIS_RULES.map((r) => [r.name, r] as const))("rule %s", (name, rule) => {
  const own = { ...thresholds, [name]: { windowMs: WINDOW, minCount: MIN } };
  const [first, second] = rule.events;

  it("reads only event kinds from the catalog", () => {
    for (const event of rule.events) expect(Object.hasOwn(EVENT_CATALOG, event)).toBe(true);
  });

  it.each([
    ["below the threshold", at(first!, 0, 1), []],
    ["exactly on the threshold", at(first!, 0, 1, WINDOW - 1), [[0, 3]]],
    ["above the threshold", at(first!, 0, 1, 2, 3), [[0, 4]]],
    ["an entry exactly windowMs after the first is outside", at(first!, 0, 1, WINDOW), []],
    ["every event of the rule counts", [...at(first!, 0, 1), ...at(second ?? first!, 2)], [[0, 3]]],
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
    expect(findForbiddenTerms(name.replace(/([A-Z])/g, " $1"))).toEqual([]);
  });
});
