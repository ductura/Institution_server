// The backup scheduler (S-1G-a part 2, DAN-1012-2; contract Ductus#2028
// c.6963924920). An hourly check reads the system settings of DAN-1012-1 and
// starts the job only when backup.enabled is exactly true and at least
// backup.interval_hours checks have come since start(), the last start of the
// job or the last time backup was seen off. The hourly timer starts again at
// each of those moments, after the read, so the hours count from then: two
// starts are never closer than interval_hours, and each start comes that much
// plus the time of its read after the one before. A busy check reads nothing.
// A check that starts nothing for a reason reports it with a closed code; one
// that only waits for its hour reports nothing. The job must not await
// stop(), which waits for the job. The settings reader, the job
// and the listener are handed in by the assembler of the background process,
// which does not exist yet: nothing starts this, so backup stays off (V-6).
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

/** One check an hour: backup.interval_hours is a whole number of hours. */
export const BACKUP_CHECK_MS = 3_600_000;

export type BackupSchedulerOptions = {
  /** The system level, key to value; a row without a value is left out. Anything but a Map is unavailable. */
  readonly readSettings: () => unknown;
  readonly run: () => unknown;
  /** Told of every skipped check; may be async, and never reaches the caller. */
  readonly onSkip: (reason: BackupSkipReason) => unknown;
};

export type BackupScheduler = {
  /** Starts the hourly check; a second call, or a call after stop, does nothing. */
  readonly start: () => void;
  /** Stops for good and waits for the job in progress, not for a settings read; never rejects. */
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
 * Map.prototype, so a subclass cannot answer for the Map, and anything that
 * is not a real Map (a Proxy, a bare Map prototype) throws into "unavailable".
 */
function decide(settings: unknown): number | BackupSkipReason {
  try {
    if (!(settings instanceof Map)) return "settings_unavailable";
    const has = (key: string): boolean => Map.prototype.has.call(settings, key);
    const get = (key: string): unknown => Map.prototype.get.call(settings, key);
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

const OFF: ReadonlySet<unknown> = new Set(["enabled_missing", "enabled_invalid", "disabled"]);

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { readSettings, run, onSkip } = options;
  for (const [name, fn] of Object.entries({ readSettings, run, onSkip })) {
    if (typeof fn !== "function") throw new RangeError(`${name} must be a function`);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let check: Promise<void> | undefined;
  let job: Promise<void> | undefined;
  /** Whole hours since the timer last (re)started. */
  let hours = 0;

  const skip = (reason: BackupSkipReason): void => {
    try {
      void Promise.resolve(onSkip(reason)).catch(() => undefined);
    } catch {
      // A failing listener never stops the scheduler.
    }
  };

  /** Hours count from now: the timer starts again and the count is 0. */
  const restart = (): void => {
    clearInterval(timer);
    hours = 0;
    if (stopped) return;
    timer = setInterval(tick, BACKUP_CHECK_MS);
    // The scheduler alone never keeps the process up.
    timer.unref();
  };

  const once = async (): Promise<void> => {
    let decision: number | BackupSkipReason;
    try {
      decision = decide(await readSettings());
    } catch {
      decision = "settings_unavailable";
    }
    if (stopped) return;
    if (OFF.has(decision)) restart();
    if (typeof decision === "string") return skip(decision);
    if (hours < decision) return;
    restart();
    job = (async () => {
      try {
        await run();
      } catch {
        skip("run_failed");
      }
    })();
    await job;
    job = undefined;
  };

  function tick(): void {
    hours += 1;
    if (check !== undefined) return skip("busy");
    check = once().finally(() => (check = undefined));
  }

  return Object.freeze({
    start(): void {
      if (stopped || timer !== undefined) return;
      restart();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await job;
    },
  });
}
