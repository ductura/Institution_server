// A clock that moves only when a test moves it (U9, DAN-741). `sleep` resolves
// when `advance` reaches its deadline, in deadline order, never on its own.

export type FakeClock = {
  /** The current time as a Date. */
  now(): Date;
  /** The current time in milliseconds since the epoch. */
  nowMs(): number;
  /** Moves the clock forward and wakes every sleeper whose deadline passed. */
  advance(ms: number): void;
  /** Resolves once the clock has moved `ms` forward; an abort rejects it. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

type Sleeper = { readonly at: number; readonly wake: () => void };

function assertDuration(ms: number, name: string): void {
  if (!Number.isFinite(ms) || ms < 0)
    throw new RangeError(`${name} must be a finite number of milliseconds >= 0: ${ms}`);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** A fake clock starting at `start` (ISO 8601 with a zone, or ms since the epoch). */
export function createFakeClock(start: string | number = "2026-01-01T00:00:00.000Z"): FakeClock {
  let current = typeof start === "number" ? start : Date.parse(start);
  if (!Number.isFinite(current)) throw new RangeError(`invalid start time: ${String(start)}`);
  let sleepers: Sleeper[] = [];

  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance(ms) {
      assertDuration(ms, "advance");
      current += ms;
      const due = sleepers.filter((s) => s.at <= current).sort((a, b) => a.at - b.at);
      sleepers = sleepers.filter((s) => s.at > current);
      for (const sleeper of due) sleeper.wake();
    },
    sleep(ms, signal) {
      assertDuration(ms, "sleep");
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (ms === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          sleepers = sleepers.filter((s) => s !== sleeper);
          reject(abortError(signal as AbortSignal));
        };
        const sleeper: Sleeper = {
          at: current + ms,
          wake: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        sleepers.push(sleeper);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
