// The layers before the application (docs/server-map.md §3, steps 2 to 7),
// S-1B-b (DAN-777). The order lives only in PIPELINE_STEPS: callers hand over
// one layer per step by name, never a list, so they cannot reorder, skip or
// add a step. The pipeline fails closed: anything but "next" from a layer
// stops the request before the application.
import type { IncomingMessage, ServerResponse } from "node:http";

import { clientIpLayer, NO_TRUSTED_PROXIES, type TrustedProxies } from "../traffic/index.ts";
import { originLayer } from "./mutation-request.ts";
import { errorName } from "./router.ts";
import { answerInternal, refuse, securityHeadersLayer } from "./security-headers.ts";

export const PIPELINE_STEPS = Object.freeze([
  "clientIp",
  "ipRules",
  "rateLimit",
  "trafficRecord",
  "securityHeaders",
  "originCheck",
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

/** Steps 3 to 5 are empty until wave 5 fills them; they read nothing. */
const pass: Layer = async () => "next";

/**
 * Without trustedProxies (TRUSTED_PROXIES) X-Forwarded-For is never read and
 * the client IP is the direct peer (S-1C.1, DAN-790).
 */
export function createLayers(options: {
  readonly expectedOrigin: string | null;
  readonly trustedProxies?: TrustedProxies;
}): Layers {
  return Object.freeze({
    clientIp: clientIpLayer(options.trustedProxies ?? NO_TRUSTED_PROXIES),
    ipRules: pass,
    rateLimit: pass,
    trafficRecord: pass,
    securityHeaders: securityHeadersLayer,
    originCheck: originLayer(options.expectedOrigin),
  });
}

/**
 * Binds the layers in the order of PIPELINE_STEPS, read once here: a later
 * change to the object has no effect. Keys other than exactly the steps, or a
 * layer that is not a function, are a programming error at startup.
 */
export function createPipeline(layers: Layers, app: App): App {
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
        console.error("layer failed", errorName(error));
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
