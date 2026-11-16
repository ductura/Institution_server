// The shutdown ticket of startServer (S-1B-c, DAN-778) on a real node:http
// server. Review on 132af0a: in some Node 24 releases a pipelined response
// still queued behind another gets no close event when the client leaves.
// The route below takes that event away to stand for such a release; the
// ticket must still end with the socket, so stop() drains instead of waiting
// for the deadline.
import { connect } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { createDatabases } from "./databases.ts";
import { createHealthRoute } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { createShutdownCoordinator } from "./shutdown.ts";
import { type Running, startServer } from "./start.ts";

// Health with the main database up: these tests are about the pipeline, not the database.
const HEALTH_ROUTE = createHealthRoute({
  health: async () => ({ main: "ok", logs: "ok", legal: "ok" }),
  serverVersion: "0.0.0",
});

const servers: Running[] = [];
afterAll(async () => {
  for (const server of servers) server.closeAllConnections();
});

describe("startServer shutdown tickets", () => {
  it("a response that never gets its own close event is released when the client leaves", async () => {
    const shutdown = createShutdownCoordinator({ graceMs: 5_000 });
    let finished = 0;
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: null }),
      databases: createDatabases(),
      shutdown,
      routes: [
        {
          contract: HEALTH_ROUTE.contract,
          handle: async (_request, response) => {
            response.removeAllListeners("close");
            await new Promise((resolve) => setTimeout(resolve, 100));
            finished += 1;
          },
        },
      ],
    });
    servers.push(server);

    const socket = connect(server.port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await expect.poll(() => shutdown.active()).toBe(1);

    const stopping = shutdown.stop();
    socket.destroy();
    const result = await Promise.race([
      stopping,
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 2_000)),
    ]);
    expect(result).toEqual({ outcome: "drained" });
    expect(finished).toBe(1);
  });
});
