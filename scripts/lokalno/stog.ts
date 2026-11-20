// `pnpm stog:gore | stog:dolje | stog:zdravlje` (INT-01): the whole local
// stack in one command: PostgreSQL (Docker) with migrations and seed,
// Institution_server, the fake OIDC provider (local only, D-09) and the
// Next.js front of the sibling folder. docs/lokalno/STOG.md.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertLocal, baseEnv, PORTS } from "./config.ts";
import { LOCAL_DIR } from "./lokalno.ts";
import {
  databaseFor,
  frontEnv,
  frontScript,
  healthTargets,
  type HealthTarget,
  loginLink,
  pidFile,
  stogOptions,
} from "./stog-config.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WINDOWS = process.platform === "win32";

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

async function alive(target: HealthTarget): Promise<boolean> {
  if (target.port !== undefined) return tcpOpen(target.port);
  try {
    const answer = await fetch(target.url as string, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    await answer.body?.cancel();
    return answer.status === (target.status ?? 200);
  } catch {
    return false;
  }
}

/** Asks every service; prints one line each; true when all answer. */
export async function health(targets: readonly HealthTarget[]): Promise<boolean> {
  let all = true;
  for (const target of targets) {
    const ok = await alive(target);
    all &&= ok;
    console.log(`${ok ? "OK    " : "NEMA  "} ${target.name}`);
  }
  return all;
}

async function waitFor(targets: readonly HealthTarget[], child: ChildProcess, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (child.exitCode !== null) return false;
    const answers = await Promise.all(targets.map(alive));
    if (answers.every(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function prefixed(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: WINDOWS,
    windowsHide: true,
  });
  const out = (stream: NodeJS.WritableStream) => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u))
      if (line !== "") stream.write(`[${name}] ${line}\n`);
  };
  child.stdout?.on("data", out(process.stdout));
  child.stderr?.on("data", out(process.stderr));
  return child;
}

function docker(args: string[]): number {
  return (
    spawnSync("docker", ["compose", ...args], { cwd: ROOT, stdio: "inherit", shell: WINDOWS })
      .status ?? 1
  );
}

async function gore(): Promise<void> {
  assertLocal(process.env);
  const options = stogOptions(ROOT, process.env);
  const base = baseEnv(process.env);
  const script = existsSync(join(options.frontDir, "package.json"))
    ? frontScript(JSON.parse(readFileSync(join(options.frontDir, "package.json"), "utf8")))
    : undefined;
  if (script === undefined)
    throw new Error(
      `no front in ${options.frontDir} (needs package.json with next:dev or dev); set STOG_FRONT_DIR`,
    );
  if (!existsSync(join(options.frontDir, "node_modules")))
    throw new Error(`run pnpm install in ${options.frontDir} first`);
  if (!options.composeDatabase && databaseFor(options, process.env) === undefined)
    throw new Error("STOG_BAZA=vanjska needs DATABASE_URL (docs/lokalno/STOG.md)");
  for (const port of [PORTS.server, PORTS.oidc, options.frontPort]) {
    if (await tcpOpen(port)) throw new Error(`port ${port} is in use; run pnpm stog:dolje`);
  }

  if (options.composeDatabase) {
    console.log("PostgreSQL (Docker): postgres-main.");
    if (docker(["up", "-d", "--build", "--wait", "postgres-main"]) !== 0)
      throw new Error("docker compose could not start postgres-main");
  }

  // The server stack: migrations, seed, build, simulator and server, with the
  // browser's origin set to the front (its /api/v1 proxy reaches the server).
  const url = databaseFor(options, process.env) as string;
  const stack = prefixed(
    "server",
    process.execPath,
    [join(ROOT, "scripts", "lokalno", "lokalno.ts"), `--izvor=${options.origin}`],
    ROOT,
    { ...base, DATABASE_URL: url },
  );
  const backend = healthTargets(options).filter((t) => t.name === "server" || t.name === "oidc");
  if (!(await waitFor(backend, stack, 300_000))) {
    stack.kill();
    throw new Error("the server stack did not come up (see [server] output above)");
  }

  const front = prefixed("front", "pnpm", [script], options.frontDir, frontEnv(options, base));
  const frontUp = healthTargets(options).filter((t) => t.name === "front");
  if (!(await waitFor(frontUp, front, 180_000))) {
    front.kill();
    stack.kill();
    throw new Error("the front did not answer on its port (see [front] output above)");
  }

  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(pidFile(LOCAL_DIR), `${process.pid}\n`);
  console.log(
    [
      "",
      "Ductura stog radi (samo lokalni razvoj, D-09).",
      `  Front:     ${options.origin}`,
      `  Prijava:   ${loginLink(options)}`,
      `  Server:    http://localhost:${PORTS.server}/api/v1/health`,
      `  Simulator: http://localhost:${PORTS.oidc}`,
      "  Provjera:  pnpm stog:zdravlje   Gašenje: Ctrl+C ili pnpm stog:dolje",
      "",
    ].join("\n"),
  );
  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const child of [front, stack]) if (child.exitCode === null) child.kill();
    rmSync(pidFile(LOCAL_DIR), { force: true });
    process.exitCode = code;
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  for (const child of [front, stack]) child.once("exit", () => stop(stopping ? 0 : 1));
}

function dolje(): void {
  const options = stogOptions(ROOT, process.env);
  const file = pidFile(LOCAL_DIR);
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    try {
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    rmSync(file, { force: true });
  }
  if (options.composeDatabase) {
    console.log("PostgreSQL (Docker): stop; podaci ostaju u volumenu.");
    docker(["stop", "postgres-main"]);
  }
  console.log("Stog je zaustavljen.");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "gore") return gore();
  if (command === "dolje") return dolje();
  if (command === "zdravlje") {
    const ok = await health(healthTargets(stogOptions(ROOT, process.env)));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  throw new Error("usage: node scripts/lokalno/stog.ts gore|dolje|zdravlje");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`pnpm stog: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
