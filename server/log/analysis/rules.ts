/**
 * Log analysis rules (S-1K.7-a, DAN-1010-1a to 1e; contracts Ductus#2028
 * c.6964677996, c.6967029458, c.6980590578, c.6981110138 and c.6982169225):
 * pure functions that count system events in a time window.
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
  // Only rejected cookies: a session created, expired or revoked is the usual course.
  rule("session_rejections", "sessionRejections", ["session.cookie_rejected"]),
  // One rule for the authz group until there is data (contract 1d); `reason` is not read.
  rule("authz_denials", "authzDenials", [
    "authz.denied",
    "authz.operator_denied",
    "authz.origin_rejected",
  ]),
  // Failed calls and backups only; warning.raised is the analysis' own output (D-298).
  rule("operation_failures", "operationFailures", [
    "external.call_failed",
    "backup.failed",
    "backup.restore_failed",
  ]),
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
  trafficRefusals: Object.freeze({ windowMs: 5 * 60 * 1000, minCount: 50 }),
  // Provisional: nothing writes session.cookie_rejected yet (contract 1c).
  sessionRejections: Object.freeze({ windowMs: 5 * 60 * 1000, minCount: 100 }),
  // Provisional: only authz.operator_denied is written yet (contract 1d, c.6981110138).
  authzDenials: Object.freeze({ windowMs: 10 * 60 * 1000, minCount: 50 }),
  // Provisional: none of the three events is written yet (contract 1e, c.6982169225).
  operationFailures: Object.freeze({ windowMs: 10 * 60 * 1000, minCount: 20 }),
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
// function too) or a read that throws (revoked Proxy, throwing trap) gives
// undefined. `hasOwn` keeps a `value` inherited from Object.prototype out.
function ownValue(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
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

// Adds an own index to a list built here. `push` and index assignment would go
// through Array.prototype, where a read-only index makes them throw.
function append<T>(list: T[], value: T): void {
  // The descriptor has no prototype, so `get` or `set` on Object.prototype
  // cannot turn it into an accessor descriptor.
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  Object.defineProperty(list, list.length, descriptor);
}

// The list index by index; an index or entry that cannot be read is skipped.
function readEntries(entries: unknown): ReadEntry[] | null {
  try {
    if (!Array.isArray(entries)) return null;
  } catch {
    return null;
  }
  const length = ownValue(entries, "length");
  const count = length as number;
  if (!Number.isSafeInteger(length) || count < 0 || count > MAX_ENTRIES) return null;
  const read: ReadEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = ownValue(entries, String(i));
    const event = ownValue(entry, "event");
    const time = ownValue(entry, "timeMs");
    if (typeof event !== "string" || !Number.isSafeInteger(time)) continue;
    if (Math.abs(time as number) > MAX_TIME_MS) continue;
    append(read, { time: (time as number) + 0, event }); // + 0 turns -0 into 0
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
      append(found, Object.freeze({ rule, fromMs, toMs, count: j - i, minCount: t.minCount }));
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
