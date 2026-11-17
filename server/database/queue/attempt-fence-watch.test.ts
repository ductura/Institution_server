import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../../../scripts/build/index.ts";

// DAN-822-4 (Ductus D-74, attack plan #1826 W-3 and W-4): the watch thread of
// the attempt fence ends a real node process. Each case is a child, run with
// the server's node flags, that starts the watch by the URL of its file as the
// fence will (822-5), waits until the thread is parked on its cell, writes the
// earliest armed time and then behaves as one class of attempt. The watch
// reads the process's monotonic clock in its own thread, so a fake clock
// cannot reach it: real deadlines with wide margins, as in Ductus.
const work = mkdtempSync(path.join(tmpdir(), "ductura-fence-watch-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = pathToFileURL(path.join(here, "attempt-fence-watch.ts")).href;
const MISUSED = "attempt_fence_watch_misused";
let scripts = 0;

type Ending = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Milliseconds from the child writing "armed" to its end; -1 if it never did. */
  afterArmed: number;
};

async function run(body: string): Promise<Ending> {
  scripts += 1;
  const file = path.join(work, `case-${scripts}.mjs`);
  writeFileSync(
    file,
    `import { Worker } from "node:worker_threads";
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cell = new BigInt64Array(new SharedArrayBuffer(8));
// Starts the watch and returns once it is parked on the cell: a notify that
// wakes one waiter proves it (the watch reads 0 again and parks again).
const start = async (data = cell.buffer) => {
  const thread = new Worker(new URL(${JSON.stringify(watch)}), { workerData: data });
  thread.on("error", (error) => console.log(error.message));
  await new Promise((resolve) => thread.once("online", resolve));
  thread.unref();
  while (Atomics.notify(cell, 0) !== 1) await later(5);
  await later(50);
};
// Writes the cell; unless told otherwise, the write must wake the parked
// watch, or the case says so and cannot pass as a kill.
const set = (ms, mustWake = true) => {
  Atomics.store(cell, 0, ms === 0 ? 0n : process.hrtime.bigint() + BigInt(ms) * 1_000_000n);
  if (Atomics.notify(cell, 0) !== 1 && mustWake) console.log("not parked");
};
${body}
`,
  );
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let armedAt = -1;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (armedAt === -1 && stdout.includes("armed")) armedAt = Date.now();
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // A child the watch did not end is stopped with SIGTERM, never SIGKILL, so it
  // cannot pass for one the watch killed.
  const stop = setTimeout(() => child.kill("SIGTERM"), 5000);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(stop);
      const afterArmed = armedAt === -1 ? -1 : Date.now() - armedAt;
      resolve({ code, signal, stdout, stderr, afterArmed });
    });
  });
}

const killed = { code: null, signal: "SIGKILL", stdout: "armed\n", stderr: "" };
const survived = (stdout: string): object => ({ code: 0, signal: null, stdout, stderr: "" });

describe("attempt fence watch: misused, it refuses and kills nothing", () => {
  it("throws when loaded on the main thread, without hanging", async () => {
    const ending = await run(
      `try { await import(${JSON.stringify(watch)}); console.log("loaded"); } catch (error) { console.log(error.message); }`,
    );
    expect(ending).toMatchObject(survived(`${MISUSED}\n`));
  });

  it.each<[string, string]>([
    ["no data", "undefined"],
    ["null", "null"],
    ["a buffer that is not shared", "new ArrayBuffer(8)"],
    ["a shared buffer of another size", "new SharedArrayBuffer(16)"],
    ["a shared buffer that can grow", "new SharedArrayBuffer(8, { maxByteLength: 16 })"],
    ["a typed array instead of its buffer", "cell"],
  ])("throws in the thread for %s, and the process lives on", async (_label, data) => {
    const ending = await run(
      `const data = ${data}; const thread = new Worker(new URL(${JSON.stringify(watch)}), data === undefined ? {} : { workerData: data });
thread.on("error", (error) => console.log(error.message));
set(300, false); await later(800); console.log("alive");`,
    );
    expect(ending).toMatchObject(survived(`${MISUSED}\nalive\n`));
  });
});

describe("attempt fence watch: a time that passes ends the process", () => {
  it.each<[string, string]>([
    ["blocks the thread", `await start(); set(300); console.log("armed"); for (;;) {}`],
    [
      "waits on something that never settles",
      `await start(); set(300); console.log("armed"); setInterval(() => {}, 1000); await new Promise(() => {});`,
    ],
    [
      "finishes after its time",
      `await start(); set(300); console.log("armed"); await later(3000); console.log("late");`,
    ],
    [
      "had an earlier time written while the watch waited on a later one",
      `await start(); set(60000); await later(100); set(300); console.log("armed"); await later(3000); console.log("late");`,
    ],
  ])("an attempt that %s is killed, and writes nothing after it", async (_label, body) => {
    const ending = await run(body);
    expect(ending).toMatchObject(killed);
    expect(ending.afterArmed).toBeGreaterThanOrEqual(250);
    expect(ending.afterArmed).toBeLessThan(3000);
  });

  it("kills at once a time already past when written", async () => {
    const ending = await run(
      `await start(); console.log("armed"); await later(50); Atomics.store(cell, 0, process.hrtime.bigint() - 1n); if (Atomics.notify(cell, 0) !== 1) console.log("not parked"); await later(3000); console.log("late");`,
    );
    expect(ending).toMatchObject(killed);
    expect(ending.afterArmed).toBeLessThan(250);
  });
});

describe("attempt fence watch: nothing armed at its time, the process lives", () => {
  it("lives on when the cell is cleared before the time", async () => {
    const ending = await run(
      `await start(); set(300); await later(100); set(0); await later(700); console.log("done");`,
    );
    expect(ending).toMatchObject(survived("done\n"));
  });

  it("lives on with an empty cell, and the thread does not fail", async () => {
    const ending = await run(`await start(); await later(700); console.log("done");`);
    expect(ending).toMatchObject(survived("done\n"));
  });
});
