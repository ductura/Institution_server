// The backup scheduler (S-1G-a part 2, DAN-1012-2c; contracts Ductus#2028
// c.6966729858 and c.6967474538, option A of c.6965242237). A grid of points one hour apart
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
// nothing. stop(), from anywhere, stops
// what follows. The job must not await stop(), which waits for the job. The settings reader, the job and the
// listener are handed in by the assembler of the background process, which
// does not exist yet: nothing starts this, so backup stays off (V-6).
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
  readonly run: () => unknown;
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

/**
 * Marks a callback's result as handled, read through Promise.prototype, so a
 * rejection is never unhandled, whatever its own then or catch do. A native
 * promise whose constructor getter throws cannot be handled by any means of
 * the language; the ports are trusted assembler code (known limit).
 */
function ignoreRejection(value: unknown): void {
  try {
    const settled = types.isPromise(value) ? value : Promise.resolve(value);
    void Promise.prototype.then.call(settled, undefined, () => undefined);
  } catch {
    // A thenable whose then getter throws rejects the wrapper, handled above.
  }
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
  const deliveries = new Set<Promise<void>>();
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
  const skip = (reason: BackupSkipReason): void => {
    const delivered = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          ignoreRejection(onSkip(reason));
        } catch {
          // Nothing reaches the caller.
        }
        resolve();
      });
    });
    deliveries.add(delivered);
    void delivered.then(() => deliveries.delete(delivered));
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
    // The job exists before run() is called, so a stop() from inside run()
    // still waits for it (Review FAIL on #283).
    let finished!: () => void;
    job = new Promise<void>((resolve) => (finished = resolve));
    let running: unknown;
    try {
      running = run();
    } catch (error: unknown) {
      running = Promise.reject(error);
    }
    try {
      await running;
    } catch {
      skip("run_failed");
    } finally {
      jobEnded = performance.now();
      job = undefined;
      finished();
    }
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
      check = once(point).finally(() => (check = undefined));
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
      await Promise.all([...deliveries]);
    },
  });
}
