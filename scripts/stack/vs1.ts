// DAN-759: the minimal local stack of VS-1.
//   pnpm stack:vs1 up [--env local|ci]   PostgreSQL and the server from dist/server.js
//   pnpm stack:vs1 down                  stop what `up` started, check the ports are free
// Everything lives in .stack/vs1 (0700): its own PostgreSQL cluster (loopback,
// own socket), logs and state.json. Provisioning and migrations are those of
// `pnpm db:up:native`. Docker is never used. The fake OIDC process and `status`
// are DAN-787; the preloader and web are slots in config.ts.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SERVER_NODE_FLAGS } from "../build/index.ts";
import { fileStore, spawnRun, up as provision } from "../db/index.ts";
import { parseArgs, SLOTS, type StackConfig, stackConfig, stackPorts } from "./config.ts";
import {
  commandLine,
  isStackPostmaster,
  portFree,
  postgresOptions,
  startDetached,
  stopProcess,
  serverReady,
} from "./processes.ts";
import * as stateFile from "./state.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = join(ROOT, ".stack", "vs1");
const STATE = join(DIR, "state.json");
export const LOCK = join(DIR, "up.lock");
const PGDATA = join(DIR, "pgdata");
const SERVER = join(ROOT, "dist", "server.js");
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

/** The pid in postmaster.pid when it is this stack's running postmaster, else null. */
function ourPostmaster(): number | null {
  if (!existsSync(join(PGDATA, "postmaster.pid"))) return null;
  // postmaster.pid: pid on line 1, port on line 4.
  const lines = readFileSync(join(PGDATA, "postmaster.pid"), "utf8").split("\n");
  const [pid, port] = [Number(lines[0]), Number(lines[3])];
  return isStackPostmaster(commandLine(pid) ?? "", PGDATA, DIR, port) ? pid : null;
}

/** Run under the lock: refuses to start over a stack that runs, or a busy port. */
async function preflight(config: StackConfig): Promise<void> {
  if (stateFile.readState(STATE) !== null)
    throw new Error("the stack is up; run pnpm stack:vs1 down");
  if (ourPostmaster() !== null)
    throw new Error("the stack's PostgreSQL runs; run pnpm stack:vs1 down");
  if (process.getuid?.() === 0)
    throw new Error("run the stack as an ordinary user (initdb refuses root)");
  if (!existsSync(SERVER)) throw new Error("dist/server.js is missing; run pnpm build");
  if (!SAFE_PATH.test(DIR) || `${DIR}/.s.PGSQL.${config.ports.postgres}`.length > 107) {
    throw new Error("the checkout path must be short and use only letters, digits, . _ - and /");
  }
  for (const [name, port] of Object.entries(config.ports)) {
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`);
  }
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
  const options = postgresOptions(postgres, DIR);
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
  const env = { ...base(), DUCTUS_NATIVE_PGPORT: String(postgres), DUCTUS_NATIVE_PGSOCKET: DIR };
  await provision({
    env,
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
  // Ready only when the answer comes from this server, not from another
  // process on the port; otherwise the rollback stops this one.
  if (!(await serverReady(`${origin}/api/v1/health`, pid, server, 30_000))) {
    throw new Error(`the server is not healthy, or port ${server} is answered by another process`);
  }
  console.log(`VS-1 stack up (${config.env}): server ${origin}, PostgreSQL :${postgres}`);
  for (const [name, slot] of Object.entries(SLOTS))
    console.log(`  ${name} at ${slot.path}: not attached`);
}

export async function up(config: StackConfig): Promise<void> {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  // One up at a time: O_EXCL. A lock left by an interrupted up is never taken over.
  try {
    writeFileSync(LOCK, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
    throw new Error(
      `${LOCK} exists: another up runs, or one was interrupted. If none runs, run pnpm stack:vs1 down, then delete the lock by hand.`,
    );
  }
  try {
    await preflight(config);
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
    // A failure stops what this call started: the state in memory holds the
    // server pid even when writing it failed.
    await start(config, state).catch(async (error: unknown) => {
      await down(state).catch(() => false);
      throw error;
    });
  } finally {
    rmSync(LOCK, { force: true });
  }
}

/** Stops what the stack started; false when a port of the stack still answers. */
export async function down(given?: stateFile.StackState): Promise<boolean> {
  const read = given ?? stateFile.readState(STATE);
  if (read === "unreadable") console.error("state.json is unreadable; stopping PostgreSQL only");
  const state = read === "unreadable" ? null : read;
  const server = state?.processes.server;
  if (
    server !== undefined &&
    (await stopProcess(server.pid, server.marker, 10_000)) === "foreign"
  ) {
    console.error(`server: pid ${server.pid} is not ours; left alone`);
  }
  // pg_ctl signals whatever holds the pid in postmaster.pid; it must be ours.
  if (ourPostmaster() !== null)
    await must("pg_ctl stop", "pg_ctl", ["-D", PGDATA, "-w", "stop", "-m", "fast"]);
  else if (existsSync(join(PGDATA, "postmaster.pid")))
    console.error("postmaster.pid is not ours; left alone");
  let free = true;
  // Without a state the configured (or default) ports are checked, so an orphan still shows.
  for (const [name, port] of Object.entries(state?.ports ?? stackPorts(process.env))) {
    if (await portFree(port)) continue;
    console.error(`port ${port} (${name}) still answers`);
    free = false;
  }
  if (free) rmSync(STATE, { force: true });
  return free;
}

async function main(): Promise<void> {
  try {
    const { command, env } = parseArgs(process.argv.slice(2));
    if (command === "up") await up(stackConfig(env, process.env));
    else if (!(await down())) process.exitCode = 1;
  } catch (error) {
    console.error(`VS-1 stack: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
