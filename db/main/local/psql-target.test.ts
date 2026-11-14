// DAN-324: the native psql target of the db/main/local scripts. Ported from
// Ductus db/local/psql-target.test.mjs at d52a92c3 (S-0.14, DAN-727): same
// assertions, node:test replaced by vitest, compose service `postgres` renamed
// `postgres-main`. The assertions on evidence-signing-key and
// evidence-storage-domain come with those two runners in S-0.19, because they
// import the signer and S3 adapters (Ductus src/adapters/crypto and
// src/adapters/evidence) that S-0.19 ports; until then dockerExecArgs, which
// they called, is asserted directly with the same inputs.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, test } from "vitest";

import { loadInvocation, main as loadK3, PSQL_ARGS } from "./demo-k3.ts";
import { dockerExecArgs, nativePsqlTarget, type Env, type PsqlTarget } from "./psql-target.ts";

const CONNECTION = ["-p", "54329", "-U", "ductus", "-d", "ductus"];
const K3_SQL = fileURLToPath(new URL("./demo-k3.sql", import.meta.url));

// Stands in for psql: a node script that records its argv, stdin and the PG*
// variables it was given, and prints the given line. Record path and line come
// through the environment, so the target's args stay what a real psql gets.
const FAKE_PSQL = `
  import { writeFileSync } from "node:fs";
  const argv = process.argv.slice(2);
  const pg = Object.keys(process.env).filter((name) => name.toUpperCase().startsWith("PG")).sort();
  let stdin = "";
  process.stdin.on("data", (chunk) => (stdin += chunk));
  process.stdin.on("end", () => {
    writeFileSync(process.env.FAKE_PSQL_RECORD, JSON.stringify({ argv, stdin, pg }));
    process.stdout.write(process.env.FAKE_PSQL_LINE + "\\n");
  });`;

// libpq variables that could choose a host, in the caller's environment.
const HOSTILE_PG: Env = Object.fromEntries([
  ["PGHOST", "127.0.0.1"],
  ["PGHOSTADDR", "127.0.0.1"],
  ["pghostaddr", "127.0.0.1"],
  ["PGSERVICE", "x"],
  ["PGSERVICEFILE", "/tmp/x"],
]);

type Recorded = { argv: string[]; stdin: string; pg: string[] };
type FakeContext = {
  dir: string;
  target: PsqlTarget;
  record: string;
  read: () => Promise<Recorded>;
  fakeEnv: Env;
};

// Windows starts only a real executable, not a script with a #! line (DAN-336).
// So the scripts' own spawn runs the fake through node: a call whose command is
// exactly the target's command becomes `node <fake> <args>` with the same args,
// stdin and environment; any other command is spawned unchanged and, not being
// psql, fails the test with "could not start psql".
const FAKES = new Set<string>();
const realSpawn = childProcess.spawn;
beforeAll(() => {
  const fakeSpawn = (
    command: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ): childProcess.ChildProcess =>
    FAKES.has(command)
      ? realSpawn(process.execPath, [command, ...args], options)
      : realSpawn(command, args, options);
  childProcess.spawn = fakeSpawn as typeof childProcess.spawn;
  syncBuiltinESMExports();
});
afterAll(() => {
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
});

async function withFakePsql(
  line: string,
  run: (context: FakeContext) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ductus-psql-target-"));
  const fake = join(dir, "fake-psql.mjs");
  try {
    const record = join(dir, "record.json");
    await writeFile(fake, FAKE_PSQL);
    FAKES.add(fake);
    const target = { command: fake, args: ["-h", dir, ...CONNECTION] };
    const fakeEnv: Env = {
      ...Object.fromEntries([
        ["FAKE_PSQL_RECORD", record],
        ["FAKE_PSQL_LINE", line],
        ["PGPASSWORD", "invented"],
      ]),
      ...HOSTILE_PG,
    };
    const read = async (): Promise<Recorded> =>
      JSON.parse(await readFile(record, "utf8")) as Recorded;
    await run({ dir, target, record, read, fakeEnv });
  } finally {
    FAKES.delete(fake);
    await rm(dir, { recursive: true, force: true });
  }
}

