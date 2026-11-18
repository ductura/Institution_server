// Step 8 of the pipeline (docs/server-map.md §3): the access rules of operator
// paths (S-1J.2, DAN-842-1; contract Ductus#1836 c.6945827668). Step 3 already
// kept out networks outside the list; here an operator path needs a session
// cookie, an account on the server's operator list (DAN-1092-1; owner decision
// "AAI + WebAuthn + network", Ductus#2012 c.6968801723), never an AAI
// attribute, and then a second factor (WebAuthn, S-1E-g) the port confirms for
// that session. Other paths pass without a call to either port.
import type { IncomingMessage, ServerResponse } from "node:http";

import { liveSessionTokenFromCookie } from "../session/index.ts";
import { isOpsPath } from "../traffic/index.ts";

import { reportServerError, type ServerErrorReporter } from "./error-catalog.ts";
import {
  createOperatorDenialLog,
  type OperatorDenialLog,
  type OperatorDenialReason,
} from "./operator-denial-log.ts";
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

/**
 * Does the server's operator list name the account of this token? An unknown
 * or ended session must answer "unauthenticated"; any other answer is a fault.
 */
export type OperatorList = (
  token: string,
) => Promise<"listed" | "not_listed" | "unauthenticated" | "unavailable">;

/** Until a list is configured, nobody is on it: operator paths stay closed. */
export const NO_OPERATORS: OperatorList = async () => "not_listed";

const defaultDenialLog: OperatorDenialLog = createOperatorDenialLog();

/**
 * Records one refusal after refuse() answered: the request id exists only from
 * then on (sendProblem), and is the one of X-Request-Id. Never throws.
 */
export function recordDenial(
  log: OperatorDenialLog,
  request: IncomingMessage,
  response: ServerResponse,
  reason: OperatorDenialReason,
): void {
  try {
    const route = routePath(request.url);
    log({ requestId: requestIdOf(response), ...(route === undefined ? {} : { route }), reason });
  } catch {
    // A record that cannot be written must not change the answer.
  }
}

export function operatorPolicyLayer(
  secondFactor: SecondFactor,
  report: ServerErrorReporter = reportServerError,
  log: OperatorDenialLog = defaultDenialLog,
  operators: OperatorList = NO_OPERATORS,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<"next" | "done"> => {
    if (!isOpsPath(request.url)) return "next";
    const deny = (status: number, code: string, reason: OperatorDenialReason): "done" => {
      refuse(response, status, code);
      recordDenial(log, request, response, reason);
      return "done";
    };
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) return deny(401, "unauthenticated", "not_signed_in");
    // Asked in turn: the second factor only for an account on the list.
    const ask = async (
      port: () => Promise<unknown>,
      pass: string,
      fail: string,
      reason: OperatorDenialReason,
      name: string,
    ): Promise<"next" | "done"> => {
      let outcome: unknown;
      try {
        outcome = await port();
      } catch (error) {
        report("layer", error, requestIdOf(response));
        return deny(503, "unavailable", "unavailable");
      }
      // Compared with ===, never looked up: "toString" or "__proto__" is no answer.
      if (outcome === pass) return "next";
      if (outcome === fail) return deny(403, "forbidden", reason);
      if (outcome === "unauthenticated") return deny(401, "unauthenticated", "session_unknown");
      report("layer", new Error(`${name} port: no known outcome`), requestIdOf(response));
      return deny(503, "unavailable", "unavailable");
    };
    const listed = await ask(
      () => operators(token),
      "listed",
      "not_listed",
      "not_operator",
      "operator list",
    );
    if (listed !== "next") return listed;
    return ask(
      () => secondFactor(token),
      "confirmed",
      "unconfirmed",
      "second_factor_required",
      "second factor",
    );
  };
}
