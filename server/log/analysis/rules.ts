/**
 * Log analysis rules (S-1K.7-a, DAN-1010-1; contract Ductus#2028
 * c.6962315424): pure functions that count system events in a time window.
 * A finding is about the system only: it holds no account, address or person,
 * so it is never a statement about a student and goes to no teacher.
 */
import type { EventKind } from "../events/index.ts";

/** A local log entry: only the time (epoch ms) and the event kind. */
export type AnalysisEntry = { readonly timeMs: number; readonly event: string };

// `name` is the rule name of the contract, in findings; `key` is its threshold
// key, in camelCase because object keys follow CODE_STYLE §2.
const rule = <const N extends string, const K extends string>(
  name: N,
  key: K,
  events: readonly EventKind[],
) => Object.freeze({ name, key, events: Object.freeze([...events]) });

export const ANALYSIS_RULES = Object.freeze([
  rule("login_failures", "loginFailures", ["authn.login_failed", "authn.second_factor_failed"]),
  rule("traffic_refusals", "trafficRefusals", ["traffic.rate_limited", "traffic.ip_denied"]),
]);

export type AnalysisRuleName = (typeof ANALYSIS_RULES)[number]["name"];
export type AnalysisThresholdKey = (typeof ANALYSIS_RULES)[number]["key"];
export type RuleThreshold = { readonly windowMs: number; readonly minCount: number };
export type AnalysisThresholds = Readonly<Record<AnalysisThresholdKey, RuleThreshold>>;

export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * The Date limit (ECMA-262 time value range). An entry time is an integer of at
 * most this size, so `time + windowMs` stays exact (below 2 ** 53).
 */
export const MAX_TIME_MS = 8.64e15;

export const DEFAULT_ANALYSIS_THRESHOLDS: AnalysisThresholds = Object.freeze({
  loginFailures: Object.freeze({ windowMs: 10 * 60 * 1000, minCount: 20 }),
  trafficRefusals: Object.freeze({ windowMs: 5 * 60 * 1000, minCount: 50 }),
});

export type AnalysisFinding = {
  readonly rule: AnalysisRuleName;
  readonly fromMs: number;
  readonly toMs: number;
  readonly count: number;
  readonly minCount: number;
};

export const ANALYSIS_ERROR_CODES = Object.freeze([
  "ANALYSIS_THRESHOLD_INVALID",
  "ANALYSIS_ENTRIES_INVALID",
] as const);
export type AnalysisError = {
  readonly code: (typeof ANALYSIS_ERROR_CODES)[number];
  readonly messageKey: string;
};
export type AnalysisResult =
  | { readonly ok: true; readonly value: readonly AnalysisFinding[] }
  | { readonly ok: false; readonly error: AnalysisError };

// Own data properties only: a getter, an inherited key, a non-object or a value
// that throws when read (a revoked Proxy, a throwing trap) gives undefined.
function ownValue(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

// A plain copy of the list, or null when it is no array or throws when read.
function readEntries(entries: unknown): readonly unknown[] | null {
  try {
    return Array.isArray(entries) ? Array.prototype.slice.call(entries) : null;
  } catch {
    return null;
  }
}

function refuse(code: AnalysisError["code"]): AnalysisResult {
  return { ok: false, error: { code, messageKey: `logAnalysis.${code.toLowerCase()}` } };
}

function readThreshold(thresholds: unknown, key: AnalysisThresholdKey): RuleThreshold | null {
  const own = ownValue(thresholds, key);
  const windowMs = ownValue(own, "windowMs");
  const minCount = ownValue(own, "minCount");
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  if (!valid(windowMs) || !valid(minCount) || windowMs > MAX_WINDOW_MS) return null;
  return { windowMs, minCount };
}

/** Each run of at least `minCount` entries within `[t, t + windowMs)`; windows do not overlap. */
function windowsOf(
  times: readonly number[],
  rule: AnalysisRuleName,
  t: RuleThreshold,
): AnalysisFinding[] {
  const found: AnalysisFinding[] = [];
  let i = 0;
  // `j` never moves back: the window end only grows as `i` grows, so each entry is passed once.
  let j = 0;
  while (i < times.length) {
    const fromMs = times[i]!;
    const toMs = fromMs + t.windowMs;
    if (j < i) j = i;
    while (j < times.length && times[j]! < toMs) j += 1;
    if (j - i >= t.minCount) {
      found.push(Object.freeze({ rule, fromMs, toMs, count: j - i, minCount: t.minCount }));
      i = j;
    } else {
      i += 1;
    }
  }
  return found;
}

/**
 * Runs every rule on `entries`; an invalid threshold or a list it cannot read
 * refuses the whole run, an entry it cannot read is skipped. Never throws.
 */
export function analyzeLog(
  entries: readonly AnalysisEntry[],
  thresholds: AnalysisThresholds = DEFAULT_ANALYSIS_THRESHOLDS,
): AnalysisResult {
  const checked = ANALYSIS_RULES.map((rule) => readThreshold(thresholds, rule.key));
  if (checked.some((t) => t === null)) return refuse("ANALYSIS_THRESHOLD_INVALID");
  const list = readEntries(entries);
  if (list === null) return refuse("ANALYSIS_ENTRIES_INVALID");
  const findings = ANALYSIS_RULES.flatMap((rule, index) => {
    const events: readonly string[] = rule.events;
    const times = list
      .filter((entry) => {
        const event = ownValue(entry, "event");
        return typeof event === "string" && events.includes(event);
      })
      .map((entry) => ownValue(entry, "timeMs"))
      .filter(
        (time): time is number =>
          Number.isSafeInteger(time) && Math.abs(time as number) <= MAX_TIME_MS,
      )
      .map((time) => time + 0) // -0 becomes 0
      .sort((a, b) => a - b);
    return windowsOf(times, rule.name, checked[index]!);
  });
  return { ok: true, value: Object.freeze(findings) };
}
