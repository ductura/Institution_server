// The backup scheduler (S-1G-a part 2, DAN-1012-2a; contract Ductus#2028
// c.6965270952, option A of c.6965242237). One timer ticks every hour from
// start(), a fixed grid that nothing moves. On a tick the system settings of
// DAN-1012-1 are read, and run() is called only when backup.enabled is
// exactly true and at least backup.interval_hours ticks have come since the
// last call or since backup was last seen off. So run() is called at most once
// per interval of the grid, and exactly once when the job ends within it; when
// the backup really starts inside the job is the job's own concern. A read
// still going when the next tick comes calls nothing, so no call leaves the
// hour of its tick. A busy tick reads nothing. A tick that calls nothing for a
// reason reports it with a closed code; one that only waits reports nothing.
// The job must not await stop(), which waits for the job. The settings
// reader, the job and the listener are handed in by the assembler of the
// background process, which does not exist yet: nothing starts this, so
// backup stays off (V-6).
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
  /** Ticks since the last call of run(), or since backup was last seen off. */
  let hours = 0;
  /** Ticks that came while the current check was still going. */
  let late = 0;

  const skip = (reason: BackupSkipReason): void => {
    try {
      void Promise.resolve(onSkip(reason)).catch(() => undefined);
    } catch {
      // A failing listener never stops the scheduler.
    }
  };

  const once = async (): Promise<void> => {
    let decision: number | BackupSkipReason;
    try {
      decision = decide(await readSettings());
    } catch {
      decision = "settings_unavailable";
    }
    if (stopped) return;
    // The next tick came during the read: a call now would leave its hour.
    if (late > 0) return skip("settings_unavailable");
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
      job = undefined;
      finished();
    }
  };

  function tick(): void {
    hours += 1;
    if (check !== undefined) {
      late += 1;
      return skip("busy");
    }
    late = 0;
    check = once().finally(() => (check = undefined));
  }

  return Object.freeze({
    start(): void {
      if (stopped || timer !== undefined) return;
      timer = setInterval(tick, BACKUP_CHECK_MS);
      // The scheduler alone never keeps the process up.
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await job;
    },
  });
}
