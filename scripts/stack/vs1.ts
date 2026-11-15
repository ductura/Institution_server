// DAN-759: the minimal local stack of VS-1, one command.
//
//   pnpm stack:vs1 up [--env local|ci]   PostgreSQL and the server from dist/server.js
//   pnpm stack:vs1 status                state file and server health
//   pnpm stack:vs1 down                  stop what `up` started, check the ports are free
//
// Everything lives in .stack/vs1: its own PostgreSQL cluster (loopback, own
// socket), logs and state.json. Provisioning and migrations are those of
// `pnpm db:up:native`. Docker is never used; only processes recorded in
// state.json are stopped. The fake OIDC process is DAN-759 b; the preloader
// (`/`) and web (`/app/`) are slots in config.ts.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SERVER_NODE_FLAGS } from "../build/index.ts";
import { fileStore, spawnRun, up as provision } from "../db/index.ts";
import { parseArgs, SLOTS, type StackConfig, stackConfig } from "./config.ts";
import { portFree, startDetached, stopProcess, waitHealthy } from "./processes.ts";
import * as stateFile from "./state.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = join(ROOT, ".stack", "vs1");
const STATE = join(DIR, "state.json");
const PGDATA = join(DIR, "pgdata");
const SERVER = join(ROOT, "dist", "server.js");
const HEALTH = "/api/v1/health";

// Children get a fixed environment, never the caller's.
const base = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
});

async function must(what: string, command: string, args: string[]): Promise<void> {
  if ((await spawnRun(command, args, { env: base() })) !== 0) throw new Error(`${what} failed`);
}

async function start(config: StackConfig, state: stateFile.StackState): Promise<void> {
  const { postgres, server } = config.ports;
  const init = [
    "--auth-local=trust",
    "--auth-host=scram-sha-256",
    "-E",
    "UTF8",
    "--locale=C.UTF-8",
  ];
  if (!existsSync(PGDATA))
    await must("initdb", "initdb", ["-D", PGDATA, "-U", userInfo().username, ...init]);
  const options = `-p ${postgres} -k ${DIR} -c listen_addresses=127.0.0.1`;
  await must("pg_ctl start", "pg_ctl", [
    "-D",
    PGDATA,
    "-l",
    join(DIR, "postgres.log"),
    "-w",
    "start",
    "-o",
    options,
  ]);
  await provision({
    env: { ...base(), DUCTUS_NATIVE_PGPORT: String(postgres), DUCTUS_NATIVE_PGSOCKET: DIR },
    run: spawnRun,
    isRoot: false,
    store: fileStore(join(DIR, "pg-password")),
  });
  const origin = `http://127.0.0.1:${server}`;
  const pid = await startDetached(process.execPath, [...SERVER_NODE_FLAGS, SERVER], {
    cwd: ROOT,
    log: join(DIR, "server.log"),
    env: {
      ...base(),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(server),
      APP_ORIGIN: origin,
      APP_DATABASE_URL: `postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:${postgres}/ductus`,
    },
  });
  state.processes.server = { pid, marker: SERVER };
  stateFile.writeState(STATE, state);
  if (!(await waitHealthy(`${origin}${HEALTH}`, 30_000)))
    throw new Error("the server is not healthy");
  console.log(`VS-1 stack up (${config.env}): server ${origin}, PostgreSQL :${postgres}`);
  for (const [name, slot] of Object.entries(SLOTS)) {
    console.log(`  ${name} at ${slot.path}: ${slot.artifact ?? "not attached"}`);
  }
}

export async function up(config: StackConfig): Promise<void> {
  if (process.getuid?.() === 0)
    throw new Error("run the stack as an ordinary user (initdb refuses root)");
  if (stateFile.readState(STATE) !== null)
    throw new Error("the stack is up; run pnpm stack:vs1 down");
  if (!existsSync(SERVER)) throw new Error("dist/server.js is missing; run pnpm build");
  for (const [name, port] of Object.entries(config.ports)) {
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`);
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const state: stateFile.StackState = {
    env: config.env,
    startedAt: new Date().toISOString(),
    repo: stateFile.repoRevision(ROOT),
    versions: stateFile.packageVersions(ROOT),
    serverBuildSha256: stateFile.sha256File(SERVER),
    ports: config.ports,
    processes: {},
    pgdata: PGDATA,
  };
  stateFile.writeState(STATE, state);
  // From here on a failure stops whatever already started.
  await start(config, state).catch(async (error: unknown) => {
    await down();
    throw error;
  });
}

/** Stops what the state file names; false when a port of the stack still answers. */
export async function down(): Promise<boolean> {
  const state = stateFile.readState(STATE);
  const server = state?.processes.server;
  if (
    server !== undefined &&
    (await stopProcess(server.pid, server.marker, 10_000)) === "foreign"
  ) {
    console.error(`server: pid ${server.pid} is no longer ours; left alone`);
  }
  if (existsSync(join(PGDATA, "postmaster.pid"))) {
    await must("pg_ctl stop", "pg_ctl", ["-D", PGDATA, "-w", "stop", "-m", "fast"]);
  }
  let free = true;
  for (const [name, port] of Object.entries(state?.ports ?? {})) {
    if (await portFree(port)) continue;
    console.error(`port ${port} (${name}) still answers`);
    free = false;
  }
  if (free) rmSync(STATE, { force: true });
  return free;
}

async function status(): Promise<boolean> {
  const state = stateFile.readState(STATE);
  console.log(state === null ? "VS-1 stack is down" : JSON.stringify(state, null, 2));
  return state !== null && waitHealthy(`http://127.0.0.1:${state.ports.server}${HEALTH}`, 1000);
}

async function main(): Promise<void> {
  try {
    const { command, env } = parseArgs(process.argv.slice(2));
    if (command === "up") await up(stackConfig(env, process.env));
    else if (!(command === "down" ? await down() : await status())) process.exitCode = 1;
  } catch (error) {
    console.error(`VS-1 stack: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
