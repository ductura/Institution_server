// The backup scheduler (S-1G-a part 2, DAN-1012-2f and 2g; contracts
// Ductus#2028 c.6966729858, c.6967474538, c.6968668259, c.6970885582 and
// c.6974647087, option A of c.6965242237). A grid of points one hour apart
// from start(): each point is due at start + k hours on the monotonic clock,
// so nothing the job or a read does moves the grid. At a point the system
// settings of DAN-1012-1 are read, and run() is called only when
// backup.enabled is exactly true and at least backup.interval_hours points
// have come since the last call or since a check in time saw backup off. So
// run() is called at most once per interval of the grid, and exactly once
// when the job ends within it; when the backup really starts inside the job
// is the job's own concern. A read that ends at or after the next point calls
// nothing, so no call leaves the hour of its point. A point that comes while a
// check is going, or fell due while run() was going, is busy and reads
// nothing; points missed while the event loop was blocked still count. A
// point that calls nothing for a reason reports it with a closed code, as a
// macrotask after the tick has decided, so no callback changes a decision;
// the listener must only record (option C); one that only waits reports
// nothing. run()'s result is followed on one path only (2e), and onSkip's
// result on the same path (2g). The ports are trusted assembler code that
// leaves the built-ins alone (2f). stop(), from
// anywhere, stops what follows. The job must not await stop(), which waits for
// the job. The settings reader, the job and the listener are handed in by
// the assembler of the background process, which does not exist yet: nothing
// starts this, so backup stays off (V-6).
import { types } from "node:util";

import { defaultOf, fitsDefinition, settingOf, type SettingDefinition } from "../domain/index.ts";

/** Why a check did not start the job; `onSkip` gets only one of these, never a message. */
export const BACKUP_SKIP_REASONS = Object.freeze([
  "busy",
  "settings_unavailable",
  "enabled_missing",
  "enabled_invalid",
  "disabled",
  "interval_invalid",
  "run_failed",
] as const);

export type BackupSkipReason = (typeof BACKUP_SKIP_REASONS)[number];

/** One grid point an hour: backup.interval_hours is a whole number of hours. */
export const BACKUP_CHECK_MS = 3_600_000;

export type BackupSchedulerOptions = {
  /** The system level, key to value; a row without a value is left out. Anything but a Map is unavailable. */
  readonly readSettings: () => unknown;
  /**
   * The job; it is over when its promise settles, or when it returns or
   * throws. Any other object's then is read once, at once; a function is
   * followed through Promise.resolve, anything else ends the job.
   */
  readonly run: () => void | Promise<void>;
  /**
   * Told of every skipped check, after the tick has decided; may be async, and
   * never reaches the caller. It must only record and never block, also not
   * after an await: time it holds the event loop counts as delay of whatever
   * read or job is in progress, which may cost that point its call.
   */
  readonly onSkip: (reason: BackupSkipReason) => unknown;
};

export type BackupScheduler = {
  /** Starts the hourly check; a second call, or a call after stop, does nothing. */
  readonly start: () => void;
  /**
   * Stops for good and waits for the job in progress and the reasons already
   * queued for onSkip, not for a settings read; never rejects.
   */
  readonly stop: () => Promise<void>;
};

/** The catalogue definition of a backup key; its absence is a programming error. */
function definitionOf(key: string): SettingDefinition {
  const definition = settingOf(key);
  if (definition === undefined) throw new Error(`the settings catalogue has no ${key}`);
  return definition;
}

const ENABLED = definitionOf("backup.enabled");
const INTERVAL = definitionOf("backup.interval_hours");
const DEFAULT_INTERVAL = defaultOf(INTERVAL.key) as number;

/**
 * The interval in hours, or why not to run. Keys are read through
 * Map.prototype, a brand check: a real Map from any realm is read (no
 * instanceof, QA FAIL on #289), a subclass cannot answer for the Map, and
 * anything that is not a real Map (an object, a Proxy, a bare Map prototype,
 * undefined) throws into "unavailable".
 */
