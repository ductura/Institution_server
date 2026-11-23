// `pnpm lokalno` (Ductus#2028): Institution_server with a real login through
// the AAI@EduHr simulator, on Windows and Linux, in one command, without bash,
// WSL or Docker. Local development only (D-09). docs/LOKALNO.md.
//
//   pnpm lokalno              origin http://localhost:8000 (the Preloader's edge proxy)
//   pnpm lokalno --izravno    origin http://localhost:4000 (no edge; the server itself)
//
// Steps: migrations and the seed on DATABASE_URL, `pnpm build`, the fake OIDC
// provider on 8090, the server on 4000. Both run in the foreground with their
// output prefixed; Ctrl+C stops both, and so does either one ending.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  accountsFileFor,
  adminTarget,
  assertLocal,
  baseEnv,
  ensureSecrets,
  type LocalEvidence,
  PORTS,
  oidcEnv,
  serverEnv,
  stackOptions,
  type StackOptions,
  TOKEN_FILE,
} from "./config.ts";
import { provision } from "./database.ts";
import { listening, prepareEvidence, startS3 } from "./dokazi.ts";
import {
  clearSupervisorFiles,
  supervisorState,
  takeStopRequest,
  waitForStartRequest,
  writeSupervisorState,
} from "./nadzor.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Local files of this checkout, never committed (.gitignore). */
export const LOCAL_DIR = join(ROOT, ".local");

/** The flags: none or `--izravno`; anything else is an error. */
export function parseFlags(argv: readonly string[]): { direct: boolean; origin?: string } {
  const isOrigin = (arg: string): boolean => arg.startsWith("--izvor=");
  const unknown = argv.filter((arg) => arg !== "--izravno" && !isOrigin(arg));
  const origins = argv.filter(isOrigin);
  if (unknown.length > 0 || origins.length > 1)
    throw new Error("usage: pnpm lokalno [--izravno] [--izvor=http://localhost:3000]");
  const direct = argv.includes("--izravno");
  if (origins[0] === undefined) return { direct };
  // The browser's origin, set by `pnpm stog:gore` to the front (INT-01).
  let url: URL;
  try {
    url = new URL(origins[0].slice("--izvor=".length));
  } catch {
    throw new Error("--izvor is not a URL");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("--izvor must be an http URL on localhost or 127.0.0.1");
  return { direct, origin: url.origin };
}

/** DATABASE_URL from the environment, else the one line of .local/database-url. */
export function databaseUrl(env: Readonly<Record<string, string | undefined>>, dir: string) {
  const given = env.DATABASE_URL;
  if (given !== undefined && given.trim() !== "") return given;
  const file = join(dir, "database-url");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Polls `url` until it answers 200, or the child ends, or the time is up. */
async function ready(url: string, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (child.exitCode !== null) return false;
    try {
      const answer = await fetch(url, { redirect: "manual" });
      await answer.body?.cancel();
      if (answer.status === 200) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Runs `node <args>` in the root with `env`, its output prefixed with `[name]`. */
function startChild(name: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const prefix = (stream: NodeJS.WritableStream) => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
      if (line !== "") stream.write(`[${name}] ${line}\n`);
    }
  };
  child.stdout?.on("data", prefix(process.stdout));
  child.stderr?.on("data", prefix(process.stderr));
  return child;
}

function runOnce(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", () => resolve(-1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** The server's command line, the same at every start. */
export const serverArgs = (): string[] => [
  "--disallow-code-generation-from-strings",
  join(ROOT, "dist", "server.js"),
];

/** Starts the server and waits until /api/v1/health answers 200; null if it does not. */
export async function startServer(
  options: StackOptions,
  env: Record<string, string>,
): Promise<ChildProcess | null> {
  const app = startChild("server", serverArgs(), env);
  if (await ready(`http://127.0.0.1:${options.serverPort}/api/v1/health`, app, 30_000)) return app;
  app.kill();
  return null;
}

/**
 * Starts the provider, the local S3 (with `evidence`, INT-08) and the server;
 * the children run until stopped. `server` already carries the EVIDENCE_*
 * variables (serverEnv); `evidence` only says where the S3 keeps its objects.
 */
export async function startStack(
  options: StackOptions,
  server: Record<string, string>,
  base: Record<string, string>,
  evidence?: { readonly setup: LocalEvidence; readonly localDir: string },
): Promise<ChildProcess[]> {
  const oidc = startChild("oidc", [join(ROOT, "packages", "test-fakes", "oidc", "server.ts")], {
    ...base,
    ...oidcEnv(options),
  });
  const discovery = `http://127.0.0.1:${options.oidcPort}/.well-known/openid-configuration`;
  if (!(await ready(discovery, oidc, 30_000))) {
    oidc.kill();
    throw new Error("the fake OIDC provider did not start");
  }
  const children = [oidc];
  if (evidence !== undefined) {
    const s3 = startS3(ROOT, evidence.localDir, evidence.setup, base);
    for (const stream of [s3.stdout, s3.stderr])
      stream?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/u))
          if (line !== "") console.log(`[s3] ${line}`);
      });
    children.push(s3);
    if (!(await listening(evidence.setup.s3Port, s3, 30_000))) {
      for (const child of children) child.kill();
      throw new Error("the local S3 did not start");
    }
  }
  const app = await startServer(options, { ...base, ...server });
  if (app === null) {
    for (const child of children) child.kill();
    throw new Error("the server did not answer /api/v1/health with 200");
  }
  return [...children, app];
}

