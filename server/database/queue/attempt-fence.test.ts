import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KILLING } from "./attempt-fence-core.ts";

// DAN-822-5b1: the process fence over the deadlines of attempt-fence-core.ts
// (#291). Its life cycle is checked with node:worker_threads replaced by a
// recorder, so no real thread starts in vitest; that an attempt past its time
// ends a real process is attempt-fence.integration.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
const watchUrl = pathToFileURL(path.join(here, "attempt-fence-watch.ts")).href;

type Recorded = { started: { script: unknown; options: unknown }[]; calls: string[] };

async function loadWithRecorder(
  terminateFails = false,
): Promise<Recorded & { fence: typeof import("./attempt-fence.ts") }> {
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
      if (terminateFails) throw new Error("terminate_failed");
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
  vi.restoreAllMocks();
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});

// Orchestrator cut of #296 (Ductus#2028 c.6966917804): which watch file the
// fence starts, as a pure function of its own module URL.
describe("watchScript: the watch next to the module", () => {
  it.each<[string, string, "ts" | "js"]>([
    ["the source tree", "file:///app/server/database/queue/attempt-fence.ts", "ts"],
    ["the bundle", "file:///app/dist/worker.js", "js"],
    ["an ES module bundle", "file:///app/dist/worker.mjs", "js"],
    ["a CommonJS bundle", "file:///app/dist/worker.cjs", "js"],
    ["no extension", "file:///app/dist/worker", "js"],
    ["another letter case", "file:///app/server/attempt-fence.TS", "js"],
    ["a .ts directory, not a file", "file:///app/x.ts/attempt-fence.js", "js"],
  ])("from %s it is the .%s file", async (_label, moduleUrl, kind) => {
    const { fence } = await loadWithRecorder();
    expect(fence.watchScript(moduleUrl)).toBe(kind);
  });
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

  // Review FAIL on #296 (c.6966505063): the watch has claimed the kill but not
  // yet sent it; a timely last release loses its exchange. It must not count,
  // or close would end the watch before the signal and the process survive.
  it("a release that loses to a claimed kill parks, and close never ends the thread", async () => {
    const { started, calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    const release = handle.arm(60_000);
    await handle.close();
    const shared = (started[0]?.options as { workerData: SharedArrayBuffer }).workerData;
    const cell = new BigInt64Array(shared);
    Atomics.store(cell, 0, KILLING);
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new Error("parked");
    });
    expect(() => release()).toThrow("parked");
    await handle.close();
    expect(calls).toEqual(["unref"]);
  });

  it("a terminate that fails does not fail close, and a second close does not retry it", async () => {
    const { calls, fence } = await loadWithRecorder(true);
    const handle = fence.startAttemptFence();
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
    expect(calls).toEqual(["unref", "terminate"]);
  });

  it("a refused arm counts no attempt, so close still ends the thread", async () => {
    const { calls, fence } = await loadWithRecorder();
    const handle = fence.startAttemptFence();
    expect(() => handle.arm(0)).toThrow("fence_refused");
    await handle.close();
    expect(calls).toEqual(["unref", "terminate"]);
  });
});
