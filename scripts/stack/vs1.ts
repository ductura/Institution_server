// DAN-759, DAN-787: the minimal local stack of VS-1.
//   pnpm stack:vs1 up [--env local|ci]   PostgreSQL, the fake OIDC provider, the server
//   pnpm stack:vs1 down                  stop what `up` started, check the ports are free
//   pnpm stack:vs1 status                read only: the state, the processes, health
// Everything lives in .stack/vs1 (0700): its own PostgreSQL cluster (loopback,
// own socket), logs and state.json. Provisioning and migrations are those of
// `pnpm db:up:native`. Docker is never used. The preloader and web are slots in config.ts.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SERVER_NODE_FLAGS } from "../build/index.ts";
import { fileStore, spawnRun, up as provision } from "../db/index.ts";
import {
  parseArgs,
  SAFE_PATH,
  SLOTS,
  type StackConfig,
  stackConfig,
  stackDir,
  stackPorts,
} from "./config.ts";
import {
  commandLine,
  isStackPostmaster,
  listensOn,
  portFree,
  postgresOptions,
  startDetached,
  stopProcess,
  serverReady,
} from "./processes.ts";
import * as stateFile from "./state.ts";
import {
  ensureBucketIdentity,
  ensureSeed,
  newS3Credentials,
  registerEvidenceKey,
  S3_BUCKET,
  S3_REGION,
  seedFile,
  serverEvidenceEnv,
} from "./evidence.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
// VS1_STACK_DIR moves the whole stack (tests use a temporary one); a path
// outside .stack/ or the temp dir stops every command before it reads or writes.
let dirError: Error | undefined;
const DIR = ((): string => {
  try {
    // A fixed temp root: os.tmpdir() follows TMPDIR, which the caller sets.
    return stackDir(ROOT, process.env, "/tmp", realpathSync);
  } catch (error) {
    dirError = error as Error;
    return resolve(ROOT, ".stack", "vs1");
  }
})();
const checkDir = (): void => {
  if (dirError !== undefined) throw dirError;
};
const STATE = join(DIR, "state.json");
export const LOCK = join(DIR, "up.lock");
const PGDATA = join(DIR, "pgdata");
const SERVER = join(ROOT, "dist", "server.js");
const OIDC = join(ROOT, "packages", "test-fakes", "oidc", "server.ts");
const S3 = join(ROOT, "scripts", "stack", "local-s3.ts");
// Objects of the local S3 (DAN-817): files, so they outlive a restart of the server.
const S3_ROOT = join(DIR, "s3");
// The stack directory in argv makes each marker this stack's own. down and
// status compare it with this DIR, never with what state.json says, so a
// state copied from another stack never names that stack's processes.
const TAG = `--vs1-stack=${DIR}`;
const TAILS = {
  server: ` ${SERVER} ${TAG}`,
  oidc: ` ${OIDC} ${TAG}`,
  s3: ` ${S3} ${TAG}`,
} as const;
const ofThisStack = (name: keyof typeof TAILS, marker: string): boolean =>
  marker.endsWith(TAILS[name]);
// Children get a fixed environment, never the caller's.
const base = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
});

async function must(what: string, command: string, args: string[]): Promise<void> {
  if ((await spawnRun(command, args, { env: base() })) !== 0) throw new Error(`${what} failed`);
}

