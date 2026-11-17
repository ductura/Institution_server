// The attempt fence (DAN-822-5; Ductus D-74, attack plan #1826 W-3 and W-4),
// ported from Ductus src/server/attempt-fence.ts with the same behaviour. A
// stop signal only asks a handler to stop. The fence ends the whole process
// when an attempt is still armed at its time, so an attempt that ignores the
// signal, or blocks the thread, is gone before the queue hands its job out
// again. The watch is attempt-fence-watch.ts in its own thread, started by the
// URL of that file, never from code in a string (orchestrator decision,
// Ductus#1836 c.6948159989): the .ts file when this module runs from the
// source tree, the .js file next to the built bundle (DAN-822-6).
//
// Erasable TypeScript only: the process test runs this file in plain node.
import { Worker } from "node:worker_threads";
import type { AttemptFence } from "./job-queue.ts";

/** The longest time an attempt may be armed for, as for setTimeout (about 24.8 days). */
export const MAX_FENCE_MS = 2_147_483_647;

/** Starts the watch thread; the fence the worker process passes to openJobQueue. */
export function startAttemptFence(): AttemptFence {
  // The earliest armed time on the monotonic clock, or 0 when nothing is armed.
  const cell = new BigInt64Array(new SharedArrayBuffer(8));
  const thread = new Worker(
    import.meta.url.endsWith(".ts")
      ? new URL("./attempt-fence-watch.ts", import.meta.url)
      : new URL("./attempt-fence-watch.js", import.meta.url),
    { workerData: cell.buffer },
  );
  thread.unref();
  const armed = new Map<symbol, bigint>();
  let closed = false;
  function publish(): void {
    let earliest = 0n;
    for (const at of armed.values()) if (earliest === 0n || at < earliest) earliest = at;
    Atomics.store(cell, 0, earliest);
    Atomics.notify(cell, 0);
  }
  return {
    arm(ms) {
      // An integer up to MAX_FENCE_MS: a longer time in nanoseconds would not
      // fit the 64-bit cell and would wrap to another time.
      if (closed || !Number.isInteger(ms) || ms < 1 || ms > MAX_FENCE_MS)
        throw new Error("fence_refused");
      const key = Symbol("attempt");
      armed.set(key, process.hrtime.bigint() + BigInt(ms) * 1_000_000n);
      publish();
      return () => {
        if (!armed.delete(key)) return;
        publish();
        if (closed && armed.size === 0) void thread.terminate();
      };
    },
    async close() {
      closed = true;
      if (armed.size === 0) await thread.terminate();
    },
  };
}
