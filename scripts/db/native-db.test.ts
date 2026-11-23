// DAN-521 (#1516): db:up:native and test:db:native without a PostgreSQL; F-215 hardening.
// Ported from Ductus scripts/db/native-db.test.mjs at d52a92c3 (S-0.14,
// DAN-727): same assertions, node:test replaced by vitest; the paths are
// db/main/local, db/main/migrations (dbmate gets --migrations-dir) and
// db/main/tests, the compose service is postgres-main, and the file runs in
// the vitest unit project instead of Ductus `test:local`.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import {
  AUTH_PASSWORD_VAR,
  BOOTSTRAP_PASSWORD_VAR,
  BOOTSTRAP_SQL,
  childEnv,
  dbmateUrl,
  filesOfShard,
  fileStore,
  listTestFiles,
  loginPassword,
  nativeConfig,
  parseShard,
  pgProveArgs,
  READY_ATTEMPTS,
  ROLE_MARKER,
  shardTestFiles,
  TESTS_DIR,
  testDb,
  up,
  WORKER_PASSWORD_VAR,
  type Env,
  type NativeConfig,
  type PasswordStore,
  type RunOptions,
  type TestFile,
} from "./native-db.ts";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as {
  scripts: Record<string, string>;
};
const DEFAULT: NativeConfig = {
  host: "127.0.0.1",
  port: "5432",
  socket: "/var/run/postgresql",
  user: "ductus",
  database: "ductus",
};
const LOGIN = "l".repeat(32);
// DAN-666: invented values that look like credentials are put together at run time, so a secret scanner does not read them as real ones.
const WITH_RESERVED = ["p@ss", "word with spaces"].join(":/?#");
const ENCODE_ME = ["a", "@", "b", "/", "c", "?", "d", "#", "e"].join("");
const quiet = (): void => {};

type MemoryStore = PasswordStore & { value: string | null; writes: number };
type Call = { command: string; args: string[]; options: RunOptions };

/** An in-memory password store. */
function memoryStore(value: string | null = null): MemoryStore {
  const store: MemoryStore = {
    value,
    writes: 0,
    read: () => store.value,
    write: (next) => {
      store.value = next;
      store.writes += 1;
    },
  };
  return store;
}

/** A run that records every call and answers with `answer(command, args)`. */
function recorder(answer: (command: string, args: string[]) => number = () => 0) {
  const calls: Call[] = [];
  const run = async (
    command: string,
    args: string[],
    options: RunOptions = {},
  ): Promise<number> => {
    calls.push({ command, args, options });
    return answer(command, args);
  };
  return { calls, run };
}

const sqlFile = (call: Call): string | undefined =>
  call.options.stdinFile?.replaceAll("\\", "/").split("/").slice(-4).join("/");
const envOf = (call: Call | undefined): Env => call?.options.env ?? {};

test("the defaults are the local loopback cluster", () => {
  assert.deepEqual(nativeConfig({}), DEFAULT);
});

