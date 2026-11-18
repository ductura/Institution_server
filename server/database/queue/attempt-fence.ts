// The process fence of the job queue (DAN-822-5b1; Ductus D-74, attack plan
// #1826 W-3 and W-4): startAttemptFence starts the watch thread
// (attempt-fence-watch.ts) by the URL of its file, never from code in a
// string (orchestrator decision Ductus#1836 c.6948159989), and keeps the
// deadlines in attempt-fence-core.ts (#291) on the process's monotonic clock.
// An attempt still armed at its time ends the process with SIGKILL; a release
// at or after its time never returns. Nothing starts on import: only an
// explicit startAttemptFence() starts the thread.
import { Worker } from "node:worker_threads";
import { createDeadlines } from "./attempt-fence-core.ts";
import type { AttemptFence } from "./job-queue.ts";

/** Starts the watch thread; the fence the worker process passes to openJobQueue. */
export function startAttemptFence(): AttemptFence {
  const cell = new BigInt64Array(new SharedArrayBuffer(8));
  // The .ts file from the source tree, the .js file next to the bundle (DAN-822-6).
  const thread = new Worker(
    import.meta.url.endsWith(".ts")
      ? new URL("./attempt-fence-watch.ts", import.meta.url)
      : new URL("./attempt-fence-watch.js", import.meta.url),
    { workerData: cell.buffer },
  );
  thread.unref();
  const deadlines = createDeadlines(
    cell,
    () => process.hrtime.bigint(),
    // A late release holds the main thread until the watch's kill lands.
    () => {
      for (;;) Atomics.wait(cell, 0, Atomics.load(cell, 0));
    },
  );
  let closed = false;
  let live = 0;
  // The thread is ended at most once; every close returns the same promise.
  let ended: Promise<void> | undefined;
  function end(): Promise<void> {
    // A failed terminate leaves only an idle, unref'd thread.
    ended ??= thread.terminate().then(
      () => {},
      () => {},
    );
    return ended;
  }
  return {
    arm(ms) {
      if (closed) throw new Error("fence_refused");
      const release = deadlines.arm(ms);
      live += 1;
      let released = false;
      return () => {
        if (released) return;
        release();
        released = true;
        live -= 1;
        if (closed && live === 0) void end();
      };
    },
    // Resolves at once while attempts are live: each stays fenced until released.
    async close() {
      closed = true;
      if (live === 0) await end();
    },
  };
}