async function main(): Promise<void> {
  assertLocal(process.env);
  const { direct, origin } = parseFlags(process.argv.slice(2));
  const target = adminTarget(databaseUrl(process.env, LOCAL_DIR));
  const secrets = ensureSecrets(LOCAL_DIR);
  const base = baseEnv(process.env);

  await provision({ root: ROOT, target, secrets, env: base });

  console.log("Building dist/server.js.");
  if ((await runOnce([join(ROOT, "scripts", "build", "server.ts")], base)) !== 0)
    throw new Error("the build failed");

  const options = stackOptions(direct, accountsFileFor(ROOT, LOCAL_DIR, existsSync), origin);
  for (const [name, port] of [
    ["server", options.serverPort],
    ["oidc", options.oidcPort],
    ["s3", PORTS.s3],
  ] as const) {
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`);
  }
  // INT-08: the evidence storage and the receipt key, else a commit answers 503.
  const evidence = await prepareEvidence({
    root: ROOT,
    localDir: LOCAL_DIR,
    target,
    s3Port: PORTS.s3,
  });
  const serverVariables = serverEnv(options, target, secrets, evidence);
  const children = await startStack(options, serverVariables, base, {
    setup: evidence,
    localDir: LOCAL_DIR,
  });

  console.log(
    [
      "",
      "Ductura lokalno radi (samo lokalni razvoj, D-09).",
      `  Server:            http://localhost:${options.serverPort} (preglednik: ${options.origin})`,
      `  Simulator AAI@EduHr: ${options.issuer}`,
      `  Spremište dokaza:  lokalni S3 na http://127.0.0.1:${PORTS.s3}, razvojni ključ za potpis`,
      `  Prijava:           ${options.origin}/api/v1/auth/login?returnTo=/app/web/`,
      `  Token provisioninga: .local/${TOKEN_FILE}`,
      options.accountsFile === undefined
        ? "  Računi simulatora: demo računi i obrazac (domena + uloga)"
        : `  Računi simulatora: demo računi, obrazac i ${relative(ROOT, options.accountsFile)}`,
      direct ? "" : "  Bez edge proxyja na 8000 pokreni: pnpm lokalno --izravno",
      "Ctrl+C zaustavlja sve procese.",
      "",
    ].join("\n"),
  );

  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill();
    clearSupervisorFiles(LOCAL_DIR);
    process.exitCode = code;
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));

  // VS-1.13 (A06), nadzor.ts: an announced exit of the server is a planned
  // restart; the supervisor starts the same command with the same environment
  // when the test asks for it. Any other exit stops the stack as before.
  const server = children.at(-1)!;
  const record = (app: ChildProcess): void =>
    writeSupervisorState(
      LOCAL_DIR,
      supervisorState(process.pid, {
        pid: app.pid ?? 0,
        argv: [process.execPath, ...serverArgs()],
        cwd: ROOT,
      }),
    );
  const watchServer = (app: ChildProcess): void => {
    app.once("exit", () => {
      if (stopping) return;
      if (!takeStopRequest(LOCAL_DIR)) return stop(1);
      console.log("[nadzor] server stopped on request; waiting for the start request (VS-1.13).");
      void (async () => {
        const next = (await waitForStartRequest(LOCAL_DIR))
          ? await startServer(options, { ...base, ...serverVariables })
          : null;
        if (stopping) {
          next?.kill();
          return;
        }
        if (next === null) return stop(1);
        children[children.indexOf(app)] = next;
        record(next);
        watchServer(next);
        console.log(`[nadzor] server started again, PID ${next.pid}.`);
      })();
    });
  };
  for (const child of children)
    if (child !== server) child.once("exit", () => stop(stopping ? 0 : 1));
  record(server);
  watchServer(server);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`pnpm lokalno: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
