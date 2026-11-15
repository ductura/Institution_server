// The one entry point of the server (S-1B-a, DAN-775); part a2 builds it
// into dist/server.js. Read top to bottom it is the overview: the environment check, the
// databases, the layers, the areas whose routes are mounted, the start and the
// place for shutdown. It may import only http, settings and config
// (docs/server-map.md §2); it never opens a database connection itself.
import {
  appOrigin,
  environmentProblems,
  listenAddress,
  listenProblems,
  originProblems,
} from "./config/index.ts";
import {
  type AreaWithRoutes,
  createDatabases,
  HEALTH_ROUTE,
  createLayers,
  routesOf,
  startServer,
} from "./http/index.ts";

// 1. Environment. A bad value stops the start before anything listens; the
//    line names the variable, never its value.
const problems = [
  ...environmentProblems(process.env),
  ...listenProblems(process.env),
  ...originProblems(process.env),
];

// 2. Databases. Building the registry opens nothing: server/database connects
//    on first use. S-1F-a adds the logs and legal databases.
// 3. Layers, in the order of docs/server-map.md §3, steps 2 to 7: client IP,
//    IP rules, rate limit, traffic record, security headers, origin check.
//    The order is fixed in http (PIPELINE_STEPS); steps 2 to 5 are empty
//    until wave 5. Without APP_ORIGIN every state-changing request gets 403.
const LAYERS = createLayers({ expectedOrigin: appOrigin(process.env) });

// 4. Areas whose routes are mounted. Every server/<area>/routes.ts is named
//    here (server/server.test.ts); test-server mounts its own.
const AREAS: readonly AreaWithRoutes[] = [
  "traffic",
  "metrics",
  "settings",
  "roles",
  "legal",
  "backup",
  "deletion",
  "downloads",
  "external/email",
];

async function main(): Promise<void> {
  if (problems.length > 0) {
    for (const problem of problems) console.error(`startup refused: ${problem}`);
    process.exitCode = 1;
    return;
  }
  const { host, port } = listenAddress(process.env);
  const running = await startServer({
    host,
    port,
    databases: createDatabases(),
    layers: LAYERS,
    routes: [HEALTH_ROUTE, ...routesOf(AREAS)],
  }).catch((error: unknown) => {
    // A system error has a code (EADDRINUSE, EACCES); anything else is a
    // programming error of the route table, whose message names no value.
    const { code, message } = error as { code?: string; message?: string };
    console.error(code === undefined ? `startup failed: ${message}` : `listen failed: ${code}`);
    process.exitCode = 1;
    return undefined;
  });
  if (running === undefined) return;
  console.log(JSON.stringify({ event: "server.listening", host, port: running.port }));

  // 5. Shutdown. S-1B-c attaches SIGTERM and draining here, through
  //    running.close(). Until then SIGTERM ends the process (Node default).
}

await main();
