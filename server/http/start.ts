// The HTTP server: layers in order, then the router. Listening resolves with
// the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Databases } from "./databases.ts";
import { createRouter, type Route, sendJson } from "./router.ts";
import { createShutdownCoordinator, type Listener, type ShutdownCoordinator } from "./shutdown.ts";

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
  /** Issues a ticket per request; after stop() a request gets 503 (S-1B-c). */
  readonly shutdown?: ShutdownCoordinator;
};
export type Running = Listener & { readonly port: number; close(): Promise<void> };

// The refusal while shutting down: the contract's word and format, and the
// connection is not kept for another request.
const UNAVAILABLE = { connection: "close", "retry-after": "1" };

export async function startServer(options: StartOptions): Promise<Running> {
  const route = createRouter(options.routes);
  const shutdown = options.shutdown ?? createShutdownCoordinator();
  const server = createServer((request, response) => {
    const ticket = shutdown.begin();
    if (ticket === null) {
      sendJson(response, 503, { error: "unavailable" }, UNAVAILABLE);
      return;
    }
    response.once("close", () => {
      ticket.release();
      // A kept-alive connection whose last request ended while draining is
      // idle now and closes, so it cannot carry a new request.
      if (shutdown.state() !== "running") setImmediate(() => server.closeIdleConnections());
    });
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
    stopAccepting: () => {
      server.close();
      server.closeIdleConnections();
    },
    closeAllConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
