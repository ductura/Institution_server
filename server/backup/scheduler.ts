// The backup scheduler (S-1G-a part 2, DAN-1012-2; contract Ductus#2028
// c.6963924920). One check an hour reads the system settings of DAN-1012-1
// and starts the job only when backup.enabled is exactly true and at least
// backup.interval_hours hours have passed since the last start (or since it
// was turned on). Every other check is skipped with a closed reason. The
// settings reader, the job and the listener are handed in by the assembler of
// the background process, which does not exist yet: nothing starts this, so
// backup stays off (V-6 is the owner's).
import { fitsDefinition, settingOf, type SettingDefinition } from "../domain/index.ts";

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
  /** Stops for good and waits for the check in progress; never rejects. */
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
const DEFAULT_INTERVAL = Number(INTERVAL.default);

/** Read through Map.prototype.get, so a subclass cannot answer for the Map. */
const get = (settings: Map<unknown, unknown>, key: string): unknown =>
  Map.prototype.get.call(settings, key);
const has = (settings: Map<unknown, unknown>, key: string): boolean =>
  Map.prototype.has.call(settings, key);

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { readSettings, run, onSkip } = options;
  for (const [name, fn] of Object.entries({ readSettings, run, onSkip })) {
    if (typeof fn !== "function") throw new RangeError(`${name} must be a function`);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let check: Promise<void> | undefined;
  /** Whole hours since the last start, or since backup was last off. */
  let hours = 0;

  const skip = (reason: BackupSkipReason): void => {
    try {
      void Promise.resolve(onSkip(reason)).catch(() => undefined);
    } catch {
      // A failing listener never stops the scheduler.
    }
  };

  /** The interval in hours, or the reason not to run; `hours` is reset when backup is off. */
  const decide = async (): Promise<number | BackupSkipReason> => {
    let settings: unknown;
    try {
      settings = await readSettings();
    } catch {
      return "settings_unavailable";
    }
    if (!(settings instanceof Map)) return "settings_unavailable";
    const enabled = get(settings, ENABLED.key);
    if (enabled !== true) {
      hours = 0;
      if (!has(settings, ENABLED.key)) return "enabled_missing";
      return enabled === false ? "disabled" : "enabled_invalid";
    }
    if (!has(settings, INTERVAL.key)) return DEFAULT_INTERVAL;
    const interval = get(settings, INTERVAL.key);
    return fitsDefinition(INTERVAL, interval) ? (interval as number) : "interval_invalid";
  };

  const once = async (): Promise<void> => {
    const decision = await decide();
    if (typeof decision === "string") return skip(decision);
    if (hours < decision) return;
    hours = 0;
    try {
      await run();
    } catch {
      skip("run_failed");
    }
  };

  const tick = (): void => {
    hours += 1;
    if (check !== undefined) return skip("busy");
    check = once().finally(() => (check = undefined));
  };

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
      await check;
    },
  });
}
