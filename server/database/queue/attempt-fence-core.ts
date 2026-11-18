// The deadlines of the attempt fence (DAN-822-5a; Ductus D-74, attack plan
// #1826 W-3 and W-4), without a thread or a clock of their own, so the
// deadline is exact as a class and testable with a fake clock (contract cut on
// ductura/server#265, c.6964701401). One shared cell holds the earliest armed
// time on the monotonic clock in nanoseconds, 0 when nothing is armed, or
// KILLING once the watch has claimed the kill. Two writers, each by
// compareExchange: the main thread from the value it last published, the
// watch from the expired time it read. So a release that returns before the
// deadline always prevents the kill, a release at or after it never does, and
// the watch never kills before the deadline nor on a time already replaced.
// Fixes two defects of Ductus src/server/attempt-fence.ts (#265 review
// c.6962584480, QA c.6962586121): a late release cleared an expired time, and
// the watch rounded toward zero and decided on a stale read.
//
// Erasable TypeScript only: the watch thread loads this file in plain node.

/** The longest time an attempt may be armed for, as for setTimeout (about 24.8 days). */
export const MAX_FENCE_MS = 2_147_483_647;
/** The cell once the watch has claimed the kill; no monotonic time is negative. */
export const KILLING = -1n;
const NS_PER_MS = 1_000_000n;
// The largest time the 64-bit cell holds; 0 and KILLING are reserved below it.
const CELL_MAX = 2n ** 63n - 1n;

/** What the watch does with the cell value `at` at time `now` (nanoseconds). */
export type WatchStep =
  { kind: "idle" } | { kind: "wait"; ms: number } | { kind: "kill"; at: bigint };

/** Kill only once `now` has reached `at`; wait the remainder rounded up, never less. */
export function watchStep(at: bigint, now: bigint): WatchStep {
  if (at <= 0n) return { kind: "idle" };
  if (now < at) return { kind: "wait", ms: Number((at - now + NS_PER_MS - 1n) / NS_PER_MS) };
  return { kind: "kill", at };
}

/** The watch's claim: only if the cell still holds the expired time it read. */
export function claimKill(cell: BigInt64Array, at: bigint): boolean {
  return Atomics.compareExchange(cell, 0, at, KILLING) === at;
}

/** What one round of the watch uses: the clock, a wait on the cell (no ms: forever), the kill. */
export type WatchPorts = {
  readonly now: () => bigint;
  readonly wait: (value: bigint, ms?: number) => void;
  readonly kill: () => void;
};

/** One round of the watch: it waits on the very value it judged, and kills only by claiming it. */
export function watchOnce(cell: BigInt64Array, ports: WatchPorts): void {
  const at = Atomics.load(cell, 0);
  const step = watchStep(at, ports.now());
  if (step.kind === "idle") ports.wait(at);
  else if (step.kind === "wait") ports.wait(at, step.ms);
  else if (claimKill(cell, step.at)) ports.kill();
}

/**
 * Arms deadlines in `cell` on the clock `now`; `arm` returns the attempt's
 * release. A release at or after the deadline never returns: it calls `park`,
 * which holds the main thread until the watch's kill lands, so the caller
 * never acts on an attempt that outlived its time.
 */
export function createDeadlines(
  cell: BigInt64Array,
  now: () => bigint,
  park: () => never,
): { arm(ms: number): () => void } {
  const armed = new Map<symbol, bigint>();
  let published = 0n;
  function publish(): void {
    let earliest = 0n;
    for (const at of armed.values()) if (earliest === 0n || at < earliest) earliest = at;
    if (earliest === published) return;
    // A failed exchange means the watch claimed the kill: never overwrite it.
    if (Atomics.compareExchange(cell, 0, published, earliest) !== published) return;
    published = earliest;
    Atomics.notify(cell, 0);
  }
  return {
    arm(ms) {
      // An integer up to MAX_FENCE_MS, so the time in nanoseconds is exact.
      if (!Number.isInteger(ms) || ms < 1 || ms > MAX_FENCE_MS) throw new Error("fence_refused");
      const deadline = now() + BigInt(ms) * NS_PER_MS;
      // A deadline the cell cannot hold, or one that would read as 0 or KILLING.
      if (deadline <= 0n || deadline > CELL_MAX) throw new Error("fence_refused");
      const key = Symbol("attempt");
      armed.set(key, deadline);
      publish();
      return () => {
        const at = armed.get(key);
        if (at === undefined) return;
        // Released at or after its time: the attempt outlived it, stays
        // fenced, and its caller does not go on.
        // The cell already holds this time, so the watch's wait ends at it:
        // nothing is published and nothing is notified.
        if (now() >= at) park();
        armed.delete(key);
        publish();
      };
    },
  };
}
