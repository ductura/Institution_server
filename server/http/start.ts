// The HTTP server: the layers of pipeline.ts, then the router. Listening
// resolves with the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";

import type { Databases } from "./databases.ts";
import { createPipeline, type Layers } from "./pipeline.ts";
import { createRouter, type Route } from "./router.ts";
import { refuse } from "./security-headers.ts";
import { createShutdownCoordinator, type Listener, type ShutdownCoordinator } from "./shutdown.ts";

export type StartOptions = {
  readonly host: string;
  readonly port: number;
  /** One layer per step of docs/server-map.md §3, 2 to 7; the order is the pipeline's. */
  readonly layers: Layers;
  readonly routes: readonly Route[];
  /** Handed to the services of the areas when they get routes (S-M); nothing reads it yet. */
  readonly databases: Databases;
  /** Issues a ticket per request; after stop() a request gets 503 (S-1B-c). */
  readonly shutdown?: ShutdownCoordinator;
};
export type Running = Listener & { readonly port: number; close(): Promise<void> };

export async function startServer(options: StartOptions): Promise<Running> {
  const handle = createPipeline(options.layers, createRouter(options.routes));
  const shutdown = options.shutdown ?? createShutdownCoordinator();
  // Responses whose headers are not sent yet: once draining they say
  // Connection: close, so no client is told it may reuse the connection.
  const pending = new Map<ServerResponse, Socket>();
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
      // The contract's word and format; refuse also closes the connection.
      response.setHeader("Retry-After", "1");
      refuse(response, 503, "unavailable");
      return;
    }
    const socket = request.socket;
    const connection = connections.get(socket);
    if (connection !== undefined) {
      connection.active += 1;
      connection.served = true;
    }
    pending.set(response, socket);
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
    // The output is over once, when the last byte left the process or the
    // socket closed. The socket is watched as well, because a pipelined
    // response still queued behind another has no close of its own in every
    // Node 24 release when the client leaves.
    let outputOpen = true;
    const outputOver = () => {
      if (!outputOpen) return;
      outputOpen = false;
      pending.delete(response);
      socket.off("close", outputOver);
      socket.off("finish", outputOver);
      done();
    };
    socket.once("close", outputOver);
    response.once("close", () => {
      pending.delete(response);
      if (socket.destroyed || socket.writableLength === 0) return outputOver();
      // Writes leave in order: the callback of an empty write, or the finish
      // of an ended socket, comes after every byte before it.
      if (socket.writableEnded) socket.once("finish", outputOver);
      else socket.write("", outputOver);
    });
    void handle(request, response)
      .catch((error: unknown) => {
        console.error("request failed", error instanceof Error ? error.name : typeof error);
        if (!response.headersSent) refuse(response, 500, "internal");
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
      // Only the last accepted response on a connection says Connection:
      // close; an earlier one would close it under the pipelined ones after it.
      const last = new Map<Socket, ServerResponse>();
      // A queued pipelined response has no socket of its own yet; its request does.
      for (const [response, socket] of pending) last.set(socket, response);
      for (const response of last.values()) {
        if (!response.headersSent) response.shouldKeepAlive = false;
      }
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
