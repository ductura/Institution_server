// The record of a refused operator path (S-1J.2, DAN-842-3; contract
// Ductus#1836 c.6950325128): a security event of docs/server-map.md §3, one per
// refusal of step 3 (traffic.ip_denied, operator_only) or step 8
// (authz.operator_denied). Through the log service when one is given, else one
// stderr line as the rate limit's (createRateLimitLog). Never the IP, the
// token, the cookie or the raw path: the route is a contract path or `none`.
import { ROUTES } from "../contracts/index.ts";
import { consoleSink, type LogSink, type LogWriter } from "../log/index.ts";

/** Step 3's network refusal, then step 8's five. */
export const OPERATOR_DENIAL_REASONS = Object.freeze([
  "network_not_allowed",
  "not_signed_in",
  "session_unknown",
  "second_factor_required",
  "not_operator",
  "unavailable",
] as const);
export type OperatorDenialReason = (typeof OPERATOR_DENIAL_REASONS)[number];

export type OperatorDenialLog = (entry: {
  readonly requestId: string;
  readonly route?: string;
  readonly reason: OperatorDenialReason;
}) => void;

const PATHS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.path));
const STEP_8: ReadonlySet<string> = new Set(OPERATOR_DENIAL_REASONS.slice(1));

/**
 * The catalog record of one refusal. A route outside the contracts is `none`;
 * a reason outside the list is `unavailable`. `anonymous`: neither step
 * resolves the account (server/log/events/catalog.ts).
 */
export function operatorDenialRecord(entry: Parameters<OperatorDenialLog>[0], time: Date) {
  const route = typeof entry.route === "string" && PATHS.has(entry.route) ? entry.route : "none";
  const network = entry.reason === "network_not_allowed";
  return {
    time: time.toISOString(),
    event: network ? "traffic.ip_denied" : "authz.operator_denied",
    requestId: entry.requestId,
    accountKind: "anonymous",
    fields: network
      ? { route, rule: "operator_only" }
      : { route, reason: STEP_8.has(entry.reason) ? entry.reason : "unavailable" },
  } as const;
}

/**
 * With `write`, the record goes to the log service and is never awaited: a
 * rejection or a refused record is the writer's to report, not the answer's.
 * Without it, one stderr line built without redact, as createRateLimitLog's
 * (a route is an exact contract path, which redact would blank). Never throws.
 */
export function createOperatorDenialLog(
  options: {
    readonly write?: LogWriter;
    readonly sink?: LogSink;
    readonly now?: () => Date;
  } = {},
): OperatorDenialLog {
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());
  const { write } = options;
  return (entry) => {
    try {
      const record = operatorDenialRecord(entry, now());
      if (write !== undefined) {
        Promise.resolve()
          .then(() => write(record))
          .catch(() => undefined);
        return;
      }
      const { time, event, requestId, fields } = record;
      sink("warn", JSON.stringify({ time, level: "warn", event, requestId, fields }));
    } catch {
      // A record that cannot be made must not change the answer.
    }
  };
}
