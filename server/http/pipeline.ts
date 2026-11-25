// The layers before the application (docs/server-map.md §3, steps 2 to 8),
// S-1B-b (DAN-777). The order lives only in PIPELINE_STEPS: callers hand over
// one layer per step by name, never a list, so they cannot reorder, skip or
// add a step. The pipeline fails closed: anything but "next" from a layer
// stops the request before the application.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "../contracts/index.ts";
import { createLogWriter, type LogWriter } from "../log/index.ts";
import {
  type AllowedNetworks,
  clientIpLayer,
  createTrafficRecorder,
  NO_ALLOWED_NETWORKS,
  NO_TRUSTED_PROXIES,
  type RateLimiter,
  type TrustedProxies,
} from "../traffic/index.ts";
import { reportServerError, type ServerErrorReporter } from "./error-catalog.ts";
import { ipRulesLayer } from "./ip-rules-layer.ts";
import { originLayer } from "./mutation-request.ts";
import { createOperatorDenialLog, type OperatorDenialLog } from "./operator-denial-log.ts";
import {
  NO_OPERATORS,
  NO_SECOND_FACTOR,
  type OperatorList,
  operatorPolicyLayer,
  type SecondFactor,
} from "./operator-policy-layer.ts";
import { defaultRateLimiter, type RateLimitLog, rateLimitLayer } from "./rate-limit-layer.ts";
import { requestIdOf } from "./request-id.ts";
import { routePath } from "./router.ts";
import { answerInternal, refuse, securityHeadersLayer } from "./security-headers.ts";

export const PIPELINE_STEPS = Object.freeze([
  "clientIp",
  "ipRules",
  "rateLimit",
  "trafficRecord",
  "securityHeaders",
  "originCheck",
  "operatorPolicy",
] as const);
export type Step = (typeof PIPELINE_STEPS)[number];

/**
 * "done" means the layer answered (refused) and the request stops there. A
 * layer refuses only through refuse() and only together with "done", and
 * answers nothing after it returned: the pipeline cannot see a late answer
 * or a statusCode set without one (wave 5 follows this).
 */
export type Layer = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<"next" | "done">;
export type Layers = { readonly [S in Step]: Layer };
export type App = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const answered = (response: ServerResponse): boolean =>
  response.headersSent || response.writableEnded;

/**
 * Node hands over a pipelined request at once, while the answer to the one
 * before it is still pending; its response gets the socket only after that.
 * Waiting for the socket means a request queued behind a refusal that closes
 * the connection never runs (adversarial pass on DAN-777 a2): false when the
 * connection closed or is closing first.
 */
function attached(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  // A socket a refusal already ended (Connection: close) is no answer either.
  const open = (): boolean => response.socket !== null && response.socket.writable;
  if (response.socket !== null) return Promise.resolve(open());
  return new Promise((resolve) => {
    const settle = (value: boolean) => (): void => {
      response.off("socket", onSocket);
      request.off("close", onClose);
      resolve(value && open());
    };
    const onSocket = settle(true);
    const onClose = settle(false);
    response.once("socket", onSocket);
    request.once("close", onClose);
  });
}

const TEMPLATES: readonly (readonly string[])[] = ROUTES.map((route) => route.path.split("/"));
const isParam = (segment: string): boolean => /^\{\w+\}$/u.test(segment);

/**
 * The contract path template of a request, or null when it is no route: the
 * path is read as the router reads it (no query, no decoding) and a literal
 * path wins over a template. Nothing else of the request is looked at.
 */
export function trafficRouteOf(request: IncomingMessage): string | null {
  const path = routePath(request.url);
  if (path === undefined) return null;
  const sent = path.split("/");
  const found = TEMPLATES.filter(
    (template) =>
      template.length === sent.length &&
      template.every((segment, i) => segment === sent[i] || (isParam(segment) && sent[i] !== "")),
  );
  const best = found.find((template) => !template.some(isParam)) ?? found[0];
  return best === undefined ? null : best.join("/");
}

/**
 * The log service step 5 writes with: one row of log_entry per record, over
 * the logs database port (ductus_logs_writer). It never throws, and a request
 * never waits for it (server/log/writer.ts).
 */
export function trafficLogFor(logs: {
  readonly query: (text: string, values: unknown[]) => unknown;
}): LogWriter {
  return createLogWriter({
    routes: new Set(ROUTES.map((route) => route.path)),
    store: {
      append: (kind, payload) =>
        logs.query("INSERT INTO public.log_entry (kind, payload) VALUES ($1, $2::jsonb)", [
          kind,
          JSON.stringify(payload),
        ]),
    },
  });
}