test("connection settings: every input class is accepted or refused", () => {
  const field: Record<string, keyof NativeConfig> = {
    DUCTUS_NATIVE_PGHOST: "host",
    DUCTUS_NATIVE_PGPORT: "port",
    DUCTUS_NATIVE_PGSOCKET: "socket",
    DUCTUS_NATIVE_PGUSER: "user",
    DUCTUS_NATIVE_PGDATABASE: "database",
  };
  const accepted: [string, string][] = [
    ["DUCTUS_NATIVE_PGHOST", "localhost"],
    ["DUCTUS_NATIVE_PGHOST", "::1"],
    ["DUCTUS_NATIVE_PGHOST", "127.0.0.1"],
    ["DUCTUS_NATIVE_PGPORT", "1"],
    ["DUCTUS_NATIVE_PGPORT", "54329"],
    ["DUCTUS_NATIVE_PGPORT", "65535"],
    ["DUCTUS_NATIVE_PGSOCKET", "/tmp"],
    ["DUCTUS_NATIVE_PGSOCKET", "/run/postgresql"],
    ["DUCTUS_NATIVE_PGUSER", "dx_test"],
    ["DUCTUS_NATIVE_PGUSER", "postgresx"],
    ["DUCTUS_NATIVE_PGDATABASE", "_d1"],
  ];
  for (const [name, value] of accepted) {
    assert.equal(
      nativeConfig({ [name]: value })[field[name] as keyof NativeConfig],
      value,
      `${name}=${value}`,
    );
  }

  const refused: [string, string][] = [
    // Hosts: anything but loopback, including names, other addresses, lists, URIs, conninfo and sockets.
    ["DUCTUS_NATIVE_PGHOST", ""],
    ["DUCTUS_NATIVE_PGHOST", "db.example.invalid"],
    ["DUCTUS_NATIVE_PGHOST", "10.0.0.5"],
    ["DUCTUS_NATIVE_PGHOST", "127.0.0.2"],
    ["DUCTUS_NATIVE_PGHOST", "127.0.0.1,db.example.invalid"],
    ["DUCTUS_NATIVE_PGHOST", "postgres://db.example.invalid/ductus"],
    ["DUCTUS_NATIVE_PGHOST", "host=db.example.invalid"],
    ["DUCTUS_NATIVE_PGHOST", "/var/run/postgresql"],
    ["DUCTUS_NATIVE_PGHOST", "LOCALHOST"],
    ["DUCTUS_NATIVE_PGHOST", " 127.0.0.1"],
    // Ports.
    ["DUCTUS_NATIVE_PGPORT", ""],
    ["DUCTUS_NATIVE_PGPORT", "0"],
    ["DUCTUS_NATIVE_PGPORT", "65536"],
    ["DUCTUS_NATIVE_PGPORT", "05432"],
    ["DUCTUS_NATIVE_PGPORT", "5432 "],
    ["DUCTUS_NATIVE_PGPORT", "-1"],
    ["DUCTUS_NATIVE_PGPORT", "5432,5433"],
    ["DUCTUS_NATIVE_PGPORT", "1e3"],
    // Socket directories.
    ["DUCTUS_NATIVE_PGSOCKET", ""],
    ["DUCTUS_NATIVE_PGSOCKET", "relative/dir"],
    ["DUCTUS_NATIVE_PGSOCKET", "/a,/b"],
    ["DUCTUS_NATIVE_PGSOCKET", "/var/../etc"],
    ["DUCTUS_NATIVE_PGSOCKET", "/with space"],
    ["DUCTUS_NATIVE_PGSOCKET", "C:\\pg"],
    // Role and database names.
    ["DUCTUS_NATIVE_PGUSER", ""],
    ["DUCTUS_NATIVE_PGUSER", "Ductus"],
    ["DUCTUS_NATIVE_PGUSER", "1ductus"],
    ["DUCTUS_NATIVE_PGUSER", "a b"],
    ["DUCTUS_NATIVE_PGUSER", 'x"; DROP ROLE y; --'],
    ["DUCTUS_NATIVE_PGUSER", "a".repeat(64)],
    // F-215: the cluster's own roles and the roles the migrations and db/main/local make.
    ["DUCTUS_NATIVE_PGUSER", "postgres"],
    ["DUCTUS_NATIVE_PGUSER", "pg_monitor"],
    ["DUCTUS_NATIVE_PGUSER", "pg_read_server_files"],
    ["DUCTUS_NATIVE_PGUSER", "ductus_migrator"],
    ["DUCTUS_NATIVE_PGUSER", "ductus_app_local"],
    ["DUCTUS_NATIVE_PGUSER", "ductus_auth_local"],
    ["DUCTUS_NATIVE_PGDATABASE", ""],
    ["DUCTUS_NATIVE_PGDATABASE", "ductus?host=x"],
    ["DUCTUS_NATIVE_PGDATABASE", "a-b"],
    ["DUCTUS_NATIVE_PGDATABASE", "postgres"],
    ["DUCTUS_NATIVE_PGDATABASE", "template0"],
    ["DUCTUS_NATIVE_PGDATABASE", "template1"],
  ];
  for (const [name, value] of refused) {
    assert.throws(
      () => nativeConfig({ [name]: value }),
      new RegExp(name),
      `${name}=${JSON.stringify(value)}`,
    );
  }
  assert.throws(() => nativeConfig({ NODE_ENV: "production" }), /production/);
});

