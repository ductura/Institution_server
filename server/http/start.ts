// The HTTP server: the layers of pipeline.ts, then the router. Listening
// resolves with the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";

import type { Databases } from "./databases.ts";
import { createPipeline, type Layers } from "./pipeline.ts";
import { createRouter, type Route, sendJson } from "./router.ts";
import { applySecurityHeaders, refuse } from "./security-headers.ts";
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

/** Refusals one connection gets while draining; the last of them closes it (c3 contract, 6). */
const REFUSALS_PER_CONNECTION = 16;

// A request parsed on a connection whose output is not over yet.
type Exchange = { readonly response: ServerResponse };
type Connection = {
  /** Exchanges in the order they were parsed; Node answers them in this order. */
  readonly open: Exchange[];
  served: boolean;
  refused: number;
  /** The refusal that closes the connection; requests parsed after it get nothing. */
  final: Exchange | null;
  /** The response set to Connection: close at the signal, while its headers are unsent. */
  marked: ServerResponse | null;
};

export async function startServer(options: StartOptions): Promise<Running> {
  const handle = createPipeline(options.layers, createRouter(options.routes));
  const shutdown = options.shutdown ?? createShutdownCoordinator();
  // Node's closeIdleConnections (also run by http.Server.close) counts a
  // connection idle as soon as its response ended, while the body may still be
  // in the socket buffer, so shutdown ends only connections that served a
  // request and hold no exchange now.
  const connections = new Map<Socket, Connection>();
  const endIfIdle = (socket: Socket) => {
    const state = connections.get(socket);
    if (state?.served === true && state.open.length === 0) socket.end();
  };
  // Only the last exchange on a connection may say Connection: close; an
  // earlier one would close it under the pipelined ones after it.
  const unmark = (state: Connection) => {
    if (state.marked !== null && !state.marked.headersSent) state.marked.shouldKeepAlive = true;
    state.marked = null;
  };

  /**
   * Ends the exchange once, when its handler settled (pending counts it) and
   * the last byte left the process or the socket closed. The socket is watched
   * as well, because a pipelined response still queued behind another has no
   * close of its own in every Node 24 release when the client leaves.
   */
  const track = (socket: Socket, exchange: Exchange, pending: number, release: () => void) => {
    const { response } = exchange;
    let open = pending + 1;
    const done = () => {
      open -= 1;
      if (open > 0) return;
      const state = connections.get(socket);
      const at = state?.open.indexOf(exchange) ?? -1;
      if (at >= 0) state?.open.splice(at, 1);
      release();
      if (shutdown.state() !== "running") endIfIdle(socket);
    };
    let outputOpen = true;
    const outputOver = () => {
      if (!outputOpen) return;
      outputOpen = false;
      socket.off("close", outputOver);
      socket.off("finish", outputOver);
      done();
    };
    socket.once("close", outputOver);
    response.once("close", () => {
      if (socket.destroyed || socket.writableLength === 0) return outputOver();
      // Writes leave in order: the callback of an empty write, or the finish
      // of an ended socket, comes after every byte before it.
      if (socket.writableEnded) socket.once("finish", outputOver);
      else socket.write("", outputOver);
    });
    return done;
  };

  /** The 503 to a request parsed while draining (c3 contract, 5 and 6). */
  const refuseWhileDraining = (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    const state = connections.get(socket);
    if (state === undefined || state.final !== null) return;
    unmark(state);
    state.refused += 1;
    // Node would read an unread body to reach the next request; closing does not.
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] ?? "0") !== "0";
    const exchange: Exchange = { response };
    state.open.push(exchange);
    if (hasBody || state.refused >= REFUSALS_PER_CONNECTION) state.final = exchange;
    const ticket = shutdown.hold();
    track(socket, exchange, 0, () => ticket?.release());
    // Sent once it is first in line and every request already received was
    // parsed: only then is it known whether another one follows it.
    const send = () => {
      response.setHeader("Retry-After", "1");
      if (state.final === exchange || state.open.at(-1) === exchange) {
        // The contract's word and format; refuse also closes the connection.
        refuse(response, 503, "unavailable");
        return;
      }
      applySecurityHeaders(response);
      sendJson(response, 503, { error: "unavailable" });
    };
    queueMicrotask(() => {
      if (response.socket !== null) send();
      else response.once("socket", send);
    });
  };

  const server = createServer((request, response) => {
    const ticket = shutdown.begin();
    if (ticket === null) return refuseWhileDraining(request, response);
    const socket = request.socket;
    const state = connections.get(socket);
    const exchange: Exchange = { response };
    if (state !== undefined) {
      state.open.push(exchange);
      state.served = true;
    }
    // The ticket is held until the handler settled and the last byte left the
    // process (or the socket closed): a client that disconnects does not end
    // the drain under a running handler, and a large body is not cut by exit.
    const done = track(socket, exchange, 1, () => ticket.release());
    void handle(request, response)
      .catch((error: unknown) => {
        console.error("request failed", error instanceof Error ? error.name : typeof error);
        if (!response.headersSent) refuse(response, 500, "internal");
        else response.destroy();
      })
      .finally(done);
  });
  server.on("connection", (socket: Socket) => {
    connections.set(socket, { open: [], served: false, refused: 0, final: null, marked: null });
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
      for (const state of connections.values()) {
        const last = state.open.at(-1)?.response;
        if (last === undefined || last.headersSent || !last.shouldKeepAlive) continue;
        last.shouldKeepAlive = false;
        state.marked = last;
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
