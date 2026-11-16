// Test entry of the shutdown integration test only (S-1B-c, DAN-778): the
// same startServer and installShutdown as server/server.ts, with one slow
// route, because the real entry has no route that takes time. Not built, not
// exported, never run outside tests. Invented values only.
// Arguments: <slow ms> <hook>; the deadline is SHUTDOWN_GRACE_MS.
//   slow ms  how long GET /api/v1/health?slow takes before it answers; when
//            it is done it writes {"event":"route.done"} to stdout
//   ?big     answers a 5 MB body at once, larger than any socket buffer
//   hook     "ok" (default), "throw" or "hang": a hook after the logs
import {
  createDatabases,
  createLayers,
  createShutdownCoordinator,
  FLUSH_LOGS,
  createHealthRoute,
  installShutdown,
  type ShutdownHook,
  startServer,
} from "../../server/http/index.ts";

const HEALTH_ROUTE = createHealthRoute({
  health: async () => ({ main: "ok", logs: "ok", legal: "ok" }),
  serverVersion: "0.0.0",
});

const [slowArgument = "0", hookArgument = "ok"] = process.argv.slice(2);
const slowMs = Number(slowArgument);
const graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? "8000");
const HOOKS: Record<string, ShutdownHook> = {
  ok: { name: "databases", run: () => undefined },
  throw: {
    name: "databases",
    run: () => {
      throw new TypeError("invented-hook-secret-5d1c");
    },
  },
  hang: { name: "databases", run: () => new Promise<void>(() => undefined) },
};
const hook = HOOKS[hookArgument] ?? HOOKS.ok;
const BIG_BYTES = 5 * 1024 * 1024;

const shutdown = createShutdownCoordinator({ graceMs });
const running = await startServer({
  host: "127.0.0.1",
  port: 0,
  databases: createDatabases(),
  layers: createLayers({ expectedOrigin: null }),
  shutdown,
  routes: [
    {
      contract: HEALTH_ROUTE.contract,
      handle: async (request, response) => {
        if (request.url?.endsWith("?big")) {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("x".repeat(BIG_BYTES));
          return;
        }
        if (request.url?.endsWith("?slow")) {
          await new Promise((r) => setTimeout(r, slowMs));
          console.log(JSON.stringify({ event: "route.done" }));
        }
        await HEALTH_ROUTE.handle(request, response);
      },
    },
  ],
});
installShutdown(process, {
  coordinator: shutdown,
  listener: running,
  hooks: hook === undefined ? [FLUSH_LOGS] : [FLUSH_LOGS, hook],
  exit: (code) => process.exit(code),
});
console.log(JSON.stringify({ event: "server.listening", port: running.port }));