test("F-215: the login password is given, stored or generated once; never a fixed default", () => {
  const given = WITH_RESERVED;
  assert.equal(
    loginPassword({ DUCTUS_NATIVE_PGPASSWORD: given }, memoryStore("x".repeat(20)), {
      create: true,
    }),
    given,
  );
  for (const bad of [
    "",
    "short",
    "a".repeat(15),
    `${"a".repeat(16)}\nb`,
    `${"a".repeat(16)}\rb`,
    `${"a".repeat(16)}\0b`,
  ]) {
    assert.throws(
      () => loginPassword({ DUCTUS_NATIVE_PGPASSWORD: bad }, memoryStore(), { create: true }),
      /DUCTUS_NATIVE_PGPASSWORD/,
      JSON.stringify(bad),
    );
  }
  assert.equal(
    loginPassword({}, memoryStore(LOGIN), { create: false }),
    LOGIN,
    "test:db:native reuses the stored one",
  );
  assert.throws(
    () => loginPassword({}, memoryStore("short"), { create: true }),
    /stored native database password is not valid/,
  );
  assert.throws(
    () => loginPassword({}, memoryStore(), { create: false }),
    /run pnpm db:up:native first/,
  );
  const made: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const store = memoryStore();
    const value = loginPassword({}, store, { create: true });
    assert.match(value, /^[0-9a-f]{48}$/);
    assert.equal(store.value, value);
    assert.equal(store.writes, 1);
    made.push(value);
  }
  assert.notEqual(made[0], made[1]);
  assert.doesNotMatch(
    readFileSync(fileURLToPath(new URL("./native-db.ts", import.meta.url)), "utf8"),
    /ductus-local-only/,
    "no public default",
  );
});

test("F-215: the stored password file is one line, readable by its owner only", () => {
  const dir = mkdtempSync(join(tmpdir(), "ductus-native-pw-"));
  try {
    const file = join(dir, "sub", "native-db-password");
    const store = fileStore(file);
    assert.equal(store.read(), null);
    store.write(LOGIN);
    assert.equal(store.read(), LOGIN);
    assert.equal(readFileSync(file, "utf8"), `${LOGIN}\n`);
    // POSIX file modes; Windows has no 0600 to check.
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("children never see the caller's libpq, psql, dbmate or DUCTUS_NATIVE_* variables", () => {
  const env: Env = {
    PATH: "/bin",
    PGHOST: "db.example.invalid",
    pgservice: "x",
    PGPASSFILE: "/x",
    PSQLRC: "/x",
    DBMATE_URL: "x",
    DATABASE_URL: "kept",
    DUCTUS_NATIVE_PGPASSWORD: "x",
    [BOOTSTRAP_PASSWORD_VAR]: "injected",
    [AUTH_PASSWORD_VAR]: "injected",
    [WORKER_PASSWORD_VAR]: "injected",
  };
  assert.deepEqual(childEnv(env, LOGIN), { PATH: "/bin", DATABASE_URL: "kept", PGPASSWORD: LOGIN });
});

test("the dbmate URL is the db:migrate URL on the native port, with an encoded password", () => {
  const plain = new URL(dbmateUrl(DEFAULT, LOGIN));
  assert.equal(
    `${plain.protocol}//${plain.username}@${plain.host}${plain.pathname}${plain.search}`,
    "postgres://ductus@127.0.0.1:5432/ductus?sslmode=disable&role=ductus_migrator",
  );
  assert.equal(plain.password, LOGIN);
  const url = new URL(dbmateUrl({ ...DEFAULT, host: "::1" }, ENCODE_ME));
  assert.equal(url.password, "a%40b%2Fc%3Fd%23e", "reserved characters are percent-encoded");
  assert.equal(decodeURIComponent(url.password), ENCODE_ME);
  assert.equal(url.hostname, "[::1]");
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/ductus");
  assert.equal(url.search, "?sslmode=disable&role=ductus_migrator");
});

test("test:db:native is the pg_prove of test:db over loopback", async () => {
  assert.match(
    pkg.scripts["test:db"] ?? "",
    /pg_prove -U ductus -d ductus --recurse --ext \.sql \/db\/tests$/,
    "test:db is unchanged",
  );
  assert.equal(pkg.scripts["test:db:native"], "node scripts/db/native-db.ts test");
  assert.equal(pkg.scripts["db:up:native"], "node scripts/db/native-db.ts up");
  // Ductus listed this file in `test:local`; here the vitest unit project picks
  // up every scripts/**/*.test.ts, and CI runs it through pnpm test:unit.
  assert.equal(
    pkg.scripts["test:unit"],
    "vitest run --project unit",
    "CI runs this file through pnpm test:unit",
  );
  const { calls, run } = recorder(() => 3);
  assert.equal(
    await testDb({ env: { PGHOST: "db.example.invalid" }, run, store: memoryStore(LOGIN) }),
    3,
    "pg_prove's exit code is the result",
  );
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        "pg_prove",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "ductus",
        "-d",
        "ductus",
        "--recurse",
        "--ext",
        ".sql",
        "db/main/tests",
      ],
    ],
  );
  assert.equal(envOf(calls[0])["PGHOST"], undefined);
  assert.equal(envOf(calls[0])["PGPASSWORD"], LOGIN);
  assert.deepEqual(pgProveArgs({ ...DEFAULT, port: "54329" }).slice(0, 4), [
    "-h",
    "127.0.0.1",
    "-p",
    "54329",
  ]);
  const none = recorder();
  await assert.rejects(
    testDb({ env: {}, run: none.run, store: memoryStore() }),
    /db:up:native first/,
  );
  assert.deepEqual(none.calls, []);
});

