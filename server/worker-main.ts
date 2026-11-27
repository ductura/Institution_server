// The entry point of the worker process (F4-PM2-R01B, D-71, D-102), built into
// dist/worker.js by `pnpm build` next to dist/server.js. It starts the three
// workers (receipt signing, reconstruction checkpoints, submission verdicts)
// built by the composition in server/http/worker-composition.ts and stops
// them on SIGTERM or SIGINT. The web process never starts a worker. Like
// server.ts it may import only http, settings and config (docs/server-map.md §2).
import { EXIT_CONFIGURATION, shutdownGraceMs } from "./config/index.ts";
import {
  createWorkerProcess,
  logStartupFailed,
  logStartupRefused,
  workerEnvironmentProblems,
} from "./http/index.ts";
import { kmsProblems } from "./settings/index.ts";

async function main(): Promise<void> {
  // An unusable KMS setting would leave a refusing signer: refuse the start instead, as the web entry does.
  const problems = [...workerEnvironmentProblems(process.env), ...kmsProblems(process.env)];
  if (problems.length > 0) {
    // One structured line per problem, naming the variable and never a value, then EX_CONFIG.
    logStartupRefused(problems);
    process.exitCode = EXIT_CONFIGURATION;
    return;
  }
  const worker = createWorkerProcess(process.env, process.cwd());
  worker.start();

  // The first signal stops the workers (each waits for its running pass) and
  // closes the pool, then exits 0; whatever is left at the deadline exits 1.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), shutdownGraceMs(process.env));
    deadline.unref();
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logStartupFailed(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(JSON.stringify({ event: "worker.started" }));
}

await main().catch((error: unknown) => {
  logStartupFailed(error);
  process.exitCode = 1;
});
