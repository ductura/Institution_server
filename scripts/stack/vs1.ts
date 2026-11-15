// DAN-759: the minimal local stack of VS-1, one command.
//
//   pnpm stack:vs1 up [--env local|ci]   PostgreSQL and the server from dist/server.js
//   pnpm stack:vs1 status                state file and server health
//   pnpm stack:vs1 down                  stop what `up` started, check the ports are free
//
// Everything lives in .stack/vs1 (0700): its own PostgreSQL cluster (loopback,
// own socket), logs and state.json. Provisioning and migrations are those of
// `pnpm db:up:native`. Docker is never used; only processes recorded in
// state.json, or our own postmaster, are stopped. The fake OIDC process is
// DAN-759 b; the preloader (`/`) and web (`/app/`) are slots in config.ts.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SERVER_NODE_FLAGS } from "../build/index.ts";
import { fileStore, spawnRun, up as provision } from "../db/index.ts";
import { parseArgs, SLOTS, type StackConfig, stackConfig, stackPorts } from "./config.ts";
import { commandLine, portFree, startDetached, stopProcess, waitHealthy } from "./processes.ts";
import { clearStaleLock, takeLock } from "./lock.ts";
import * as stateFile from "./state.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = join(ROOT, ".stack", "vs1");
const STATE = join(DIR, "state.json");
const LOCK = join(DIR, "up.lock");
const PGDATA = join(DIR, "pgdata");
const SERVER = join(ROOT, "dist", "server.js");
const HEALTH = "/api/v1/health";
const SCRIPT = fileURLToPath(import.meta.url);
// pg_ctl hands -o to /bin/sh, and a Unix socket path has at most 107 bytes.
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/u;

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
  if (!existsSync(PGDATA)) {
    await must("initdb", "initdb", ["-D", PGDATA, "-U", userInfo().username, ...init]);
  }
  const options = `-p ${postgres} -k ${DIR} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700`;
  const log = join(DIR, "postgres.log");
  await must("pg_ctl start", "pg_ctl", ["-D", PGDATA, "-l", log, "-w", "start", "-o", options]);
  await provision({
    env: { ...base(), DUCTUS_NATIVE_PGPORT: String(postgres), DUCTUS_NATIVE_PGSOCKET: DIR },
    run: spawnRun,
    isRoot: false,
    store: fileStore(join(DIR, "pg-password")),
  });
  const origin = `http://127.0.0.1:${server}`;
  const argv = [...SERVER_NODE_FLAGS, SERVER];
  const pid = await startDetached(process.execPath, argv, {
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
  // The exact command line: `down` stops the pid only while it still runs this.
  state.processes.server = { pid, marker: [process.execPath, ...argv].join(" ") };
  stateFile.writeState(STATE, state);
  if (!(await waitHealthy(`${origin}${HEALTH}`, 30_000))) {
    throw new Error("the server is not healthy");
  }
  console.log(`VS-1 stack up (${config.env}): server ${origin}, PostgreSQL :${postgres}`);
  for (const [name, slot] of Object.entries(SLOTS)) {
    console.log(`  ${name} at ${slot.path}: ${slot.artifact ?? "not attached"}`);
  }
}

export async function up(config: StackConfig): Promise<void> {
  if (process.getuid?.() === 0) {
    throw new Error("run the stack as an ordinary user (initdb refuses root)");
  }
  if (stateFile.readState(STATE) !== null) {
    throw new Error("the stack is up; run pnpm stack:vs1 down");
  }
  if (!existsSync(SERVER)) throw new Error("dist/server.js is missing; run pnpm build");
  if (!SAFE_PATH.test(DIR) || `${DIR}/.s.PGSQL.${config.ports.postgres}`.length > 107) {
    throw new Error("the checkout path must be short and use only letters, digits, . _ - and /");
  }
  for (const [name, port] of Object.entries(config.ports)) {
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`);
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  takeLock(LOCK, lockOwnerRuns);
  try {
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
      // The state in memory, which holds the server pid even when writing it failed.
      await down(state).catch(() => false);
      throw error;
    });
  } finally {
    rmSync(LOCK, { force: true });
  }
}

const lockOwnerRuns = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 1 && (commandLine(pid) ?? "").includes(SCRIPT);

// pg_ctl signals whatever holds the pid in postmaster.pid; a stale file after
// a reboot may name someone else's process, so the pid must be our postmaster.
async function stopPostgres(): Promise<void> {
  let pid: number;
  try {
    pid = Number(readFileSync(join(PGDATA, "postmaster.pid"), "utf8").split("\n")[0]);
  } catch {
    return;
  }
  if (!(commandLine(pid) ?? "").includes(` -D ${PGDATA} `)) {
    console.error(`postmaster.pid names pid ${pid}, not this stack's PostgreSQL; left alone`);
    return;
  }
  await must("pg_ctl stop", "pg_ctl", ["-D", PGDATA, "-w", "stop", "-m", "fast"]);
}

/** Stops what the stack started; false when a port of the stack still answers. */
export async function down(given?: stateFile.StackState): Promise<boolean> {
  const read = given ?? stateFile.readState(STATE);
  if (read === "unreadable") console.error("state.json is unreadable; stopping PostgreSQL only");
  const state = read === "unreadable" ? null : read;
  const server = state?.processes.server;
  if (server !== undefined) {
    const result = await stopProcess(server.pid, server.marker, 10_000);
    if (result === "foreign") console.error(`server: pid ${server.pid} is not ours; left alone`);
  }
  await stopPostgres();
  let free = true;
  // Without a state the configured (or default) ports are checked, so an orphan still shows.
  for (const [name, port] of Object.entries(state?.ports ?? stackPorts(process.env))) {
    if (await portFree(port)) continue;
    console.error(`port ${port} (${name}) still answers`);
    free = false;
  }
  if (free) rmSync(STATE, { force: true });
  // A lock left by an interrupted up; a running up keeps its own.
  try {
    clearStaleLock(LOCK, lockOwnerRuns);
  } catch {
    // its owner still runs
  }
  return free;
}

async function status(): Promise<boolean> {
  const state = stateFile.readState(STATE);
  if (state === null || state === "unreadable") {
    console.log(state === null ? "VS-1 stack is down" : "state.json is unreadable");
    return false;
  }
  console.log(JSON.stringify(state, null, 2));
  return waitHealthy(`http://127.0.0.1:${state.ports.server}${HEALTH}`, 1000);
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