/**
 * Step 5 (traffic record, DAN-1536): arms the recorder of server/traffic for
 * the request and goes on; the record is written when the response closes.
 * Without a log writer nothing is recorded. A recorder that throws, or a
 * writer that rejects or never settles, never changes the answer: arm and the
 * write are fire and forget, and a throw here is caught again so the layer
 * always answers "next".
 */
function trafficRecordLayer(write: LogWriter | undefined): Layer {
  if (write === undefined) return async () => "next";
  const recorder = createTrafficRecorder({ write, routeOf: trafficRouteOf, requestIdOf });
  return async (request, response) => {
    try {
      recorder.arm(request, response);
    } catch {
      // A record that cannot be armed never stops a request.
    }
    return "next";
  };
}

/**
 * Without trustedProxies (TRUSTED_PROXIES) X-Forwarded-For is never read and
 * the client IP is the direct peer (S-1C.1, DAN-790). Without rateLimiter
 * the limit has the catalogue's defaults (S-1C.3, DAN-814); every server
 * built here has one, so no caller can leave step 4 open. Without
 * allowedNetworks operator paths are open to every network (S-1C.2, DAN-832-1);
 * without operators nobody is on the operator list and without secondFactor no
 * session has one, so operator paths answer 401 or 403 and never reach the
 * application (S-1J.2, DAN-842-1, DAN-1092-1). Every refusal of
 * steps 3 and 8 goes to operatorDenialLog, one stderr line by default (DAN-842-3).
 */
export function createLayers(options: {
  readonly expectedOrigin: string | null;
  readonly trustedProxies?: TrustedProxies;
  readonly rateLimiter?: RateLimiter;
  readonly rateLimitLog?: RateLimitLog;
  readonly allowedNetworks?: () => AllowedNetworks;
  readonly secondFactor?: SecondFactor;
  readonly operators?: OperatorList;
  readonly operatorDenialLog?: OperatorDenialLog;
  /** The log writer step 5 records traffic with; without it nothing is recorded. */
  readonly trafficLog?: LogWriter;
}): Layers {
  const denials = options.operatorDenialLog ?? createOperatorDenialLog();
  return Object.freeze({
    clientIp: clientIpLayer(options.trustedProxies ?? NO_TRUSTED_PROXIES),
    ipRules: ipRulesLayer(options.allowedNetworks ?? (() => NO_ALLOWED_NETWORKS), denials),
    rateLimit: rateLimitLayer(
      options.rateLimiter ?? defaultRateLimiter(),
      ...(options.rateLimitLog === undefined ? [] : [options.rateLimitLog]),
    ),
    trafficRecord: trafficRecordLayer(options.trafficLog),
    securityHeaders: securityHeadersLayer,
    originCheck: originLayer(options.expectedOrigin),
    operatorPolicy: operatorPolicyLayer(
      options.secondFactor ?? NO_SECOND_FACTOR,
      reportServerError,
      denials,
      options.operators ?? NO_OPERATORS,
    ),
  });
}

/**
 * Binds the layers in the order of PIPELINE_STEPS, read once here: a later
 * change to the object has no effect. Keys other than exactly the steps, or a
 * layer that is not a function, are a programming error at startup.
 */
export function createPipeline(
  layers: Layers,
  app: App,
  report: ServerErrorReporter = reportServerError,
): App {
  const keys = Object.keys(layers).sort();
  const steps = [...PIPELINE_STEPS].sort();
  if (keys.length !== steps.length || keys.some((key, i) => key !== steps[i])) {
    throw new Error("layers must name exactly the pipeline steps");
  }
  const ordered: readonly Layer[] = PIPELINE_STEPS.map((step) => {
    const layer: unknown = layers[step];
    if (typeof layer !== "function") throw new Error(`layer ${step} is not a function`);
    return layer as Layer;
  });

  return async (request, response) => {
    if (!(await attached(request, response))) return;
    for (const layer of ordered) {
      let outcome: unknown;
      try {
        outcome = await layer(request, response);
      } catch (error) {
        report("layer", error, requestIdOf(response));
        outcome = undefined;
      }
      // Anything but "next" from a layer that has not answered, or "next" from
      // one that has, ends the request here; the application never runs.
      if (outcome === "next" && !answered(response)) continue;
      answerInternal(response);
      return;
    }
    await app(request, response);
  };
}
