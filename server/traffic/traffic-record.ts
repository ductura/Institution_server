// The traffic recorder (S-1C.4, DAN-831-2; contract Ductus#1836 c.6919128457,
// addendum c.6925832235): one traffic.request record per answered request,
// written when the response closes. It reads the method, the route the caller
// names, the client IP of step 2 and the status, never the body, a header, a
// cookie or the query. It never throws and never waits for the log.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { LogWriter } from "../log/index.ts";
import { clientIpOf } from "./client-ip.ts";

/** The methods traffic.request names; every other method is written as OTHER. */
export const TRAFFIC_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const);

/** Status for a connection closed before the headers went out, by either side. */
export const STATUS_CLOSED_EARLY = 499;
/** The catalog's longest duration (traffic.request durationMs). */
export const MAX_DURATION_MS = 86_400_000;

export type TrafficRecorderOptions = {
  readonly write: LogWriter;
  /** The route template of the request, or null for a path that is no route. */
  readonly routeOf: (request: IncomingMessage) => string | null;
  /** The request id; called only once the response closed. */
  readonly requestIdOf: (response: ServerResponse) => string;
  /** The clock in ms; Date.now by default. */
  readonly now?: () => number;
};

export type TrafficRecorder = {
  /** Records this request once its response closes; a second call does nothing. */
  readonly arm: (request: IncomingMessage, response: ServerResponse) => void;
};

/** One mark per response for every recorder, so a response is never written twice. */
const ARMED = new WeakSet<ServerResponse>();

const durationOf = (ms: number): number =>
  Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_DURATION_MS) : 0;

/** An ISO time from the clock, or from the real one when the clock gives no date. */
function timeOf(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

const methodOf = (method: string | undefined): string =>
  (TRAFFIC_METHODS as readonly (string | undefined)[]).includes(method) ? method! : "OTHER";

export function createTrafficRecorder(options: TrafficRecorderOptions): TrafficRecorder {
  const { write, routeOf, requestIdOf } = options;
  const now = options.now ?? Date.now;

  const record = (request: IncomingMessage, response: ServerResponse, start: number): void => {
    try {
      const end = now();
      const result = write({
        time: timeOf(end),
        event: "traffic.request",
        requestId: requestIdOf(response),
        accountKind: "anonymous",
        fields: {
          method: methodOf(request.method),
          route: routeOf(request) ?? "none",
          ip: clientIpOf(request) ?? "none",
          status: response.headersSent ? response.statusCode : STATUS_CLOSED_EARLY,
          durationMs: durationOf(end - start),
          ipRule: "not_checked",
          rateLimit: "not_checked",
        },
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A record that cannot be made or written never touches the answer.
    }
  };

  return Object.freeze({
    arm(request: IncomingMessage, response: ServerResponse): void {
      try {
        if (ARMED.has(response)) return;
        ARMED.add(response);
        const start = now();
        if (response.closed) record(request, response, start);
        else response.once("close", () => record(request, response, start));
      } catch {
        // Arming never stops a request.
      }
    },
  });
}
