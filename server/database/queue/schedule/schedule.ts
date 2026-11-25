// SRV-1303 (M10.0-S2; D-273 MQ08, MQ14): the worker's schedule over the
// pg-boss queue. Each job registers itself from its own folder through
// registerScheduledJob(definition), so a later job (a dry run, the daily root)
// adds a folder and changes no file here. On each run the schedule queues the
// current slot of every job (its body is the slot id alone, through
// parseJobBody, D-74) and runs one queued job of each.
//
// A job carries a mode, "execute" or "dry-run". Until decision D-30 only the
// jobs on EXECUTE_ALLOWED execute; every other job, and every job whose mode
// is anything but "execute", runs as a dry run: the schedule calls only its
// `candidates` and records the number, and never calls `execute`. Whatever a
// job does, it does for the slot's start, never for the clock at the time it
// runs, so a second run of one slot finds nothing more to do.
//
// No pg-boss here: the queue is a port (the types of server/database/queue),
// so the web bundle that exports this folder never loads the package.
import { isJobDefinition, type JobDefinition } from "../../../domain/index.ts";
import type { JobHandler, JobOutcome, JobQueue } from "../index.ts";

import { slotId, slotOf, slotStart } from "./slot.ts";

export type ScheduledJobMode = "execute" | "dry-run";

/**
 * Before D-30, the only jobs that may change data. Everything else is a dry run.
 * purge_orphan_work_data by the owner's decision of 24 Nov 2026 (SRV-MENTOR-3C):
 * it removes only rows of works whose document no longer exists.
 */
export const EXECUTE_ALLOWED: readonly string[] = Object.freeze([
  "purge_ended_sessions",
  "purge_orphan_work_data",
]);

/** The one field of a scheduled job's body: the id of its slot (slot.ts). */
export const SLOT_FIELD = "slotId";

/** Bounds of a slot: a whole minute at least, a week at most. */
export const SLOT_MIN_MS = 60_000;
export const SLOT_MAX_MS = 7 * 86_400_000;

export type ScheduledJobDefinition = {
  /** The queue name ([a-z][a-z0-9_]*). */
  readonly name: string;
  /** "execute" acts only for a job on EXECUTE_ALLOWED; any other value is a dry run. */
  readonly mode: ScheduledJobMode;
  /** The length of a slot, in whole minutes. */
  readonly everyMs: number;
  /** How many rows the job would act on in the slot that starts at `slot`. Changes nothing. */
  readonly candidates: (slot: Date, signal: AbortSignal) => Promise<number>;
  /** Acts on the slot that starts at `slot` and returns how many rows it changed. */
  readonly execute: (slot: Date, signal: AbortSignal) => Promise<number>;
};

export type RegisterScheduledJob = (definition: ScheduledJobDefinition) => void;

export type ScheduleErrorCode =
  "definition_invalid" | "definition_duplicate" | "schedule_sealed" | "schedule_empty";

/** The message is the code. */
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  constructor(code: ScheduleErrorCode) {
    super(code);
    this.name = "ScheduleError";
    this.code = code;
  }
}

/** A failure a job's port reports by a closed code ([a-z][a-z0-9_]*), stored as the job's outcome. */
export class ScheduledJobError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ScheduledJobError";
    this.code = code;
  }
}

/** What one run recorded for one job: the count only, never a row. */
export type ScheduledRun = {
  readonly name: string;
  readonly mode: ScheduledJobMode;
  /** The start of the slot the job ran for (ISO 8601). */
  readonly slot: string;
  /** Rows changed (execute) or rows that would be (dry run). */
  readonly count: number;
};

export type ScheduleTick = {
  readonly name: string;
  readonly enqueued: "queued" | "duplicate" | "rejected" | "skipped";
  readonly outcome: JobOutcome;
};

/** The two methods of the queue the schedule uses. */
export type ScheduleQueue = Pick<JobQueue, "enqueue" | "runOnce">;

export type JobSchedule = {
  readonly registerScheduledJob: RegisterScheduledJob;
  /** The queue definitions of the registered jobs, for openJobQueue. Seals the schedule. */
  queueDefinitions(): readonly JobDefinition[];
  /** The mode each registered job runs in. */
  modes(): Readonly<Record<string, ScheduledJobMode>>;
  /** Queues the current slot of each job and runs one queued job of each, in registration order. */
  run(queue: ScheduleQueue, now: Date): Promise<readonly ScheduleTick[]>;
};

export type JobScheduleOptions = {
  /** Called once for each job that ran, with its count. */
  readonly onRun?: (run: ScheduledRun) => void;
};

const CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** The mode a definition runs in: execute only when it says so and is on EXECUTE_ALLOWED. */
export function effectiveMode(
  definition: Pick<ScheduledJobDefinition, "name" | "mode">,
): ScheduledJobMode {
  return definition.mode === "execute" && EXECUTE_ALLOWED.includes(definition.name)
    ? "execute"
    : "dry-run";
}

/** A definition read once into a frozen copy, or null; a getter of the caller's object never runs again. */
function readDefinition(value: unknown): ScheduledJobDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, mode, everyMs, candidates, execute } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof candidates !== "function" || typeof execute !== "function")
    return null;
  if (
    typeof everyMs !== "number" ||
    !Number.isInteger(everyMs) ||
    everyMs < SLOT_MIN_MS ||
    everyMs > SLOT_MAX_MS ||
    everyMs % 60_000 !== 0
  )
    return null;
  if (!isJobDefinition({ name, fields: [SLOT_FIELD], subject: SLOT_FIELD })) return null;
  // Anything but the exact word is a dry run (effectiveMode), never refused.
  const read: ScheduledJobMode = mode === "execute" ? "execute" : "dry-run";
  return Object.freeze({
    name,
    mode: read,
    everyMs,
    candidates: candidates as ScheduledJobDefinition["candidates"],
    execute: execute as ScheduledJobDefinition["execute"],
  });
}

function codeOf(thrown: unknown): string {
  try {
    return thrown instanceof ScheduledJobError && CODE.test(thrown.code)
      ? thrown.code
      : "job_threw";
  } catch {
    return "job_threw";
  }
}

export function createJobSchedule(options: JobScheduleOptions = {}): JobSchedule {
  const jobs = new Map<string, ScheduledJobDefinition>();
  // The last slot this process queued for each job: a later run in the same slot does not queue it again.
  const queued = new Map<string, number>();
  let sealed = false;

  function registerScheduledJob(definition: ScheduledJobDefinition): void {
    if (sealed) throw new ScheduleError("schedule_sealed");
    let read: ScheduledJobDefinition | null;
    try {
      read = readDefinition(definition);
    } catch {
      // Only a getter or a proxy throws here.
      read = null;
    }
    if (read === null) throw new ScheduleError("definition_invalid");
    if (jobs.has(read.name)) throw new ScheduleError("definition_duplicate");
    jobs.set(read.name, read);
  }

  function seal(): void {
    if (jobs.size === 0) throw new ScheduleError("schedule_empty");
    sealed = true;
  }

  function handlerFor(job: ScheduledJobDefinition, now: Date): JobHandler {
    const mode = effectiveMode(job);
    return async (body, signal) => {
      const start = slotOf(job.name, body[SLOT_FIELD] ?? "");
      if (start === null) return { ok: false, code: "invalid_slot" };
      // A slot that has not started is not run: its cut would be later than the clock allows.
      if (start > now.getTime()) return { ok: false, code: "slot_in_future" };
      const slot = new Date(start);
      let count: unknown;
      try {
        // The dry run never reaches execute, whatever the job is.
        count =
          mode === "execute" ? await job.execute(slot, signal) : await job.candidates(slot, signal);
      } catch (thrown) {
        return { ok: false, code: codeOf(thrown) };
      }
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        return { ok: false, code: "invalid_count" };
      options.onRun?.({ name: job.name, mode, slot: slot.toISOString(), count });
      return { ok: true };
    };
  }

  return {
    registerScheduledJob,
    queueDefinitions() {
      seal();
      return Object.freeze(
        [...jobs.keys()].map((name) =>
          Object.freeze({ name, fields: Object.freeze([SLOT_FIELD]), subject: SLOT_FIELD }),
        ),
      );
    },
    modes() {
      return Object.freeze(
        Object.fromEntries([...jobs.values()].map((job) => [job.name, effectiveMode(job)])),
      );
    },
    async run(queue, now) {
      seal();
      const ticks: ScheduleTick[] = [];
      for (const job of jobs.values()) {
        const start = slotStart(now.getTime(), job.everyMs);
        let enqueued: ScheduleTick["enqueued"] = "skipped";
        if (queued.get(job.name) !== start) {
          enqueued = await queue.enqueue(job.name, { [SLOT_FIELD]: slotId(job.name, start) });
          if (enqueued !== "rejected") queued.set(job.name, start);
        }
        const outcome = await queue.runOnce(job.name, handlerFor(job, now));
        ticks.push(Object.freeze({ name: job.name, enqueued, outcome }));
      }
      return Object.freeze(ticks);
    },
  };
}
