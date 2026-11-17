// Step 8 of the pipeline (docs/server-map.md §3): the access rules of operator
// paths (S-1J.2, DAN-842-1; contract Ductus#1836 c.6945827668). Step 3 already
// kept out networks outside the list; here an operator path needs a session
// cookie and a second factor (WebAuthn, S-1E-g) the port confirms for that
// session. Other paths pass without a call to the port. Every refusal leaves
// one security event, authz.operator_refused (DAN-842-3).
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import { consoleSink, type LogSink } from "../log/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";
import { isOpsPath } from "../traffic/index.ts";

import { reportServerError, type ServerErrorReporter } from "./error-catalog.ts";
import { requestIdOf } from "./request-id.ts";
import { routePath } from "./router.ts";
import { refuse } from "./security-headers.ts";

/**
 * Has the session of this token confirmed its second factor? An unknown or
 * ended session must answer "unauthenticated"; any other answer is a fault.
 */
export type SecondFactor = (
  token: string,
) => Promise<"confirmed" | "unconfirmed" | "unauthenticated" | "unavailable">;

/** Until a source of confirmations exists, no session has one: operator paths stay closed. */
export const NO_SECOND_FACTOR: SecondFactor = async () => "unconfirmed";

export type OperatorRefusalReason =
  "not_signed_in" | "second_factor_required" | "second_factor_unavailable";

/** Records one refusal; never throws and never changes the answer. */
export type OperatorRefusalLog = (
  request: IncomingMessage,
  response: ServerResponse,
  reason: OperatorRefusalReason,
) => void;

const PATHS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.path));

/**
 * The stderr line of a refusal until the entry point has a log writer
 * (S-1K.3), as createRateLimitLog writes its own: the record of the log
 * catalog plus its level, built here without redact, which would blank the
 * route. The route is an exact contract path or "none", never the target as
 * sent; nothing else of the request (query, cookie, token, address) is read.
 */
export function createOperatorRefusalLog(
  sink: LogSink = consoleSink,
  now: () => Date = () => new Date(),
  paths: ReadonlySet<string> = PATHS,
): OperatorRefusalLog {
  return (request, response, reason) => {
    try {
      const path = routePath(request.url);
      let time: Date;
      try {
        time = now();
        if (!(time instanceof Date) || Number.isNaN(time.getTime())) time = new Date();
      } catch {
        time = new Date();
      }
      const record = {
        time: time.toISOString(),
        level: "warn",
        event: "authz.operator_refused",
        requestId: requestIdOf(response),
        accountKind: "anonymous",
        fields: { route: path !== undefined && paths.has(path) ? path : "none", reason },
      };
      sink("warn", JSON.stringify(record));
    } catch {
      // A log that cannot be written must not change the answer.
    }
  };
}

const defaultRefusalLog: OperatorRefusalLog = createOperatorRefusalLog();

export function operatorPolicyLayer(
  secondFactor: SecondFactor,
  report: ServerErrorReporter = reportServerError,
  log: OperatorRefusalLog = defaultRefusalLog,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<"next" | "done"> => {
    if (!isOpsPath(request.url)) return "next";
    const refuseFor = (reason: OperatorRefusalReason, status: number, code: string) => {
      try {
        log(request, response, reason);
      } catch {
        // A log that breaks its promise not to throw still leaves the refusal.
      }
      refuse(response, status, code);
      return "done" as const;
    };
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) return refuseFor("not_signed_in", 401, "unauthenticated");
    let outcome: unknown;
    try {
      outcome = await secondFactor(token);
    } catch (error) {
      report("layer", error, requestIdOf(response));
      return refuseFor("second_factor_unavailable", 503, "unavailable");
    }
    // Compared with ===, never looked up: "toString" or "__proto__" is no answer.
    if (outcome === "confirmed") return "next";
    if (outcome === "unconfirmed") return refuseFor("second_factor_required", 403, "forbidden");
    if (outcome === "unauthenticated") return refuseFor("not_signed_in", 401, "unauthenticated");
    report("layer", new Error("second factor port: no known outcome"), requestIdOf(response));
    return refuseFor("second_factor_unavailable", 503, "unavailable");
  };
}