const withEnv = (entries: [string, string][]): Env => Object.fromEntries(entries);

test("a native target names one absolute socket directory, POSIX or Windows", () => {
  for (const socket of [
    "/tmp/ductus-socket",
    "C:\\Users\\demo\\AppData\\Local\\Ductus\\native-data\\socket",
  ]) {
    const args = ["-h", socket, ...CONNECTION];
    const target = nativePsqlTarget({ command: "psql", args });
    assert.deepEqual(target, { command: "psql", args, env: {} });
    args.push("-c", "changed later");
    assert.equal(target.args.length, 8, "the target is a copy");
  }
});

test("a native target that could reach TCP or is malformed is refused", () => {
  const refused: unknown[] = [
    undefined,
    null,
    { command: "", args: ["-h", "/tmp/s"] },
    { command: "psql", args: "-h /tmp/s" },
    { command: "psql", args: ["-h", "/tmp/s", 5432] },
    { command: "psql", args: CONNECTION },
    { command: "psql", args: ["-h", "127.0.0.1", ...CONNECTION] },
    { command: "psql", args: ["-h", "localhost", ...CONNECTION] },
    { command: "psql", args: ["-h", "relative/socket", ...CONNECTION] },
    { command: "psql", args: ["-h"] },
    { command: "psql", args: ["-h", "/tmp/s", "-h", "/tmp/t"] },
    { command: "psql", args: ["-h", "/tmp/s", "--host=127.0.0.1"] },
    { command: "psql", args: ["-h", "/tmp/s", "-h127.0.0.1"] },
    { command: "psql", args: ["-h", "/tmp/s", "-d", "host=127.0.0.1 dbname=ductus"] },
    { command: "psql", args: ["-h", "/tmp/s", "-d", "postgres://ductus@127.0.0.1:54329/ductus"] },
    // Review 804, finding 1: hostaddr in a conninfo and joined short options.
    { command: "psql", args: ["-h", "/tmp/s", "-d", "hostaddr=127.0.0.1 dbname=ductus"] },
    { command: "psql", args: ["-h", "/tmp/s", "-Xh", "127.0.0.1"] },
    { command: "psql", args: ["-h", "/tmp/s", "--dbname=hostaddr=127.0.0.1"] },
    { command: "psql", args: ["-h", "/tmp/s", "-d", "service=demo"] },
    { command: "psql", args: ["-h", "/tmp/s,127.0.0.1", ...CONNECTION] },
    { command: "psql", args: ["-h", "\\\\server\\share", ...CONNECTION] },
    { command: "psql", args: ["-h", "/tmp/s", "-p", "5432,5433"] },
    { command: "psql", args: ["-h", "/tmp/s", "-p", "65536"] },
    { command: "psql", args: ["-h", "/tmp/s", "-U", "postgres"] },
    { command: "psql", args: ["-h", "/tmp/s", "-p", "1", "-p", "2"] },
    { command: "psql", args: ["-h", "/tmp/s", "-c", "SELECT 1"] },
    { command: "psql", args: ["-h", "/tmp/s", "-p"] },
  ];
  for (const psql of refused) assert.throws(() => nativePsqlTarget(psql), /psql target/);
});

test("without a native target every script keeps its docker invocation", () => {
  assert.deepEqual(loadInvocation(undefined), { command: "docker", args: [...PSQL_ARGS] });
  assert.deepEqual(PSQL_ARGS, [
    "compose",
    "exec",
    "-T",
    "postgres-main",
    "psql",
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "ductus",
    "-d",
    "ductus",
  ]);
  // Ductus asserted this prefix through evidence-signing-key and
  // evidence-storage-domain, with the same environment (S-0.19 ports them).
  const env = withEnv([
    ["DUCTUS_PSQL", "psql"],
    ["PSQL", "psql"],
    ["PGHOST", "127.0.0.1"],
  ]);
  assert.deepEqual(dockerExecArgs(env), ["compose", "exec", "-T", "postgres-main"]);
});