test("db:up:native on a running cluster runs the db:migrate files in order, with no secret in any argv", async () => {
  const { calls, run } = recorder();
  const auth = "s".repeat(16);
  const worker = "w".repeat(16);
  await up({
    env: { DUCTUS_AUTH_LOCAL_PASSWORD: auth, DUCTUS_WORKER_LOCAL_PASSWORD: worker },
    run,
    isRoot: true,
    store: memoryStore(LOGIN),
    log: quiet,
  });
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["pg_isready", "runuser", "runuser", process.execPath, "runuser", "runuser", "runuser"],
  );
  assert.deepEqual(
    calls.slice(2).map((call) => sqlFile(call) ?? "dbmate"),
    [
      "db/main/local/migrator.sql",
      "dbmate",
      "db/main/local/app-login.sql",
      "db/main/local/worker-login.sql",
      "db/main/local/auth-login.sql",
    ],
  );
  // Provisioning on the socket as the cluster superuser, never over TCP.
  for (const call of calls.filter(({ command }) => command === "runuser")) {
    assert.deepEqual(call.args.slice(0, 8), [
      "-u",
      "postgres",
      "--",
      "psql",
      "-h",
      "/var/run/postgresql",
      "-p",
      "5432",
    ]);
    assert.ok(!call.args.includes("127.0.0.1"));
  }
  for (const call of calls) {
    const argv = call.args.join(" ");
    assert.ok(
      !argv.includes(LOGIN) &&
        !argv.includes(auth) &&
        !argv.includes(worker) &&
        !argv.includes("password="),
      `${call.command}: no secret in argv`,
    );
  }
  assert.equal(calls[1]?.options.input, BOOTSTRAP_SQL);
  assert.equal(envOf(calls[1])[BOOTSTRAP_PASSWORD_VAR], LOGIN);
  const dbmate = calls[3] as Call;
  assert.deepEqual(dbmate.args.slice(1), [
    "--migrations-dir",
    "db/main/migrations",
    "--no-dump-schema",
    "--wait",
    "up",
    "--strict",
  ]);
  assert.equal(envOf(dbmate)["DATABASE_URL"], dbmateUrl(DEFAULT, LOGIN));
  const authLogin = calls[6] as Call;
  assert.equal(authLogin.options.input, `\\getenv auth_password ${AUTH_PASSWORD_VAR}\n`);
  assert.equal(envOf(authLogin)[AUTH_PASSWORD_VAR], auth);
  assert.equal(
    envOf(calls[1])[AUTH_PASSWORD_VAR],
    undefined,
    "each secret only reaches its own step",
  );
  const workerLogin = calls[5] as Call;
  assert.equal(workerLogin.options.input, `\\getenv worker_password ${WORKER_PASSWORD_VAR}\n`);
  assert.equal(
    envOf(workerLogin)[WORKER_PASSWORD_VAR],
    worker,
    "DUCTUS_WORKER_LOCAL_PASSWORD reaches the worker login",
  );
  assert.equal(
    envOf(workerLogin)[AUTH_PASSWORD_VAR],
    undefined,
    "the worker login gets only its own secret",
  );
  assert.equal(
    envOf(authLogin)[WORKER_PASSWORD_VAR],
    undefined,
    "the auth login gets only its own secret",
  );
  assert.equal(envOf(calls[1])[WORKER_PASSWORD_VAR], undefined);
  assert.equal(envOf(authLogin)[BOOTSTRAP_PASSWORD_VAR], undefined);
  for (const call of calls) assert.equal(envOf(call)["PGPASSWORD"], LOGIN);
});

