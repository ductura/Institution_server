// The metrics collector interval from the environment (S-1K.4-b part 4b,
// DAN-834-4b; contract Ductus#1836 c.6931746705). Optional, in milliseconds.
// The floor leaves room for one round: the database health check (2 s) and
// the metric_sample write deadline (1 s). The ceiling is one hour, well under
// the 2^31 - 1 ms a timer keeps. Unlike the older checks in server/config,
// only an own data property counts: an inherited key is as if unset, and a
// getter is refused without being called. Problems name the variable, never
// its value; the assembler (DAN-834-5) adds them to the startup check.
type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_METRICS_INTERVAL_MS = 60_000;
export const METRICS_INTERVAL_MIN_MS = 5_000;
export const METRICS_INTERVAL_MAX_MS = 3_600_000;
const VARIABLE = "METRICS_INTERVAL_MS";
const DIGITS_RE = /^[1-9]\d{3,6}$/u;

/** The own value: undefined when unset, null when it is not a plain string. */
function ownValue(env: Env): string | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, VARIABLE);
  if (descriptor === undefined) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : null;
}

function parse(value: string | null): number | null {
  if (value === null || !DIGITS_RE.test(value)) return null;
  const ms = Number(value);
  return ms >= METRICS_INTERVAL_MIN_MS && ms <= METRICS_INTERVAL_MAX_MS ? ms : null;
}

/** The problem of METRICS_INTERVAL_MS, by variable name only; empty when unset or usable. */
export function metricsIntervalProblems(env: Env): string[] {
  const value = ownValue(env);
  if (value === undefined || parse(value) !== null) return [];
  return [
    `${VARIABLE} is not a whole number from ${METRICS_INTERVAL_MIN_MS} to ${METRICS_INTERVAL_MAX_MS}`,
  ];
}

/** The collector interval; call only when metricsIntervalProblems is empty. */
export function metricsIntervalMs(env: Env): number {
  const value = ownValue(env);
  return (value === undefined ? null : parse(value)) ?? DEFAULT_METRICS_INTERVAL_MS;
}
