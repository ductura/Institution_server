// The HTTP server: layers in order, then the router. Listening resolves with
// the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";

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
  // Responses whose headers are not sent yet: once draining they say
  // Connection: close, so no client is told it may reuse the connection.
  const pending = new Set<ServerResponse>();
  // Requests in flight per connection. Node's closeIdleConnections (also run
  // by http.Server.close) counts a connection idle as soon as its response
  // ended, while the body may still be in the socket buffer, so shutdown ends
  // only connections that served a request and hold none now.
  const connections = new Map<Socket, { active: number; served: boolean }>();
  const endIfIdle = (socket: Socket) => {
    const state = connections.get(socket);
    if (state?.served === true && state.active === 0) socket.end();
  };
  const server = createServer((request, response) => {
    const ticket = shutdown.begin();
    if (ticket === null) {
      sendJson(response, 503, { error: "unavailable" }, UNAVAILABLE);
      return;
    }
    const socket = request.socket;
    const connection = connections.get(socket);
    if (connection !== undefined) {
      connection.active += 1;
      connection.served = true;
    }
    pending.add(response);
    // The ticket is held until the handler settled and the last byte left the
    // process (or the socket closed): a client that disconnects does not end
    // the drain under a running handler, and a large body is not cut by exit.
    let open = 2;
    const done = () => {
      open -= 1;
      if (open > 0) return;
      if (connection !== undefined) connection.active -= 1;
      ticket.release();
      if (shutdown.state() !== "running") endIfIdle(socket);
    };
    response.once("close", () => {
      pending.delete(response);
      if (socket.destroyed || socket.writableLength === 0) return done();
      let waiting = true;
      const flushed = () => {
        if (!waiting) return;
        waiting = false;
        socket.off("close", flushed);
        socket.off("finish", flushed);
        done();
      };
      socket.once("close", flushed);
      // Writes leave in order: the callback of an empty write, or the finish
      // of an ended socket, comes after every byte before it.
      if (socket.writableEnded) socket.once("finish", flushed);
      else socket.write("", flushed);
    });
    void (async () => {
      for (const layer of options.layers) {
        if ((await layer(request, response)) === "done") return;
      }
      await route(request, response);
    })()
      .catch((error: unknown) => {
        console.error("request failed", (error as Error).name);
        if (!response.headersSent) sendJson(response, 500, { error: "internal" });
        else response.destroy();
      })
      .finally(done);
  });
  server.on("connection", (socket: Socket) => {
    connections.set(socket, { active: 0, served: false });
    socket.once("close", () => connections.delete(socket));
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
      for (const response of pending) if (!response.headersSent) response.shouldKeepAlive = false;
      // Stop listening without http.Server.close, which would also end
      // connections whose last body is still being written (see above).
      NetServer.prototype.close.call(server);
      for (const socket of connections.keys()) endIfIdle(socket);
    },
    closeAllConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