test("F-215: the bootstrap refuses an existing role it did not create, and marks the roles it creates", () => {
  assert.match(BOOTSTRAP_SQL, /^\\getenv ductus_password DUCTUS_NATIVE_BOOTSTRAP_PASSWORD$/m);
  assert.doesNotMatch(BOOTSTRAP_SQL, /-v ductus_password/);
  const lines = BOOTSTRAP_SQL.split("\n");
  const at = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));
  const raise = at(/RAISE EXCEPTION 'the role exists and was not created by db:up:native/);
  const create = at(/format\('CREATE ROLE %I'/);
  const mark = at(/COMMENT ON ROLE %I IS %L/);
  const alter = at(/ALTER ROLE %I LOGIN SUPERUSER PASSWORD %L/);
  assert.ok(
    at(/^\\if :role_exists$/) < at(/^\\if :role_ours$/) && at(/^\\if :role_ours$/) < raise,
    "the refusal is inside role_exists and not role_ours",
  );
  assert.ok(
    raise < create && create < mark && mark < alter,
    "create and mark only in the else branch, before SUPERUSER is granted",
  );
  assert.ok(BOOTSTRAP_SQL.includes(`'${ROLE_MARKER}' AS role_ours`));
  assert.ok(BOOTSTRAP_SQL.includes(`'${ROLE_MARKER}') \\gexec`));
  assert.match(BOOTSTRAP_SQL, /WHERE NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_database/);
});

test("without DUCTUS_AUTH_LOCAL_PASSWORD or DUCTUS_WORKER_LOCAL_PASSWORD a random one is made per run; a short one is refused before anything runs", async () => {
  const seen: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const { calls, run } = recorder();
    await up({ env: {}, run, isRoot: true, store: memoryStore(LOGIN), log: quiet });
    const auth = envOf(calls.at(-1))[AUTH_PASSWORD_VAR] ?? "";
    const worker = envOf(calls.at(-2))[WORKER_PASSWORD_VAR] ?? "";
    assert.match(auth, /^[0-9a-f]{48}$/, "24 random bytes in hex");
    assert.match(worker, /^[0-9a-f]{48}$/, "24 random bytes in hex");
    assert.notEqual(auth, worker, "each login gets its own password");
    seen.push(auth, worker);
  }
  assert.equal(new Set(seen).size, 4);
  for (const name of ["DUCTUS_AUTH_LOCAL_PASSWORD", "DUCTUS_WORKER_LOCAL_PASSWORD"]) {
    const { calls, run } = recorder();
    const store = memoryStore();
    await assert.rejects(
      up({ env: { [name]: "short" }, run, isRoot: true, store, log: quiet }),
      new RegExp(`${name} must be at least 16`),
    );
    assert.deepEqual(calls, []);
    assert.equal(store.writes, 0, "nothing is stored when the run is refused");
  }
});

test("a stopped cluster is started as root and waited for; not as another user", async () => {
  let answers = 0;
  const { calls, run } = recorder((command) =>
    command === "pg_isready" ? (answers++ < 3 ? 2 : 0) : 0,
  );
  await up({
    env: {},
    run,
    isRoot: true,
    store: memoryStore(LOGIN),
    wait: async () => {},
    log: quiet,
  });
  assert.deepEqual(
    calls.slice(0, 5).map(({ command, args }) => [command, args[0]]),
    [
      ["pg_isready", "-q"],
      ["service", "postgresql"],
      ["pg_isready", "-q"],
      ["pg_isready", "-q"],
      ["pg_isready", "-q"],
    ],
  );

  const down = recorder((command) => (command === "pg_isready" ? 2 : 0));
  await assert.rejects(
    up({
      env: {},
      run: down.run,
      isRoot: true,
      store: memoryStore(LOGIN),
      wait: async () => {},
      log: quiet,
    }),
    /did not become ready/,
  );
  assert.equal(
    down.calls.filter(({ command }) => command === "pg_isready").length,
    READY_ATTEMPTS + 1,
  );
  assert.ok(
    !down.calls.some(({ command }) => command === "runuser"),
    "nothing is provisioned on a cluster that never answered",
  );

  const user = recorder((command) => (command === "pg_isready" ? 2 : 0));
  await assert.rejects(
    up({ env: {}, run: user.run, isRoot: false, store: memoryStore(LOGIN), log: quiet }),
    /does not answer/,
  );
  assert.deepEqual(
    user.calls.map(({ command }) => command),
    ["pg_isready"],
  );
});

