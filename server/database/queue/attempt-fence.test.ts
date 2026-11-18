import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { SERVER_NODE_FLAGS } from "../../../scripts/build/index.ts";

// DAN-822-5b1: the process fence over the deadlines of attempt-fence-core.ts
// (#291). Its life cycle is checked with node:worker_threads replaced by a
// recorder, so no real thread starts in vitest; that an attempt past its time
// ends a real process is checked in child processes.
const here = path.dirname(fileURLToPath(import.meta.url));
const watchUrl = pathToFileURL(path.join(here, "attempt-fence-watch.ts")).href;

type Recorded = { started: { script: unknown; options: unknown }[]; calls: string[] };

async function loadWithRecorder(): Promise<
  Recorded & { fence: typeof import("./attempt-fence.ts") }
> {
  const recorded: Recorded = { started: [], calls: [] };
  class Worker {
    constructor(script: unknown, options: unknown) {
      recorded.started.push({ script, options });
    }
    unref(): void {
      recorded.calls.push("unref");
    }
    async terminate(): Promise<number> {
      recorded.calls.push("terminate");
      return 0;
    }
  }
  vi.resetModules();
  // The mock module's one export, under the name of the class it replaces.
  vi.doMock("node:worker_threads", () => Object.fromEntries([["Worker", Worker]]));
  const fence = await import("./attempt-fence.ts");
  return { ...recorded, fence };
}

afterEach(() => {
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});

describe("startAttemptFence: the thread and its life cycle (recorder, no real thread)", () => {
  it("starts no thread on import, and one on startAttemptFence(), for the watch with workerData only", async () => {
    const { started, calls, fence } = await loadWithRecorder();
    expect(started).toEqual([]);
    fence.startAttemptFence();
    expect(started).toHaveLength(1);
    expect(String(started[0]?.script)).toBe(watchUrl);
    const options = started[0]?.options as { workerData?: unknown };
    expect(Object.keys(options)).toEqual(["workerData"]);
    expect(options.workerData).toBeInstanceOf(SharedArrayBuffer);
    expect((options.workerData as SharedArrayBuffer).byteLength).toBe(8);
    expect(calls).toEqual(["unref"]);
  });

  it("refuses arm(0) and accepts arm(1)", async () => {
    const { fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    expect(() => handle.arm(0)).toThrow("fence_refused");
    expect(typeof handle.arm(1)).toBe("function");
  });

  it("refuses to arm once closed, so no attempt runs unfenced", async () => {
    const { fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    await handle.close();
    expect(() => handle.arm(1000)).toThrow("fence_refused");
  });

  it("ends the thread at close when nothing is armed, once", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    await handle.close();
    expect(calls).toEqual(["unref", "terminate"]);
  });

  it("keeps the thread after close until the last attempt is released in time, then ends it once", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    const first = handle.arm(60_000);
    const second = handle.arm(60_000);
    await handle.close();
    expect(calls).toEqual(["unref"]);
    first();
    first();
    expect(calls).toEqual(["unref"]);
    second();
    expect(calls).toEqual(["unref", "terminate"]);
    second();
    expect(calls).toEqual(["unref", "terminate"]);
  });

  it("ends the thread at most once, however often close is called", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    const release = handle.arm(60_000);
    await handle.close();
    release();
    await handle.close();
    await handle.close();
    expect(calls).toEqual(["unref", "terminate"]);
  });

  it("a late release parks, is not counted, and close never ends the thread under it", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    const release = handle.arm(100);
    await handle.close();
    // The clock past the deadline; park's Atomics.wait would block vitest for good.
    const real = process.hrtime.bigint;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => real() + 60_000_000_000n);
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new Error("parked");
    });
    expect(() => release()).toThrow("parked");
    await handle.close();
    expect(calls).toEqual(["unref"]);
    vi.restoreAllMocks();
  });

  it("a refused arm counts no attempt, so close still ends the thread", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    expect(() => handle.arm(0)).toThrow("fence_refused");
    await handle.close();
    expect(calls).toEqual(["unref", "terminate"]);
  });
});

// The real thread in a child process, run with the server's node flags.
const work = mkdtempSync(path.join(tmpdir(), "ductura-fence-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fenceModule = pathToFileURL(path.join(here, "attempt-fence.ts")).href;
let scripts = 0;

type Ending = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

async function run(body: string): Promise<Ending> {
  scripts += 1;
  const file = path.join(work, `case-${scripts}.mjs`);
  writeFileSync(
    file,
    `import { startAttemptFence } from ${JSON.stringify(fenceModule)};
const fence = startAttemptFence();
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The main thread's clock only, past every deadline: the watch keeps the real one.
const late = () => { const real = process.hrtime.bigint; process.hrtime.bigint = () => real() + 5_000_000_000n; };
${body}
`,
  );
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // A child the fence did not end is stopped with SIGTERM, never SIGKILL, so
  // it cannot pass for one the fence killed; before vitest's own 5 s timeout.
  const stop = setTimeout(() => child.kill("SIGTERM"), 4000);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(stop);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("startAttemptFence: a real process", () => {
  it("kills an attempt that blocks the thread past its time, and nothing is written after", async () => {
    expect(await run(`fence.arm(300); console.log("armed"); for (;;) {}`)).toEqual({
      code: null,
      signal: "SIGKILL",
      stdout: "armed\n",
      stderr: "",
    });
  });

  it("a release after the time never returns, and the process is killed at the real deadline", async () => {
    expect(
      await run(
        `const release = fence.arm(1000); console.log("armed"); late(); console.log("before release"); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "armed\nbefore release\n", stderr: "" });
  });

  it("close does not end the watch under a live attempt: a late release after close is killed", async () => {
    expect(
      await run(
        `const release = fence.arm(1000); await fence.close(); console.log("closed"); late(); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
  });

  it("close does not end the watch under a live attempt: one that blocks after close is killed", async () => {
    expect(
      await run(`fence.arm(300); await fence.close(); console.log("closed"); for (;;) {}`),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
  });

  it("an attempt released in time, then close, lets the process exit 0", async () => {
    expect(
      await run(
        `const release = fence.arm(300); release(); await fence.close(); await later(500); console.log("done");`,
      ),
    ).toEqual({ code: 0, signal: null, stdout: "done\n", stderr: "" });
  });

  it("an idle fence does not keep the process alive", async () => {
    expect(await run(`console.log("done");`)).toEqual({
      code: 0,
      signal: null,
      stdout: "done\n",
      stderr: "",
    });
  });
});
