// The HTTP server: the layers of pipeline.ts, then the router. Listening
// resolves with the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";

import { createClientErrorListeners } from "./client-error.ts";
import type { Databases } from "./databases.ts";
import { createPipeline, type Layers } from "./pipeline.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import type { LogWriter } from "../log/index.ts";
import { createServerErrorReporter } from "./error-catalog.ts";
import { createRouter, type Route } from "./router.ts";
import { answerInternal, applySecurityHeaders, refuse } from "./security-headers.ts";
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
  /**
   * The log service (S-1K.3-a); without it an uncaught error is the stderr
   * line server_error. Its writes are never awaited by a request (S-1K.3-b).
   */
  readonly log?: LogWriter;
};
export type Running = Listener & { readonly port: number; close(): Promise<void> };

/** Refusals one connection gets while draining; the last of them closes it (c3 contract, 6). */
const REFUSALS_PER_CONNECTION = 16;

/**
 * How long a closing connection is still read after its last byte left, so
 * that a request the client sent meanwhile is read instead of reset.
 */
const LINGER_MS = 1_000;

// A request parsed on a connection whose output is not over yet.
type Exchange = { readonly response: ServerResponse; over?: () => void };
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
  const report = createServerErrorReporter(options.log);
  const handle = createPipeline(options.layers, createRouter(options.routes, report), report);
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
      if (shutdown.state() === "running") return release();
      endIfIdle(socket);
      if (socket.destroyed || !socket.writableEnded) return release();
      // Lingering close: a reset would also drop bytes the kernel still holds
      // for the client, so the connection is read until the client closes it.
      const lingered = () => {
        clearTimeout(timer);
        socket.off("close", lingered);
        release();
      };
      const timer = setTimeout(lingered, LINGER_MS);
      socket.once("close", lingered);
      socket.resume();
    };
    let outputOpen = true;
    const outputOver = () => {
      if (!outputOpen) return;
      outputOpen = false;
      socket.off("finish", outputOver);
      done();
    };
    // One close listener per connection calls this (the connection handler).
    exchange.over = outputOver;
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
    // After the last answer the connection is only read until it closes.
    if (state === undefined || state.final !== null || socket.writableEnded) return;
    unmark(state);
    state.refused += 1;
    // Node would read an unread body to reach the next request; closing does not.
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? "0") !== 0;
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
      // writeJson states the length, so an HTTP/1.0 keep-alive request stays open as well.
      sendProblem(response, 503, "unavailable");
    };
    // One turn of the event loop reads what the kernel already holds for
    // this socket: Node may have resumed reading only now (backpressure).
    const later = () => setImmediate(() => setImmediate(send));
    if (response.socket !== null) later();
    else response.once("socket", later);
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
        report("request", error, requestIdOf(response));
        answerInternal(response);
      })
      .finally(done);
  });
  // Node's header count limit (maxHeadersCount) silently drops later headers
  // on some versions, which could hide the X-Forwarded-For a trusted proxy
  // appended after forged ones (Codex on DAN-790). Without a count only the
  // byte limit (maxHeaderSize, 431) bounds the headers, and none is dropped.
  server.maxHeadersCount = 0;
  // A request the parser refuses: the contract's 400 for a bad Content-Length,
  // Node's own answer for anything else (client-error.ts).
  const parseErrors = createClientErrorListeners(options.routes);
  server.on("connection", parseErrors.connection);
  server.on("clientError", parseErrors.clientError);
  server.on("connection", (socket: Socket) => {
    connections.set(socket, { open: [], served: false, refused: 0, final: null, marked: null });
    socket.once("close", () => {
      const state = connections.get(socket);
      connections.delete(socket);
      for (const exchange of [...(state?.open ?? [])]) exchange.over?.();
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
      for (const state of connections.values()) {
        const last = state.open.at(-1)?.response;
        if (last === undefined || last.headersSent || !last.shouldKeepAlive) continue;
        last.shouldKeepAlive = false;
        state.marked = last;
      }
      // Node destroys a socket after a response that closes it, which resets
      // it when a pipelined request is still unread; without destroySoon it
      // ends the socket instead (_http_server.js resOnFinish).
      for (const socket of connections.keys()) {
        Object.defineProperty(socket, "destroySoon", { value: undefined });
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
