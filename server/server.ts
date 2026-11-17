// The one entry point of the server (S-1B-a, DAN-775), built into
// dist/server.js by `pnpm build` (scripts/build). Read top to bottom it is the overview: the environment check, the
// databases, the layers, the areas whose routes are mounted, the start and the
// place for shutdown. It may import only http, settings and config
// (docs/server-map.md §2); it never opens a database connection itself.
import {
  appOrigin,
  environmentProblems,
  listenAddress,
  listenProblems,
  originProblems,
  SERVER_VERSION,
  shutdownGraceMs,
  shutdownProblems,
} from "./config/index.ts";
import {
  type AreaWithRoutes,
  createAuthRoutes,
  createClientContextRoute,
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createEvidenceReplayRouteFor,
  createSettingsValuesPutRoute,
  evidenceIngestDependencies,
  createLayers,
  createMetricsSampling,
  createShutdownCoordinator,
  createHealthRoute,
  installShutdown,
  parseTrustedProxies,
  routesOf,
  serverShutdownHooks,
  startServer,
} from "./http/index.ts";
import { metricsIntervalMs, metricsIntervalProblems } from "./settings/index.ts";

// 1. Environment. A bad value stops the start before anything listens; the
//    line names the variable, never its value. TRUSTED_PROXIES (addresses and
//    CIDR ranges) is optional; unset, X-Forwarded-For is never read.
const TRUSTED_PROXIES = parseTrustedProxies(process.env.TRUSTED_PROXIES);
const problems = [
  ...environmentProblems(process.env),
  ...listenProblems(process.env),
  ...shutdownProblems(process.env),
  ...originProblems(process.env),
  ...metricsIntervalProblems(process.env),
  ...(TRUSTED_PROXIES === null
    ? ["TRUSTED_PROXIES is not a list of addresses and CIDR ranges"]
    : []),
];

// 2. Databases. Building the registry opens nothing: server/database connects
//    on first use, one pool per database (main, logs, legal; S-1F-a), so a
//    database that is down fails only its own calls.
// 3. Layers, in the order of docs/server-map.md §3, steps 2 to 7: client IP,
//    IP rules, rate limit, traffic record, security headers, origin check.
//    The order is fixed in http (PIPELINE_STEPS); steps 3 and 5 are empty
//    until wave 5, step 4 limits requests (DAN-814). Without APP_ORIGIN every state-changing request gets 403.
const LAYERS = createLayers({
  expectedOrigin: appOrigin(process.env),
  trustedProxies: TRUSTED_PROXIES ?? [],
});

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
  const databases = createDatabases();
  // One signer and one storage per process, shared by commit and replay.
  const evidenceDeps = evidenceIngestDependencies(process.env, process.cwd());
  const shutdown = createShutdownCoordinator({ graceMs: shutdownGraceMs(process.env) });
  const running = await startServer({
    host,
    port,
    databases,
    shutdown,
    layers: LAYERS,
    routes: [
      createHealthRoute({ health: databases.health, serverVersion: SERVER_VERSION }),
      // The preloader's environment (S-1M-b, D-300); no log writer is wired
      // into the process yet, so it is checked and answered, not recorded.
      createClientContextRoute(),
      createEvidenceOpenRoute(databases.main),
      // Settings by level (S-1J-g, DAN-826): the write over settings.set_value.
      createSettingsValuesPutRoute({ writer: databases.main.settingsWriter }),
      // B-8: the development signer only under NODE_ENV development or test;
      // storage only from EVIDENCE_STORAGE_DOMAINS (503 otherwise).
      createEvidenceCommitRouteFor(databases.main, evidenceDeps),
      // DAN-818: one replay page, read from the same storage as commit writes.
      createEvidenceReplayRouteFor(databases.main, evidenceDeps),
      // Login over AAI@EduHr (S-1E-a; D-09: the fake provider only in development and test).
      ...createAuthRoutes(process.env),
      ...routesOf(AREAS),
    ],
  }).catch((error: unknown) => {
    // A system error has a code (EADDRINUSE, EACCES); anything else is a
    // programming error of the route table, whose message names no value.
    const { code, message } = error as { code?: string; message?: string };
    console.error(code === undefined ? `startup failed: ${message}` : `listen failed: ${code}`);
    process.exitCode = 1;
    return undefined;
  });
  if (running === undefined) return;

  // Metrics (S-1K.4-b, DAN-834-5a): every METRICS_INTERVAL_MS one round of
  // database_connections into metric_sample of the logs database; a failing
  // round is skipped and logged by its reason, never stopping the server.
  const metrics = createMetricsSampling({
    intervalMs: metricsIntervalMs(process.env),
    health: databases.health,
    store: databases.metricSamples,
  });
  metrics.start();

  // 5. Shutdown (S-1B-c). The first SIGTERM or SIGINT: stop accepting, finish
  //    the started requests, stop metrics (waiting for the round in progress),
  //    flush the logs, close the databases, exit 0;
  //    whatever is left at the deadline exits 1 (server/http/shutdown.ts).
  type Signal = "SIGTERM" | "SIGINT";
  const signals = {
    on: (signal: Signal, listener: () => void) => process.on(signal, listener),
    off: (signal: Signal, listener: () => void) => process.off(signal, listener),
  };
  installShutdown(signals, {
    coordinator: shutdown,
    listener: running,
    hooks: serverShutdownHooks({ metrics, databases }),
    exit: (code) => process.exit(code),
  });
  // Announced only once the signals are handled: a SIGTERM sent on this line
  // must reach installShutdown, not the default action that kills the process.
  console.log(JSON.stringify({ event: "server.listening", host, port: running.port }));
}

await main();
