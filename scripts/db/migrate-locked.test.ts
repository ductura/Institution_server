// D-91 (3), DAN-71: the migration runner holds an advisory lock on its own
// connection for the whole dbmate run and stops dbmate when the lock is lost.
// Fakes stand in for the pg client and the dbmate child; the real lock against
// PostgreSQL (Ductus tests/integration/migrate-lock.integration.test.ts) comes
// with the local database stack in S-0.14. Ported from Ductus
// scripts/engineering/migrate-locked.test.mjs at d52a92c3 (S-0.13, DAN-726):
// same assertions, node:test replaced by vitest, paths adapted. The test of the
// `pnpm db:migrate` script moves with that script to S-0.14.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";

import { test } from "vitest";

import { connectLockClient } from "../../server/database/index.ts";
import {
  dbmateArgs,
  dbmateBinary,
  LOCK_KEY,
  MIGRATIONS_DIR,
  runLocked,
  startDbmate,
  type LockClient,
  type RunLockedOptions,
} from "./index.ts";

type Mode = "ok" | "fail" | "wait" | "hang";
type ClientOptions = { lock?: Mode; heartbeat?: Mode; unlock?: Mode; end?: Mode };

class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  lock: Mode;
  heartbeat: Mode;
  unlock: Mode;
  endMode: Mode;
  waiting: ((error: Error) => void) | null = null;
  // lock: ok | fail | wait (pending until end()); heartbeat: ok | fail | hang;
  // unlock: ok | hang; end: ok | hang.
  constructor({ lock = "ok", heartbeat = "ok", unlock = "ok", end = "ok" }: ClientOptions = {}) {
    super();
    this.lock = lock;
    this.heartbeat = heartbeat;
    this.unlock = unlock;
    this.endMode = end;
  }
  query(text: string, params?: unknown[]): Promise<unknown> {
    this.queries.push(params ? `${text} ${params.join(",")}` : text);
    if (text.includes("pg_advisory_lock(") && this.lock === "fail") {
      return Promise.reject(new Error("lock timeout"));
    }
    if (text.includes("pg_advisory_lock(") && this.lock === "wait") {
      return new Promise((resolve, reject) => (this.waiting = reject));
    }
    if (text.includes("pg_advisory_unlock(") && this.unlock === "hang")
      return new Promise(() => {});
    if (text === "SELECT 1" && this.heartbeat === "fail") return Promise.reject(new Error("gone"));
    if (text === "SELECT 1" && this.heartbeat === "hang") return new Promise(() => {});
    return Promise.resolve({ rows: [] });
  }
  end(): Promise<void> {
    this.ended = true;
    this.waiting?.(new Error("Connection terminated"));
    return this.endMode === "hang" ? new Promise(() => {}) : Promise.resolve();
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  exit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function harness(clientOptions?: ClientOptions, { connectFails = false } = {}) {
  const client = new FakeClient(clientOptions);
  const child = new FakeChild();
  const logs: string[] = [];
  let started = 0;
  let queriesAtStart: string[] | null = null;
  const run = (options: Partial<RunLockedOptions> = {}): Promise<number> =>
    runLocked({
      connect: async () => {
        if (connectFails) throw new Error("refused");
        return client;
      },
      start: () => {
        started += 1;
        queriesAtStart = [...client.queries];
        return child;
      },
      log: (line) => logs.push(line),
      heartbeatMs: 5,
      killGraceMs: 5,
      ...options,
    });
  return {
    client,
    child,
    logs,
    run,
    started: () => started,
    queriesAtStart: () => queriesAtStart,
  };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The run's result, or "pending" when it has not finished within `ms`. */
function settled<T>(promise: Promise<T>, ms = 2000): Promise<T | "pending"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"pending">((resolve) => (timer = setTimeout(resolve, ms, "pending")));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("the lock is taken before dbmate starts and released after it, and the exit code passes through", async () => {
  for (const code of [0, 3]) {
    const h = harness();
    const done = h.run({ heartbeatMs: 1000 });
    await tick();
    assert.equal(h.started(), 1);
    assert.deepEqual(h.queriesAtStart(), [
      "SET lock_timeout = 600000",
      `SELECT pg_catalog.pg_advisory_lock($1::bigint) ${LOCK_KEY}`,
    ]);
    h.child.exit(code);
    assert.equal(await done, code);
    assert.equal(
      h.client.queries.at(-1),
      `SELECT pg_catalog.pg_advisory_unlock($1::bigint) ${LOCK_KEY}`,
    );
    assert.ok(h.client.ended);
  }
});

test("dbmate never starts when the lock connection or the lock cannot be had", async () => {
  const refused = harness({}, { connectFails: true });
  assert.equal(await refused.run(), 1);
  assert.equal(refused.started(), 0);

  const held = harness({ lock: "fail" });
  assert.equal(await held.run(), 1);
  assert.equal(held.started(), 0);
  assert.ok(held.client.ended);
  assert.match(held.logs.join("\n"), /could not take the lock/);
});

test("a lost lock connection stops dbmate and the run fails, even if dbmate then exits 0", async () => {
  for (const event of ["error", "end"]) {
    const h = harness();
    const done = h.run({ heartbeatMs: 1000 });
    await tick();
    h.client.emit(event, new Error("boom"));
    assert.deepEqual(h.child.signals, ["SIGTERM"]);
    h.child.exit(0);
    assert.equal(await done, 1, event);
    assert.match(h.logs.join("\n"), /Migration lock lost/);
    assert.ok(
      !h.client.queries.some((q) => q.includes("pg_advisory_unlock")),
      "no unlock on a lost session",
    );
  }
});

test("a failed or hanging heartbeat counts as a lost lock", async () => {
  for (const heartbeat of ["fail", "hang"] as const) {
    const h = harness({ heartbeat });
    const done = h.run();
    await tick(60);
    assert.equal(h.child.signals[0], "SIGTERM", heartbeat);
    h.child.exit(0);
    assert.equal(await done, 1, heartbeat);
    assert.match(
      h.logs.join("\n"),
      heartbeat === "fail" ? /heartbeat failed/ : /heartbeat timed out/,
    );
  }
});

test("a dbmate that ignores SIGTERM is killed", async () => {
  const h = harness();
  const done = h.run({ heartbeatMs: 1000 });
  await tick();
  h.client.emit("end");
  await tick(20);
  assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
  h.child.exit(null);
  assert.equal(await done, 1);
});

// #1051 Codex P2: a release on a connection that hangs once dbmate has
// exited must not keep the run waiting, and neither may closing it.
test("a lock release or a close that hangs ends the run with 1 in bounded time", async () => {
  for (const options of [{ unlock: "hang" }, { unlock: "hang", end: "hang" }] as const) {
    const h = harness(options);
    const done = h.run();
    await tick();
    h.child.exit(0);
    assert.equal(await settled(done), 1, JSON.stringify(options));
    assert.match(h.logs.join("\n"), /release did not finish/);
  }
  const closing = harness({ end: "hang" });
  const done = closing.run();
  await tick();
  closing.child.exit(0);
  assert.equal(
    await settled(done),
    0,
    "a hanging close after a release is bounded and keeps dbmate's code",
  );
});

// #1051 Codex P2: SIGINT or SIGTERM while the runner waits for the lock
// cancels the run; it must not start dbmate once the lock is granted.
test("a run cancelled before dbmate starts never starts it and fails", async () => {
  const early = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await early.run({ signal: controller.signal }), 1);
  assert.equal(early.started(), 0);

  const waiting = harness({ lock: "wait" });
  const cancel = new AbortController();
  const done = waiting.run({ signal: cancel.signal });
  await tick();
  assert.equal(waiting.started(), 0, "still waiting for the lock");
  cancel.abort();
  assert.equal(await settled(done), 1);
  assert.equal(waiting.started(), 0);
  assert.ok(waiting.client.ended, "the lock connection is closed, so the pending lock fails");
  assert.match(waiting.logs.join("\n"), /cancelled before dbmate started/);
  assert.doesNotMatch(waiting.logs.join("\n"), /could not take the lock/);
});

// #1051 review/QA FAIL (753b5d22): a signal that arrives while connect() is
// still opening the connection fires before the abort listener exists. A
// connect that then succeeds must not lead to the lock or to dbmate.
test("a run cancelled while the lock connection opens never takes the lock or starts dbmate", async () => {
  for (const outcome of ["succeeds", "fails"]) {
    const client = new FakeClient();
    const logs: string[] = [];
    let started = 0;
    let finishConnect = (): void => {};
    const controller = new AbortController();
    const done = runLocked({
      connect: () =>
        new Promise<LockClient>((resolve, reject) => {
          finishConnect = () =>
            outcome === "succeeds" ? resolve(client) : reject(new Error("refused"));
        }),
      start: () => {
        started += 1;
        return new FakeChild();
      },
      signal: controller.signal,
      log: (line) => logs.push(line),
      heartbeatMs: 5,
      killGraceMs: 5,
    });
    await tick();
    controller.abort();
    finishConnect();
    assert.equal(await settled(done), 1, outcome);
    assert.equal(started, 0, `dbmate never starts when connect ${outcome}`);
    assert.deepEqual(client.queries, [], `no lock query when connect ${outcome}`);
    if (outcome === "succeeds") {
      assert.ok(client.ended, "the connection that opened after the cancel is closed");
    }
    assert.match(logs.join("\n"), /cancelled before dbmate started/);
  }
});

/** A TCP server that accepts connections and never answers the PostgreSQL handshake. */
async function silentServer() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `postgres://synthetic:synthetic@127.0.0.1:${(server.address() as net.AddressInfo).port}/none`,
    sockets,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test("a cancel ends a lock connection whose server never answers, and dbmate never starts", async () => {
  // #1051 Codex P2 (b3719a01): a handshake that hangs left connect() pending,
  // so SIGINT/SIGTERM could not end the run.
  const server = await silentServer();
  try {
    const controller = new AbortController();
    let started = 0;
    const done = runLocked({
      connect: () => connectLockClient(server.url, { attempts: 1, signal: controller.signal }),
      start: () => ((started += 1), new FakeChild()),
      signal: controller.signal,
      log: () => {},
    });
    for (let i = 0; server.sockets.length === 0 && i < 100; i += 1) await tick(10);
    assert.equal(server.sockets.length, 1, "the lock connection reached the server");
    controller.abort();
    assert.equal(await settled(done, 1000), 1);
    assert.equal(started, 0);
  } finally {
    await server.close();
  }
});

test("a lock connection whose server never answers fails after connectTimeoutMs", async () => {
  const server = await silentServer();
  try {
    const attempt = connectLockClient(server.url, { attempts: 1, connectTimeoutMs: 200 }).then(
      () => "connected",
      (error: Error) => error.message,
    );
    assert.match(String(await settled(attempt, 2000)), /timeout/);
  } finally {
    await server.close();
  }
});

test("a run cancelled while dbmate runs stops dbmate and fails, even if dbmate then exits 0", async () => {
  const h = harness();
  const controller = new AbortController();
  const done = h.run({ signal: controller.signal, heartbeatMs: 1000 });
  await tick();
  controller.abort();
  assert.deepEqual(h.child.signals, ["SIGTERM"]);
  h.child.exit(0);
  assert.equal(await done, 1);
});

test("dbmate always runs up --strict without a schema dump, and the URL is passed only to dbmate", () => {
  const args = dbmateArgs("postgres://u:secret@h/d");
  // S-0.13: the migrations of the main database are in db/main/migrations, not
  // in dbmate's default db/migrations.
  assert.equal(MIGRATIONS_DIR, "db/main/migrations");
  assert.deepEqual(args.slice(1), [
    "--url",
    "postgres://u:secret@h/d",
    "--migrations-dir",
    "db/main/migrations",
    "--no-dump-schema",
    "--wait",
    "up",
    "--strict",
  ]);
  // The platform binary, not node_modules/dbmate/dist/cli.js.
  assert.equal(args[0], dbmateBinary());
  assert.match(args[0] as string, /@dbmate[\\/][^\\/]+[\\/]bin[\\/]dbmate(\.exe)?$/);
});

// #1051 Codex P1: the npm dbmate command is a Node wrapper that runs the
// binary with spawnSync, so a signal to it never reached dbmate. The runner's
// child must be dbmate itself, and SIGTERM must leave no dbmate behind.
test("the runner's child is the dbmate process itself and SIGTERM stops it", async () => {
  const marker = `ductus_lock_test_${process.pid}_${Date.now()}`;
  // Nothing listens on port 1, so dbmate keeps waiting for the server (--wait).
  const child: ChildProcess = startDbmate(`postgres://x@127.0.0.1:1/${marker}?sslmode=disable`, {
    stdio: "ignore",
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve(signal ?? code)),
  );
  try {
    await tick(300);
    assert.equal(child.exitCode, null, "dbmate is waiting for the server");
    if (existsSync("/proc/self/exe")) {
      assert.equal(
        realpathSync(`/proc/${child.pid}/exe`),
        realpathSync(dbmateBinary()),
        "the child runs the dbmate binary",
      );
    }
    child.kill("SIGTERM");
    assert.equal(await settled(exited, 5000), "SIGTERM");
    if (existsSync("/proc/self/cmdline")) {
      await tick(100);
      const left = readdirSync("/proc").filter((pid) => {
        if (!/^\d+$/.test(pid)) return false;
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker);
        } catch {
          return false;
        }
      });
      assert.deepEqual(left, [], "no dbmate process survives SIGTERM");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
