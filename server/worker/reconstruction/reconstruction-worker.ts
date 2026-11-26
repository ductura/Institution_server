// The worker that writes reconstruction checkpoints (F4-PM2-R02, plan M3.3,
// B-12). SRV-1503 made `recordDueCheckpoints`; this file is the caller it
// lacked: every `intervalMs` it asks the database which packages have a chain
// at least one interval long and no checkpoint at the newest due revision, and
// has the package recorder write what is missing. The pieces (the database
// reads, the storage reads, the verification and the replay) already exist in
// `evidence`; this file only runs them in passes:
//
// - a pass walks the due packages by id, one page at a time, and stops after
//   `maxPackages` packages, so the packages after the cursor wait for the next
//   pass and a package that never reproduces cannot hold up the rest forever
//   (the next pass starts from the beginning, the same ones first, and a
//   package that is `skipped` is counted, not retried inside the pass);
// - one structured log line per pass carries counts only, never an id or a
//   text of a package.
//
// Writing a checkpoint twice is harmless (`exists` is the first one staying),
// so a pass repeated after a crash never makes a second, different checkpoint.
import type {
  DuePackagesResult,
  PackageCheckpointRecorder,
  WorkerEvidenceChainSource,
} from "../../evidence/index.ts";
import type { LogEvent } from "../../log/index.ts";

/** The event of the one log line each pass writes. */
export const RECONSTRUCTION_PASS_EVENT = "worker.reconstruction_checkpoints.pass";
/** The event written when a pass could not run at all. */
export const RECONSTRUCTION_FAILED_EVENT = "worker.reconstruction_checkpoints.pass_failed";

export const MAX_RECONSTRUCTION_INTERVAL_MS = 3_600_000;
export const MAX_RECONSTRUCTION_PACKAGES_PER_PASS = 10_000;
export const MAX_RECONSTRUCTION_PAGE = 500;
/** The cadence of SRV-1503 (`RECONSTRUCTION_CHECKPOINT_INTERVAL`), one place for the worker's own copy. */
const DEFAULT_CHECKPOINT_INTERVAL = 50;

export type ReconstructionWorkerConfig = {
  /** Pause between the end of one pass and the start of the next. */
  intervalMs: number;
  /** Accepted segments between two checkpoints. */
  checkpointInterval: number;
  /** Packages asked for in one read. */
  pageSize: number;
  /** Packages one pass handles at most. */
  maxPackages: number;
};

export const DEFAULT_RECONSTRUCTION_WORKER_CONFIG: Readonly<ReconstructionWorkerConfig> =
  Object.freeze({
    intervalMs: 60_000,
    checkpointInterval: DEFAULT_CHECKPOINT_INTERVAL,
    pageSize: 50,
    maxPackages: 500,
  });

export type ReconstructionWorkerTimers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type ReconstructionWorkerDeps = {
  /** The worker's read of the due packages (`createWorkerEvidenceChainSource`). */
  source: Pick<WorkerEvidenceChainSource, "listDue">;
  /** Writes the missing checkpoints of one package (`createPackageCheckpointRecorder`). */
  recorder: PackageCheckpointRecorder;
  log: LogEvent;
  timers?: ReconstructionWorkerTimers;
  config?: Partial<ReconstructionWorkerConfig>;
};

export type ReconstructionPassSummary = {
  /** `completed` read every due package up to the limit; `stopped` met a read that did not answer. */
  status: "completed" | "stopped";
  /** True when more due packages were left for the next pass (the limit was reached). */
  more: boolean;
  packages: number;
  recorded: number;
  checkpointsWritten: number;
  current: number;
  skipped: number;
  unavailable: number;
};

