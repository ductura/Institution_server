/**
 * Log analysis rules (S-1K.7-a, DAN-1010-1a; contract Ductus#2028
 * c.6964677996): pure functions that count system events in a time window.
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
]);

export type AnalysisRuleName = (typeof ANALYSIS_RULES)[number]["name"];
export type AnalysisThresholdKey = (typeof ANALYSIS_RULES)[number]["key"];
export type RuleThreshold = { readonly windowMs: number; readonly minCount: number };
export type AnalysisThresholds = Readonly<Record<AnalysisThresholdKey, RuleThreshold>>;

export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The Date limit: an entry time of at most this size keeps `time + windowMs` exact. */
export const MAX_TIME_MS = 8.64e15;
/** A longer list is refused, so a false `length` cannot stall the analysis. */
export const MAX_ENTRIES = 1_000_000;

export const DEFAULT_ANALYSIS_THRESHOLDS: AnalysisThresholds = Object.freeze({
  loginFailures: Object.freeze({ windowMs: 10 * 60 * 1000, minCount: 20 }),
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

// One own data property, read once. A getter, an inherited key, a non-object (a
// function too) or
// a read that throws (revoked Proxy, throwing trap) gives undefined.
function ownValue(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

function readThreshold(thresholds: unknown, key: AnalysisThresholdKey): RuleThreshold | null {
  const own = ownValue(thresholds, key);
  const windowMs = ownValue(own, "windowMs");
  const minCount = ownValue(own, "minCount");
  if (!isCount(windowMs) || !isCount(minCount) || windowMs > MAX_WINDOW_MS) return null;
  return { windowMs, minCount };
}

type ReadEntry = { readonly time: number; readonly event: string };

// The list index by index; an index or entry that cannot be read is skipped.
function readEntries(entries: unknown): ReadEntry[] | null {
  try {
    if (!Array.isArray(entries)) return null;
  } catch {
    return null;
  }
  const length = ownValue(entries, "length");
  if (!Number.isSafeInteger(length) || (length as number) > MAX_ENTRIES) return null;
  const read: ReadEntry[] = [];
  for (let i = 0; i < (length as number); i += 1) {
    const entry = ownValue(entries, String(i));
    const event = ownValue(entry, "event");
    const time = ownValue(entry, "timeMs");
    if (typeof event !== "string" || !Number.isSafeInteger(time)) continue;
    if (Math.abs(time as number) > MAX_TIME_MS) continue;
    read.push({ time: (time as number) + 0, event }); // + 0 turns -0 into 0
  }
  return read;
}

/** Each run of at least `minCount` times within `[t, t + windowMs)`; windows do not overlap. */
function windowsOf(
  times: readonly number[],
  rule: AnalysisRuleName,
  t: RuleThreshold,
): AnalysisFinding[] {
  const found: AnalysisFinding[] = [];
  let i = 0;
  let j = 0; // never moves back, so each time is passed once
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

function refuse(code: AnalysisError["code"]): AnalysisResult {
  const error = Object.freeze({ code, messageKey: `logAnalysis.${code.toLowerCase()}` });
  return Object.freeze({ ok: false, error });
}

/**
 * Runs every rule on `entries`. Thresholds are checked first; an invalid
 * threshold or a list that cannot be read refuses the run, an entry that
 * cannot be read is skipped. Never throws.
 */
export function analyzeLog(
  entries: readonly AnalysisEntry[],
  thresholds: AnalysisThresholds = DEFAULT_ANALYSIS_THRESHOLDS,
): AnalysisResult {
  const checked = ANALYSIS_RULES.map((r) => readThreshold(thresholds, r.key));
  if (checked.some((t) => t === null)) return refuse("ANALYSIS_THRESHOLD_INVALID");
  const read = readEntries(entries);
  if (read === null) return refuse("ANALYSIS_ENTRIES_INVALID");
  const findings = ANALYSIS_RULES.flatMap((r, index) => {
    const events: readonly string[] = r.events;
    const times = read.filter((e) => events.includes(e.event)).map((e) => e.time);
    return windowsOf(
      times.sort((a, b) => a - b),
      r.name,
      checked[index]!,
    );
  });
  return Object.freeze({ ok: true, value: Object.freeze(findings) });
}