test("DUCTUS_PSQL_CONTAINER still names a container and nothing else", () => {
  assert.deepEqual(dockerExecArgs(withEnv([["DUCTUS_PSQL_CONTAINER", "ductus-test-db"]])), [
    "exec",
    "-i",
    "ductus-test-db",
  ]);
  for (const bad of ["", "-rm", "a b", "x;y"]) {
    assert.throws(
      () => dockerExecArgs(withEnv([["DUCTUS_PSQL_CONTAINER", bad]])),
      /container name/,
    );
  }
});

test("a native target runs without the PG* variables that could choose a host", () => {
  const env: Env = {
    ...withEnv([["PATH", "/usr/bin"]]),
    ...HOSTILE_PG,
    ...withEnv([
      ["PGPASSWORD", "invented"],
      ["pgpassfile", "/tmp/pass"],
    ]),
  };
  const target = nativePsqlTarget({ command: "psql", args: ["-h", "/tmp/s"] }, env);
  assert.deepEqual(
    target.env,
    withEnv([
      ["PATH", "/usr/bin"],
      ["PGPASSWORD", "invented"],
      ["pgpassfile", "/tmp/pass"],
    ]),
  );
  assert.equal(
    loadInvocation({ command: "psql", args: ["-h", "/tmp/s"] }, env).env?.["pghostaddr"],
    undefined,
  );
});

test("with a native target the connection comes first, then -X so no psqlrc is read, then the script's options", () => {
  const psql = {
    command: "C:\\pg\\bin\\psql.exe",
    args: ["-h", "C:\\Ductus\\socket", ...CONNECTION],
  };
  const env = withEnv([["DUCTUS_PSQL_CONTAINER", "ignored-for-native"]]);
  assert.deepEqual(loadInvocation(psql, env), {
    command: psql.command,
    args: [...psql.args, "-X", "-q", "-v", "ON_ERROR_STOP=1"],
    env,
  });
});

test("the K-3 script loads its SQL through the native target and takes no argument", async () => {
  await withFakePsql("", async ({ dir, target, record, read, fakeEnv }) => {
    const env = { ...fakeEnv, ...withEnv([["NODE_ENV", "test"]]) };
    await assert.rejects(loadK3(env, ["--institution", "x"], target), /takes no argument/);
    assert.equal(existsSync(record), false);
    await loadK3(env, [], target);
    const { argv, stdin, pg } = await read();
    assert.deepEqual(pg, ["PGPASSWORD"]);
    assert.deepEqual(argv, ["-h", dir, ...CONNECTION, "-X", "-q", "-v", "ON_ERROR_STOP=1"]);
    assert.equal(stdin, await readFile(K3_SQL, "utf8"));
  });
});

test("a refused native target starts nothing", async () => {
  await withFakePsql("", async ({ dir, target, record, fakeEnv }) => {
    const refused = [
      ["-h", "127.0.0.1", ...CONNECTION],
      ["-h", dir, "-d", "hostaddr=127.0.0.1 dbname=ductus"],
      ["-h", dir, "-Xh", "127.0.0.1"],
    ];
    for (const args of refused) {
      const tcp = { command: target.command, args };
      await assert.rejects(
        loadK3({ ...fakeEnv, ...withEnv([["NODE_ENV", "test"]]) }, [], tcp),
        /psql target/,
      );
      assert.equal(existsSync(record), false);
    }
  });
});

test("production refuses every script before a target is judged", async () => {
  const psql = { command: "psql", args: ["-h", "/tmp/s"] };
  await assert.rejects(
    loadK3(withEnv([["NODE_ENV", "production"]]), [], psql),
    /refused in production/,
  );
});