test("not as root the provisioning psql runs as the calling user on the socket", async () => {
  const { calls, run } = recorder();
  await up({ env: {}, run, isRoot: false, store: memoryStore(LOGIN), log: quiet });
  assert.deepEqual(calls[1]?.args.slice(0, 4), ["-h", "/var/run/postgresql", "-p", "5432"]);
  assert.equal(calls[1]?.command, "psql");
});

test("the first failing step stops the run", async () => {
  const order = [
    "bootstrap",
    "migrator.sql",
    "dbmate",
    "app-login.sql",
    "worker-login.sql",
    "auth-login.sql",
  ];
  for (const failing of order) {
    let index = -1;
    const { calls, run } = recorder((command) => {
      if (command === "pg_isready") return 0;
      index += 1;
      return order[index] === failing ? 1 : 0;
    });
    await assert.rejects(
      up({ env: {}, run, isRoot: true, store: memoryStore(LOGIN), log: quiet }),
      /failed/,
    );
    assert.equal(calls.length, 1 + order.indexOf(failing) + 1, `stops at ${failing}`);
  }
});

test("a second db:up:native runs the same idempotent steps and keeps the stored password", async () => {
  const store = memoryStore();
  const first = recorder();
  const second = recorder();
  const env = {
    DUCTUS_AUTH_LOCAL_PASSWORD: "t".repeat(20),
    DUCTUS_WORKER_LOCAL_PASSWORD: "w".repeat(20),
  };
  await up({ env, run: first.run, isRoot: true, store, log: quiet });
  await up({ env, run: second.run, isRoot: true, store, log: quiet });
  assert.equal(store.writes, 1, "the generated password is made once");
  const shape = (calls: Call[]) =>
    calls.map(({ command, args, options }) => [
      command,
      args,
      options.input,
      options.stdinFile,
      options.env,
    ]);
  assert.deepEqual(shape(second.calls), shape(first.calls));
  assert.match(BOOTSTRAP_SQL, /%I.*%L/, "names and the password are quoted by format()");
});

// ZEL-CI-SRV: the pgTAP of the main database split across the legs of the CI
// database job (SHARD=i/n), each file in exactly one leg.
const REPO = fileURLToPath(new URL("../../", import.meta.url));
// The variable CI sets on each leg (the env of the step in ci.yml).
const SHARD_VAR = "SHARD";

test("SHARD: unset or empty is the whole suite, i/n a leg, anything else is refused", () => {
  assert.equal(parseShard(undefined), null);
  assert.equal(parseShard(""), null);
  assert.deepEqual(parseShard("1/1"), { index: 1, total: 1 });
  assert.deepEqual(parseShard("2/2"), { index: 2, total: 2 });
  assert.deepEqual(parseShard("3/12"), { index: 3, total: 12 });
  for (const value of [
    "0/2",
    "3/2",
    "1/0",
    "1",
    "1/",
    "/2",
    "a/b",
    " 1/2",
    "1/2 ",
    "-1/2",
    "01/2",
    "1/2/3",
  ]) {
    assert.throws(() => parseShard(value), /SHARD must be i\/n/, value);
  }
});

