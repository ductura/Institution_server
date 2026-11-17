// Step 8 of the pipeline (docs/server-map.md §3): the access rules of operator
// paths (S-1J.2, DAN-842-1; contract Ductus#1836 c.6945827668). Step 3 already
// kept out networks outside the list; here an operator path needs a session
// cookie and a second factor (WebAuthn, S-1E-g) the port confirms for that
// session. Other paths pass without a call to the port.
import type { IncomingMessage, ServerResponse } from "node:http";

import { liveSessionTokenFromCookie } from "../session/index.ts";
import { isOpsPath } from "../traffic/index.ts";

import { reportServerError, type ServerErrorReporter } from "./error-catalog.ts";
import { requestIdOf } from "./request-id.ts";
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

export function operatorPolicyLayer(
  secondFactor: SecondFactor,
  report: ServerErrorReporter = reportServerError,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<"next" | "done"> => {
    if (!isOpsPath(request.url)) return "next";
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) {
      refuse(response, 401, "unauthenticated");
      return "done";
    }
    let outcome: unknown;
    try {
      outcome = await secondFactor(token);
    } catch (error) {
      report("layer", error, requestIdOf(response));
      refuse(response, 503, "unavailable");
      return "done";
    }
    // Compared with ===, never looked up: "toString" or "__proto__" is no answer.
    if (outcome === "confirmed") return "next";
    if (outcome === "unconfirmed") refuse(response, 403, "forbidden");
    else if (outcome === "unauthenticated") refuse(response, 401, "unauthenticated");
    else {
      report("layer", new Error("second factor port: no known outcome"), requestIdOf(response));
      refuse(response, 503, "unavailable");
    }
    return "done";
  };
}
