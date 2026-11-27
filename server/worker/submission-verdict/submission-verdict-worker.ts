// The worker that reconstructs recorded submissions once more (F4-PM2-R01,
// Ductus#2059). The submission route stays synchronous and unchanged; this
// worker, on its own login (ductus_worker), lists the submissions of its
// evidence domain that have no verdict, reconstructs each with the same checks
// as the route and asks the database to keep the verdict. Passes run every
// `intervalMs`; one structured log line per pass carries counts only, never an
// id, text or hash. A submission whose reconstruction could not run keeps no
// verdict and is tried again in a later pass.
import {
  runSubmissionVerdictPass,
  type SubmissionVerdictDeps,
  type SubmissionVerdictPass,
} from "../../evidence/index.ts";
import type { LogEvent } from "../../log/index.ts";

export const SUBMISSION_VERDICT_PASS_EVENT = "worker.submission_verdict.pass";
export const SUBMISSION_VERDICT_FAILED_EVENT = "worker.submission_verdict.pass_failed";
export const MAX_SUBMISSION_VERDICT_INTERVAL_MS = 3_600_000;

export type SubmissionVerdictTimers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type SubmissionVerdictWorkerDeps = {
  /** The reconstruction pass's ports; the domain is the worker's configuration. */
  verdict: SubmissionVerdictDeps;
  log: LogEvent;
  /** Pause between the end of one pass and the start of the next; default 10 s. */
  intervalMs?: number;
  timers?: SubmissionVerdictTimers;
};

export type SubmissionVerdictWorker = {
  /** Join a running pass or start one now. Null when stopped and idle, or when the pass failed. */
  runPass(): Promise<SubmissionVerdictPass | null>;
  start(): void;
  /** No pass is started after this; resolves once the running pass has ended. */
  stop(): Promise<void>;
};

const DEFAULT_TIMERS: SubmissionVerdictTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSubmissionVerdictWorker(
  deps: SubmissionVerdictWorkerDeps,
): SubmissionVerdictWorker {
  if (typeof deps.log !== "function")
    throw new TypeError("submissionVerdictWorker: log is required");
  const intervalMs = deps.intervalMs ?? 10_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > MAX_SUBMISSION_VERDICT_INTERVAL_MS
  ) {
    throw new RangeError("submissionVerdictWorker: invalid config");
  }
  const timers = deps.timers ?? DEFAULT_TIMERS;
  let running: Promise<SubmissionVerdictPass | null> | null = null;
  let timer: unknown = null;
  // Where the next pass goes on; null starts from the oldest submission again.
  let cursor: string | null = null;
  let started = false;
  let stopped = false;

  async function pass(): Promise<SubmissionVerdictPass | null> {
    try {
      const { pass: done, next } = await runSubmissionVerdictPass(deps.verdict, cursor);
      cursor = next;
      deps.log(done.unavailable === 0 ? "info" : "warn", SUBMISSION_VERDICT_PASS_EVENT, {
        ...done,
      });
      return done;
    } catch {
      // The pass answers counts; this is only for a configuration or programming error.
      deps.log("error", SUBMISSION_VERDICT_FAILED_EVENT, {});
      return null;
    }
  }

  function runPass(): Promise<SubmissionVerdictPass | null> {
    if (running === null) {
      if (stopped) return Promise.resolve(null);
      running = pass().finally(() => {
        running = null;
      });
    }
    return running;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (stopped) return;
      void runPass().then(() => schedule(intervalMs));
    }, ms);
  }

  return {
    runPass,
    start() {
      if (started || stopped) return;
      started = true;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      if (running !== null) await running;
    },
  };
}
