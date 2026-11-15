// The HTTP server: layers in order, then the router. Listening resolves with
// the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Databases } from "./databases.ts";
import { createRouter, type Route, sendJson } from "./router.ts";

/**
 * One step before the router (docs/server-map.md §3, steps 2 to 7). "done"
 * means the layer answered and the request stops there. S-1B-b fills the
 * layers and may change this type; it is internal to http.
 */
export type Layer = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<"next" | "done">;

export type StartOptions = {
  readonly host: string;
  readonly port: number;
  readonly layers: readonly Layer[];
  readonly routes: readonly Route[];
  /** Handed to the services of the areas when they get routes (S-M); nothing reads it yet. */
  readonly databases: Databases;
};
export type Running = { readonly port: number; close(): Promise<void> };

export async function startServer(options: StartOptions): Promise<Running> {
  const route = createRouter(options.routes);
  const server = createServer((request, response) => {
    void (async () => {
      for (const layer of options.layers) {
        if ((await layer(request, response)) === "done") return;
      }
      await route(request, response);
    })().catch((error: unknown) => {
      console.error("request failed", (error as Error).name);
      if (!response.headersSent) sendJson(response, 500, { error: "internal" });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