function decide(settings: unknown): number | BackupSkipReason {
  try {
    const has = (key: string): boolean =>
      Map.prototype.has.call(settings as Map<unknown, unknown>, key);
    const get = (key: string): unknown =>
      Map.prototype.get.call(settings as Map<unknown, unknown>, key);
    const enabled = get(ENABLED.key);
    if (enabled !== true) {
      if (!has(ENABLED.key)) return "enabled_missing";
      return enabled === false ? "disabled" : "enabled_invalid";
    }
    if (!has(INTERVAL.key)) return DEFAULT_INTERVAL;
    const interval = get(INTERVAL.key);
    return fitsDefinition(INTERVAL, interval) ? (interval as number) : "interval_invalid";
  } catch {
    return "settings_unavailable";
  }
}

// Read once at load, so a job that patches them cannot change how its own end
// is followed (DAN-1012-2e).
const apply = Reflect.apply;
const promiseThen = Promise.prototype.then;
const promiseResolve = Promise.resolve.bind(Promise);
const isPromise = types.isPromise;
const enqueue = queueMicrotask;

/**
 * Marks a callback's result as handled, read through Promise.prototype, so a
 * rejection is never unhandled, whatever its own then or catch do. A native
 * promise whose constructor getter throws cannot be handled by any means of
 * the language; the ports are trusted assembler code (known limit). Its
 * value is never handed on, so a then getter on it is not read again (QA
 * FAIL on #314).
 */
function ignoreRejection(value: unknown): void {
  try {
    apply(promiseThen, isPromise(value) ? value : promiseResolve(value), [
      () => undefined,
      () => undefined,
    ]);
  } catch {
    // A thenable whose then getter throws rejects the wrapper, handled above.
  }
}