test("the test files are every .sql under db/main/tests, as pg_prove --recurse --ext .sql finds them", () => {
  const files = listTestFiles();
  const expected = (readdirSync(`${REPO}${TESTS_DIR}`, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => `${TESTS_DIR}/${entry}`)
    .sort();
  assert.ok(files.length > 10, "the matrix has its test files");
  assert.deepEqual(
    files.map((file) => file.path),
    expected,
  );
  for (const file of files) assert.equal(file.size, statSync(`${REPO}${file.path}`).size);
});

test("every leg count runs each real test file exactly once, in path order, no leg empty", () => {
  const files = listTestFiles();
  const all = files.map((file) => file.path);
  for (let total = 1; total <= 4; total += 1) {
    const legs = shardTestFiles(files, total);
    assert.equal(legs.length, total);
    assert.deepEqual(legs.flat().sort(), all, `${total} legs cover every file once`);
    for (const [at, leg] of legs.entries()) {
      assert.ok(leg.length > 0, `leg ${at + 1}/${total} is not empty`);
      assert.deepEqual(leg, [...leg].sort(), `leg ${at + 1}/${total} runs in path order`);
      assert.deepEqual(filesOfShard(files, { index: at + 1, total }), leg);
    }
  }
  assert.deepEqual(shardTestFiles(files, 1), [all]);
  // Balanced by size: no leg is heavier than an even share plus the largest file.
  const size = new Map(files.map((file) => [file.path, file.size]));
  const sum = (paths: string[]) => paths.reduce((total, path) => total + (size.get(path) ?? 0), 0);
  const largest = Math.max(...files.map((file) => file.size));
  for (const leg of shardTestFiles(files, 2)) {
    assert.ok(sum(leg) <= sum(all) / 2 + largest, "the legs are balanced");
  }
});

test("the split is deterministic: the same files in any order give the same legs", () => {
  const files = listTestFiles();
  assert.deepEqual(shardTestFiles([...files].reverse(), 2), shardTestFiles(files, 2));
  const tied: TestFile[] = ["c", "a", "d", "b"].map((name) => ({ path: `t/${name}.sql`, size: 5 }));
  assert.deepEqual(shardTestFiles(tied, 2), [
    ["t/a.sql", "t/c.sql"],
    ["t/b.sql", "t/d.sql"],
  ]);
});

test("a leg refuses to run when the legs would not run each file exactly once", () => {
  const one: TestFile = { path: "t/a.sql", size: 1 };
  assert.throws(
    () => filesOfShard([one, { ...one }], { index: 1, total: 2 }),
    /exactly once/,
    "a file listed twice",
  );
  assert.throws(
    () => filesOfShard([one], { index: 1, total: 2 }),
    /fewer pgTAP test files than legs/,
  );
});

test("test:db:native with SHARD runs pg_prove over exactly the files of its leg", async () => {
  const files: TestFile[] = [
    { path: `${TESTS_DIR}/000-a.sql`, size: 10 },
    { path: `${TESTS_DIR}/010-b.sql`, size: 40 },
    { path: `${TESTS_DIR}/020-c.sql`, size: 20 },
    { path: `${TESTS_DIR}/sub/030-d.sql`, size: 25 },
  ];
  const ran: string[] = [];
  const lines: string[] = [];
  for (const index of [1, 2]) {
    const { calls, run } = recorder(() => 0);
    assert.equal(
      await testDb({
        env: { [SHARD_VAR]: `${index}/2` },
        run,
        store: memoryStore(LOGIN),
        list: () => files,
        log: (line) => lines.push(line),
      }),
      0,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "pg_prove");
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 8), pgProveArgs(DEFAULT).slice(0, 8));
    assert.ok(!args.includes("--recurse"), "only the leg's files, no directory");
    assert.equal(envOf(calls[0])["PGPASSWORD"], LOGIN);
    ran.push(...args.slice(8));
  }
  // Largest first to the lighter leg: b (40) to 1, d (25) and c (20) to 2, a (10) to 1.
  assert.deepEqual(ran, [
    `${TESTS_DIR}/000-a.sql`,
    `${TESTS_DIR}/010-b.sql`,
    `${TESTS_DIR}/020-c.sql`,
    `${TESTS_DIR}/sub/030-d.sql`,
  ]);
  assert.deepEqual(lines, [
    "pgTAP leg 1/2: 2 of 4 test files.",
    "pgTAP leg 2/2: 2 of 4 test files.",
  ]);
  const bad = recorder();
  await assert.rejects(
    testDb({
      env: { [SHARD_VAR]: "3/2" },
      run: bad.run,
      store: memoryStore(LOGIN),
      list: () => files,
    }),
    /SHARD must be/,
  );
  await assert.rejects(
    testDb({
      env: { [SHARD_VAR]: "1/5" },
      run: bad.run,
      store: memoryStore(LOGIN),
      list: () => files,
      log: quiet,
    }),
    /fewer pgTAP test files than legs/,
  );
  assert.deepEqual(bad.calls, [], "pg_prove never runs on a refused split");
});