export type ReconstructionWorker = {
  /** Join a running pass or start one now. Returns null when stopped and idle. */
  runPass(): Promise<ReconstructionPassSummary | null>;
  /** A pass now, then a pass every `intervalMs` until `stop`. */
  start(): void;
  /** No pass is started after this; resolves once the running pass has ended. */
  stop(): Promise<void>;
};

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function checkedConfig(given: Partial<ReconstructionWorkerConfig> | undefined) {
  const config = { ...DEFAULT_RECONSTRUCTION_WORKER_CONFIG, ...given };
  if (
    !inRange(config.intervalMs, 1, MAX_RECONSTRUCTION_INTERVAL_MS) ||
    !inRange(config.checkpointInterval, 1, 100_000) ||
    !inRange(config.pageSize, 1, MAX_RECONSTRUCTION_PAGE) ||
    !inRange(config.maxPackages, 1, MAX_RECONSTRUCTION_PACKAGES_PER_PASS)
  ) {
    throw new RangeError("reconstructionWorker: invalid config");
  }
  return config;
}

const DEFAULT_TIMERS: ReconstructionWorkerTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The fields of the pass's log line: counts only, no key a redactor would hide. */
export function reconstructionPassFields(
  summary: ReconstructionPassSummary,
): Record<string, unknown> {
  return { ...summary };
}

/**
 * The reconstruction checkpoint worker over the worker's own ports (D-71,
 * D-102): the web process never builds it. A pass that meets a read that does
 * not answer stops there and logs a warning; what was written before stays.
 */
export function createReconstructionWorker(deps: ReconstructionWorkerDeps): ReconstructionWorker {
  const { source, recorder, log } = deps;
  if (typeof log !== "function") throw new TypeError("reconstructionWorker: log is required");
  if (typeof source?.listDue !== "function")
    throw new TypeError("reconstructionWorker: source is required");
  if (typeof recorder?.recordPackage !== "function")
    throw new TypeError("reconstructionWorker: recorder is required");
  const config = checkedConfig(deps.config);
  const timers = deps.timers ?? DEFAULT_TIMERS;

  let running: Promise<ReconstructionPassSummary | null> | null = null;
  let timer: unknown = null;
  let started = false;
  let stopped = false;

  async function sweep(): Promise<ReconstructionPassSummary> {
    const summary: ReconstructionPassSummary = {
      status: "completed",
      more: false,
      packages: 0,
      recorded: 0,
      checkpointsWritten: 0,
      current: 0,
      skipped: 0,
      unavailable: 0,
    };
    let after: string | null = null;
    while (!stopped) {
      const room = config.maxPackages - summary.packages;
      if (room <= 0) {
        summary.more = true;
        break;
      }
      const page: DuePackagesResult = await (async (): Promise<DuePackagesResult> =>
        source.listDue({
          interval: config.checkpointInterval,
          afterPackageId: after,
          limit: Math.min(config.pageSize, room),
        }))().catch(() => ({ status: "unavailable", reason: "source_failed" }) as const);
      if (page.status === "unavailable") {
        summary.status = "stopped";
        break;
      }
      for (const due of page.packages) {
        if (stopped) break;
        summary.packages += 1;
        after = due.evidencePackageId;
        const outcome = await recorder
          .recordPackage({
            evidencePackageId: due.evidencePackageId,
            institutionId: due.institutionId,
          })
          .catch(() => ({ status: "unavailable", reason: "recorder_failed" }) as const);
        if (outcome.status === "recorded") {
          summary.recorded += 1;
          summary.checkpointsWritten += outcome.written;
        } else if (outcome.status === "current") summary.current += 1;
        else if (outcome.status === "skipped") summary.skipped += 1;
        else summary.unavailable += 1;
      }
      // A short page is the end of the due list.
      if (page.packages.length < Math.min(config.pageSize, room)) break;
    }
    return summary;
  }

  async function pass(): Promise<ReconstructionPassSummary | null> {
    try {
      const summary = await sweep();
      const healthy = summary.status === "completed" && summary.unavailable === 0;
      log(healthy ? "info" : "warn", RECONSTRUCTION_PASS_EVENT, reconstructionPassFields(summary));
      return summary;
    } catch {
      // The sweep answers values; this is only for a programming error.
      log("error", RECONSTRUCTION_FAILED_EVENT, {});
      return null;
    }
  }

  function runPass(): Promise<ReconstructionPassSummary | null> {
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
      void runPass().then(() => schedule(config.intervalMs));
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
