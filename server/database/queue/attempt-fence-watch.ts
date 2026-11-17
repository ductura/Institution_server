// The watch thread of the attempt fence (DAN-822-4; Ductus D-74, attack plan
// #1826 W-3 and W-4). The fence (attempt-fence.ts, DAN-822-5) starts it by the
// URL of this file and shares one cell: 0 while nothing is armed, else the
// earliest armed time on the process's monotonic clock in nanoseconds. When
// that time passes the watch kills the whole process, also while the main
// thread blocks, and writes nothing before. Same loop as the WATCH string of
// Ductus src/server/attempt-fence.ts, as a module instead of code from a
// string (orchestrator decision Ductus#1836 c.6948159989). Loaded anywhere
// else, or with another cell, it throws instead of waiting.
//
// Erasable TypeScript only: the thread runs this file in plain node.
import { workerData } from "node:worker_threads";

const data: unknown = workerData;
// A buffer that can grow is refused too: the cell is exactly these 8 bytes.
if (
  !(data instanceof SharedArrayBuffer) ||
  data.byteLength !== 8 ||
  Reflect.get(data, "growable") !== false
) {
  throw new Error("attempt_fence_watch_misused");
}
const cell = new BigInt64Array(data);
for (;;) {
  const at = Atomics.load(cell, 0);
  if (at === 0n) {
    Atomics.wait(cell, 0, 0n);
    continue;
  }
  const left = Number((at - process.hrtime.bigint()) / 1_000_000n);
  if (left <= 0) process.kill(process.pid, "SIGKILL");
  else Atomics.wait(cell, 0, at, left);
}
