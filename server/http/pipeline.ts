// The layers before the application (docs/server-map.md §3, steps 2 to 7),
// S-1B-b (DAN-777). The order lives only in PIPELINE_STEPS: callers hand over
// one layer per step by name, never a list, so they cannot reorder, skip or
// add a step. The pipeline fails closed: anything but "next" from a layer
// stops the request before the application.
import type { IncomingMessage, ServerResponse } from "node:http";

import { originLayer } from "./mutation-request.ts";
import { refuse, securityHeadersLayer } from "./security-headers.ts";

export const PIPELINE_STEPS = Object.freeze([
  "clientIp",
  "ipRules",
  "rateLimit",
  "trafficRecord",
  "securityHeaders",
  "originCheck",
] as const);
export type Step = (typeof PIPELINE_STEPS)[number];

/** "done" means the layer answered (refused) and the request stops there. */
export type Layer = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<"next" | "done">;
export type Layers = { readonly [S in Step]: Layer };
export type App = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const answered = (response: ServerResponse): boolean =>
  response.headersSent || response.writableEnded;

/** Steps 2 to 5 are empty until wave 5 fills them; they read nothing. */
const pass: Layer = async () => "next";

export function createLayers(options: { readonly expectedOrigin: string | null }): Layers {
  return Object.freeze({
    clientIp: pass,
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
    for (const layer of ordered) {
      let outcome: unknown;
      try {
        outcome = await layer(request, response);
      } catch (error) {
        console.error("layer failed", (error as Error).name);
        outcome = undefined;
      }
      // Anything but "next" from a layer that has not answered, or "next" from
      // one that has, ends the request here; the application never runs.
      if (outcome === "next" && !answered(response)) continue;
      if (!response.headersSent) refuse(response, 500, "internal");
      else if (!response.writableEnded) response.destroy();
      return;
    }
    await app(request, response);
  };
}