/** Whether a value can carry a then. */
const objectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * Calls a job's then with call backs of which only the first call of either
 * has an effect, as with the engine's own, so a later one is never even
 * normalized and leaves nothing unhandled (Codex review on #314). A then that
 * throws closes them too, so a call back it queued first has no effect either
 * (Review FAIL on #314, 6a82a19).
 */
function callThen(
  then: unknown,
  target: unknown,
  ok: (value: unknown) => void,
  fail: (reason: unknown) => void,
): void {
  let called = false;
  const settle = (value: unknown): void => {
    if (called) return;
    called = true;
    ok(settledBy(value));
  };
  const reject = (reason: unknown): void => {
    if (called) return;
    called = true;
    // A native promise as the reason reaches only the scheduler, which drops
    // the reason, so it is marked handled here (QA attacker on 2g).
    if (isPromise(reason)) ignoreRejection(reason);
    fail(reason);
  };
  try {
    apply(then as (...args: unknown[]) => unknown, target, [settle, reject]);
  } catch (error) {
    reject(error);
  }
}

/**
 * What a job's thenable resolves with, made safe to hand to the engine: the
 * same outcome, with no then of the job's read twice (contract attacker on
 * 2f). A native promise of any realm is followed through Promise.prototype,
 * also one with then: undefined; a thenable through its then, read once, and
 * the same at every depth; any other value is only an end, so it is dropped.
 */
function settledBy(value: unknown): unknown {
  if (isPromise(value)) {
    return new Promise((resolve, reject) => {
      // Only the end counts: the value is dropped, so a then getter on it
      // is never read again (QA FAIL on #314).
      ignoreRejection(apply(promiseThen, value, [() => resolve(undefined), reject]));
    });
  }
  if (!objectLike(value)) return undefined;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    return { then: (_ok: unknown, fail: () => void) => fail() };
  }
  if (typeof then !== "function") return undefined;
  return {
    then: (ok: (next: unknown) => void, fail: (reason: unknown) => void) =>
      callThen(then, value, ok, fail),
  };
}

/**
 * Marks an onSkip result handled on the same path as run()'s result
 * (DAN-1012-2g): through settledBy, so a native promise of any realm is
 * followed through Promise.prototype, a thenable's then is read once per
 * call of settledBy, and a promise a thenable resolves with, whatever its own
 * then, is followed at every depth, not taken as a value (Review and QA FAIL
 * on #314, 66b4dd8b).
 */
function ignoreResult(value: unknown): void {
  ignoreRejection(settledBy(value));
}

const OFF: ReadonlySet<unknown> = new Set(["enabled_missing", "enabled_invalid", "disabled"]);

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { readSettings, run, onSkip } = options;
  for (const [name, fn] of Object.entries({ readSettings, run, onSkip })) {
    if (typeof fn !== "function") throw new RangeError(`${name} must be a function`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** performance.now() at start(); grid point k is due at origin + k hours. */
  let origin = 0;
  /** The last grid point handled. */
  let point = 0;
  let stopped = false;
  let check: Promise<void> | undefined;
  let job: Promise<void> | undefined;
  /** Reasons queued for onSkip and not yet handed over; stop() waits for them. */
  let undelivered = 0;
  /** stop() calls waiting for undelivered to reach 0. */
  let drained: (() => void)[] = [];
  /** performance.now() when the last run() ended; an unhandled point due before it is busy. */
  let jobEnded = Number.NEGATIVE_INFINITY;
  /** Grid points since the last call of run(), or since backup was last seen off. */
  let hours = 0;

  // A reason reaches the listener as a macrotask (DAN-1012-2c, option C):
  // after the tick's decision, after the continuation of a read that has
  // already resolved and after a job's end is recorded, so a listener never
  // changes them. A listener that blocks while a read or job is still pending
  // is the port's known limit: it counts as read delay. A failing listener
  // never stops the scheduler.
  // Counted, not collected in promises: stop() then needs no Promise static
  // a job may have replaced (Review and QA FAIL on #312).
  const skip = (reason: BackupSkipReason): void => {
    undelivered += 1;
    setImmediate(() => {
      try {
        ignoreResult(onSkip(reason));
      } catch {
        // Nothing reaches the caller.
      }
      undelivered -= 1;
      if (undelivered > 0) return;
      const waiting = drained;
      drained = [];
      for (const resume of waiting) resume();
    });
  };

  const once = async (at: number): Promise<void> => {
    let decision: number | BackupSkipReason;
    try {
      decision = decide(await readSettings());
    } catch {
      decision = "settings_unavailable";
    }
    if (stopped) return;
    // The next point is due: a call now would leave the hour of its point,
    // whichever timer callback the event loop runs first.
    if (performance.now() >= origin + (at + 1) * BACKUP_CHECK_MS) {
      return skip("settings_unavailable");
    }
    if (OFF.has(decision)) hours = 0;
    if (typeof decision === "string") return skip(decision);
    if (hours < decision) return;
    hours = 0;
    // DAN-1012-2e (contract Ductus#2028 c.6968668259): run()'s result is
    // followed on one path only. One native promise of this realm, made before
    // run() is called, is settled by the same call that records the end; the
    // job, stop() and this check wait only for it. No value is passed on: a
    // nested thenable is followed as await would, and then the job is over.
    let done!: () => void;
    let failed!: () => void;
    /** Set while a reaction can only be to a promise already settled at return. */
    let returnedAt: number | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      // Each is called at most once: by one reaction, or by run()'s return or throw.
      const finish = (ok: boolean) => (): void => {
        jobEnded = returnedAt ?? performance.now();
        if (ok) resolve();
        else reject(new Error("run_failed"));
      };
      done = finish(true);
      failed = finish(false);
    });
    // The job exists before run() is called, so a stop() from inside run()
    // still waits for it (Review FAIL on #283).
    // Through the then taken at load, as every reaction the scheduler
    // registers itself (Review FAIL on #312).
    const current = apply(promiseThen, settled, [
      () => undefined,
      () => skip("run_failed"),
    ]) as Promise<void>;
    job = current;
    try {
      const result = run();
      if (isPromise(result)) {
        // A native promise of any realm, read through Promise.prototype: its
        // own then is never read (Review and QA FAIL on #306).
        // A reaction to a promise settled by the time then returns is queued
        // ahead of the probe; any other only once it settles, after the probe.
        // So one that comes first ended by then, whatever other code queued
        // before it (QA attacker on #312). The time is read after then, which
        // may run a constructor getter (Review and QA FAIL on #312).
        // The promise then derives through species is marked handled, so a
        // species that makes it rejected leaves nothing unhandled (Review FAIL
        // on #312).
        ignoreRejection(apply(promiseThen, result, [done, failed]));
        returnedAt = performance.now();
        enqueue(() => (returnedAt = undefined));
      } else if (objectLike(result)) {
        // Any other object: its then is read here, once and at once, so a
        // getter that throws fails the job now, not in a reaction behind
        // other microtasks (QA FAIL on #312). A then that is no function ends
        // the job now, as await would. Otherwise Promise.resolve gets a
        // wrapper that calls the then already read, one microtask later, and
        // follows what it resolves with as settledBy does.
        const then: unknown = (result as { then?: unknown }).then;
        if (typeof then !== "function") {
          done();
        } else {
          const thenable = {
            then: (ok: (value: unknown) => void, fail: (reason: unknown) => void) =>
              callThen(then, result, ok, fail),
          };
          apply(promiseThen, promiseResolve(thenable), [done, failed]);
        }
      } else {
        done();
      }
    } catch {
      // A synchronous throw, or a native promise on which then throws (its
      // constructor or species): no means of the language can follow it, so
      // it counts as over (known limit, README).
      failed();
    }
    await current;
    job = undefined;
  };

  /** Waits for the next grid point, due at an absolute time. */
  const schedule = (): void => {
    if (stopped) return;
    const due = origin + (point + 1) * BACKUP_CHECK_MS;
    // Rounded up and never 0: Node truncates a fractional delay, which could
    // call back before the point (Review FAIL on #289).
    timer = setTimeout(tick, Math.max(1, Math.ceil(due - performance.now())));
    // The scheduler alone never keeps the process up.
    timer.unref();
  };

  function tick(): void {
    // Every point due by now counts, also those a blocked event loop merged.
    const due = Math.floor((performance.now() - origin) / BACKUP_CHECK_MS);
    // Called back before the next point is due: count nothing, wait again.
    if (due <= point) return schedule();
    const passed = due - point;
    point += passed;
    hours += passed;
    // A point is busy while a check is still going, or when it fell due before
    // the last run() ended, even if its callback only came after a synchronous
    // job freed the loop (QA on #289). A job starts within the hour of its own
    // point (late-read rule), so any later point due before its end fell due
    // during it. Only the scheduler's own work counts: time a listener took
    // never makes a point busy (DAN-1012-2b).
    let busy = passed;
    if (check === undefined) {
      busy = 0;
      for (let p = point - passed + 1; p <= point; p += 1) {
        if (origin + p * BACKUP_CHECK_MS < jobEnded) busy += 1;
      }
    }
    for (let i = 0; i < busy; i += 1) skip("busy");
    if (busy < passed && check === undefined) {
      // Cleared through the then taken at load, not .finally(), which reads
      // Promise.prototype.then live (Review and QA FAIL on #312).
      const clear = (): void => {
        check = undefined;
      };
      check = once(point);
      apply(promiseThen, check, [clear, clear]);
    }
    schedule();
  }

  return Object.freeze({
    start(): void {
      if (stopped || timer !== undefined) return;
      origin = performance.now();
      schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await job;
      if (undelivered > 0) await new Promise<void>((resume) => drained.push(resume));
    },
  });
}
