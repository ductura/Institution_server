// The HTTP server: the layers of pipeline.ts, then the router. Listening
// resolves with the bound port or rejects with the error code (EADDRINUSE, EACCES), so the
// entry point can refuse to start with a clear line instead of a stack.
import { createServer } from "node:http";

import type { Databases } from "./databases.ts";
import { createPipeline, type Layers } from "./pipeline.ts";
import { createRouter, type Route } from "./router.ts";
import { refuse } from "./security-headers.ts";

export type StartOptions = {
  readonly host: string;
  readonly port: number;
  /** One layer per step of docs/server-map.md §3, 2 to 7; the order is the pipeline's. */
  readonly layers: Layers;
  readonly routes: readonly Route[];
  /** Handed to the services of the areas when they get routes (S-M); nothing reads it yet. */
  readonly databases: Databases;
};
export type Running = { readonly port: number; close(): Promise<void> };

export async function startServer(options: StartOptions): Promise<Running> {
  const handle = createPipeline(options.layers, createRouter(options.routes));
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error("request failed", error instanceof Error ? error.name : typeof error);
      if (!response.headersSent) refuse(response, 500, "internal");
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