/** Polls until `pid` itself listens on `port`; the local S3 has no health route. */
async function listening(pid: number, port: number, timeoutMs: number): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (listensOn(pid, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** The pid in postmaster.pid when it is this stack's running postmaster, else null. */
function ourPostmaster(): number | null {
  if (!existsSync(join(PGDATA, "postmaster.pid"))) return null;
  // postmaster.pid: pid on line 1, port on line 4.
  const lines = readFileSync(join(PGDATA, "postmaster.pid"), "utf8").split("\n");
  const [pid, port] = [Number(lines[0]), Number(lines[3])];
  return isStackPostmaster(commandLine(pid) ?? "", PGDATA, DIR, port) ? pid : null;
}

/** Before mkdir and chmod: an existing stack directory is this user's own, not a link. */
function ownDirectory(): void {
  checkDir();
  let stat;
  try {
    stat = lstatSync(DIR);
  } catch (error) {
    if (Reflect.get(error as object, "code") === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`${DIR} is not a directory of this user (or is a link)`);
  }
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

/** The whole environment of the fake provider; nothing of the caller's. */
export function oidcEnv({ ports }: StackConfig): Record<string, string> {
  const app = `http://127.0.0.1:${ports.server}`;
  return {
    ...base(),
    NODE_ENV: "test",
    PORT: String(ports.oidc),
    ISSUER: `http://127.0.0.1:${ports.oidc}`,
    REDIRECT_URI: `${app}/api/v1/auth/callback`,
    POST_LOGOUT_REDIRECT_URI: `${app}/`,
    BACKCHANNEL_LOGOUT_URI: `${app}/api/v1/auth/backchannel-logout`,
  };
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
  // DAN-817: the invented institutions, the receipt key of demo-fakultet and
  // its bucket. The seed lies outside the checkout (the signer refuses it inside).
  const seed = seedFile(DIR, ROOT, process.env.HOME ?? "");
  ensureSeed(seed);
  const institutionId = await registerEvidenceKey(
    { socket: DIR, port: postgres, env: base() },
    ROOT,
    seed,
  );
  mkdirSync(S3_ROOT, { recursive: true, mode: 0o700 });
  ensureBucketIdentity(S3_ROOT, institutionId);
  const origin = `http://127.0.0.1:${server}`;
  // D-09: the fake provider runs with NODE_ENV=test from a fixed list, on
  // loopback, sending the browser and logout tokens only to this stack's server.
  // The server is not given its issuer (that needs its own decision).
  const issuer = `http://127.0.0.1:${config.ports.oidc}`;
  const tag = TAG;
  const oidcPid = await startDetached(process.execPath, [OIDC, tag], {
    cwd: ROOT,
    log: join(DIR, "oidc.log"),
    env: oidcEnv(config),
  });
  state.processes.oidc = { pid: oidcPid, marker: `${process.execPath} ${OIDC} ${tag}` };
  stateFile.writeState(STATE, state);
  const discovery = `${issuer}/.well-known/openid-configuration`;
  if (!(await serverReady(discovery, oidcPid, config.ports.oidc, 30_000))) {
    throw new Error(`the fake OIDC provider is not ready on port ${config.ports.oidc}`);
  }
  // A new key for each up, only in the children's environment: never on disk or in argv.
  const credentials = newS3Credentials();
  const s3Pid = await startDetached(process.execPath, [S3, tag], {
    cwd: ROOT,
    log: join(DIR, "s3.log"),
    env: {
      ...base(),
      NODE_ENV: "test",
      PORT: String(config.ports.s3),
      VS1_S3_ROOT: S3_ROOT,
      VS1_S3_BUCKET: S3_BUCKET,
      VS1_S3_REGION: S3_REGION,
      EVIDENCE_S3_VS1_KEY_ID: credentials.keyId,
      EVIDENCE_S3_VS1_SECRET: credentials.secret,
    },
  });
  state.processes.s3 = { pid: s3Pid, marker: `${process.execPath} ${S3} ${tag}` };
  stateFile.writeState(STATE, state);
  if (!(await listening(s3Pid, config.ports.s3, 30_000))) {
    throw new Error(`the local S3 does not listen on port ${config.ports.s3}`);
  }
  const argv = [...SERVER_NODE_FLAGS, SERVER, tag];
  const pid = await startDetached(process.execPath, argv, {
    cwd: ROOT,
    log: join(DIR, "server.log"),
    env: {
      ...base(),
      ...serverEvidenceEnv({ institutionId, seed }, config.ports.s3, credentials),
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
  console.log(
    `VS-1 stack up (${config.env}): server ${origin}, fake OIDC ${issuer}, local S3 :${config.ports.s3}, PostgreSQL :${postgres}`,
  );
  for (const [name, slot] of Object.entries(SLOTS))
    console.log(`  ${name} at ${slot.path}: not attached`);
}

export async function up(config: StackConfig): Promise<void> {
  ownDirectory();
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
      repos: { server: stateFile.repoRevision(ROOT), preloader: null, web: null },
      versions: {
        ...stateFile.packageVersions(ROOT),
        postgres: stateFile.postgresVersion(process.env.PATH ?? ""),
      },
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
  checkDir();
  const read = given ?? stateFile.readState(STATE);
  if (read === "unreadable") console.error("state.json is unreadable; stopping PostgreSQL only");
  const state = read === "unreadable" ? null : read;
  // A process named by a state of another stack directory: never signalled, and down fails.
  let otherStack = false;
  for (const name of ["server", "s3", "oidc"] as const) {
    const entry = state?.processes[name];
    if (entry === undefined) continue;
    if (!ofThisStack(name, entry.marker)) {
      console.error(`${name}: pid ${entry.pid} is not of this stack directory; left alone`);
      otherStack = true;
      continue;
    }
    if ((await stopProcess(entry.pid, entry.marker, 10_000)) === "foreign")
      console.error(`${name}: pid ${entry.pid} is not ours; left alone`);
  }
  // pg_ctl signals whatever holds the pid in postmaster.pid; it must be ours.
  if (ourPostmaster() !== null)
    await must("pg_ctl stop", "pg_ctl", ["-D", PGDATA, "-w", "stop", "-m", "fast"]);
  else if (existsSync(join(PGDATA, "postmaster.pid")))
    console.error("postmaster.pid is not ours; left alone");
  let free = true;
  // Without a state the configured (or default) ports are checked, so an orphan still shows.
  const ports = state?.ports ?? stackPorts(process.env);
  for (const name of ["postgres", "server", "oidc", "s3"] as const) {
    const port = ports[name];
    if (await portFree(port)) continue;
    console.error(`port ${port} (${name}) still answers`);
    free = false;
  }
  if (otherStack) {
    console.error(
      "state.json names processes of another stack directory; it is kept, remove it by hand",
    );
    return false;
  }
  if (free) rmSync(STATE, { force: true });
  return free;
}

/** GET `url` once, only when `pid` itself listens on `port`; the status or a reason. */
async function probe(url: string, pid: number, port: number, get: typeof fetch): Promise<string> {
  if (!listensOn(pid, port)) return `not listening on ${port}`;
  // No redirect is followed: a Location may name any port, 3000-3004 among them.
  return get(url, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then(
    (r) => String(r.status),
    () => "no answer",
  );
}

/**
 * Reads the state and asks the processes it names; true when PostgreSQL, the
 * fake provider and the server are this stack's and both answer 200. Takes no
 * lock, creates and writes nothing, runs no git.
 */
export async function status(get: typeof fetch = fetch): Promise<boolean> {
  checkDir();
  const lock = existsSync(LOCK) ? "up.lock present, not touched" : "none";
  const read = stateFile.readState(STATE);
  if (read === null || read === "unreadable") {
    console.log(`VS-1 stack: ${read === null ? "not running" : "state.json is unreadable"}`);
    console.log(`  lock       ${lock}`);
    return false;
  }
  const { repos, ports, processes } = read;
  const rev = (r: stateFile.Revision | null | undefined): string =>
    r ? `${r.sha} (${r.dirty ? "dirty" : "clean"})` : "not attached";
  const build = !existsSync(SERVER)
    ? "dist/server.js is missing"
    : stateFile.sha256File(SERVER) === read.serverBuildSha256
      ? "dist/server.js matches the recorded sha256"
      : "dist/server.js differs from the recorded sha256";
  const postmaster = ourPostmaster();
  let ok = postmaster !== null;
  const lines = [
    `VS-1 stack (${read.env}), started ${read.startedAt}`,
    `  repos      server ${rev(repos?.server)}; preloader: ${rev(repos?.preloader)}; web: ${rev(repos?.web)}`,
    `  versions   ${Object.entries(read.versions ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `  build      ${build}`,
    `  postgres   :${ports.postgres} ${postmaster === null ? "not running" : `pid ${postmaster} running`}`,
  ];
  const paths = { oidc: "/.well-known/openid-configuration", server: "/api/v1/health" };
  for (const name of ["server", "oidc"] as const) {
    const entry = processes[name];
    const port = ports[name];
    let line = "not started";
    if (entry !== undefined) {
      const ours = ofThisStack(name, entry.marker) && commandLine(entry.pid) === entry.marker;
      const answer = ours
        ? await probe(`http://127.0.0.1:${port}${paths[name]}`, entry.pid, port, get)
        : "";
      line = ours
        ? `pid ${entry.pid} running, answers ${answer}`
        : `pid ${entry.pid} not ours or gone`;
      ok &&= answer === "200";
    } else ok = false;
    lines.push(`  ${name.padEnd(10)} :${port} ${line}`);
  }
  // The local S3 answers only signed requests: it counts when that very pid listens.
  const s3 = processes.s3;
  const s3Ours =
    s3 !== undefined && ofThisStack("s3", s3.marker) && commandLine(s3.pid) === s3.marker;
  const s3Up = s3Ours && listensOn(s3.pid, ports.s3);
  ok &&= s3Up;
  lines.push(
    `  ${"s3".padEnd(10)} :${ports.s3} ${
      s3 === undefined
        ? "not started"
        : s3Ours
          ? `pid ${s3.pid} running, ${s3Up ? "listening" : "not listening"}`
          : `pid ${s3.pid} not ours or gone`
    }`,
  );
  lines.push(`  lock       ${lock}`);
  // The state is data: control characters (ANSI escapes, line breaks) never reach the terminal.
  console.log(lines.map((line) => line.replace(/[\u0000-\u001f\u007f]/gu, "?")).join("\n"));
  return ok;
}

async function main(): Promise<void> {
  try {
    const { command, env } = parseArgs(process.argv.slice(2));
    if (command === "up") await up(stackConfig(env, process.env));
    else if (!(await (command === "down" ? down() : status()))) process.exitCode = 1;
  } catch (error) {
    console.error(`VS-1 stack: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
