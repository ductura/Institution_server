// Step 3 of the pipeline (docs/server-map.md §3): the IP rules of server/traffic
// (S-1C.2, DAN-832-1; contract Ductus#1836). An operator path from a client IP
// outside a non-empty list, or without one, gets the shared 403 forbidden
// through refuse(), so the connection closes; the answer names no address.
import type { IncomingMessage, ServerResponse } from "node:http";

import { type AllowedNetworks, clientIpOf, isOpsPath, networkAllows } from "../traffic/index.ts";

import { createOperatorDenialLog, type OperatorDenialLog } from "./operator-denial-log.ts";
import { recordDenial } from "./operator-policy-layer.ts";
import { refuse } from "./security-headers.ts";

const defaultDenialLog: OperatorDenialLog = createOperatorDenialLog();

/**
 * The list is read once per operator request, so a rule change applies to the
 * next one. A refusal is recorded as traffic.ip_denied, operator_only (DAN-842-3).
 */
export function ipRulesLayer(
  allowedNetworks: () => AllowedNetworks,
  log: OperatorDenialLog = defaultDenialLog,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<"next" | "done"> => {
    if (!isOpsPath(request.url)) return "next";
    if (networkAllows(allowedNetworks(), clientIpOf(request))) return "next";
    refuse(response, 403, "forbidden");
    recordDenial(log, request, response, "network_not_allowed");
    return "done";
  };
}
