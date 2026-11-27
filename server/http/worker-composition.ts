// The composition root of the worker process (F4-PM2-R01B, D-71, D-102). The
// web process (server/server.ts) never builds a worker; the process of
// server/worker-main.ts builds all three here: the receipt signing worker, the
// reconstruction checkpoint worker and the submission verdict worker. Every
// port is made once over the pool of the worker's own login (WORKER_DATABASE_URL,
// a member of ductus_worker only) and the same signer and storage the web
// process is made of (evidence-deps.ts); no worker reads a key or a path from
// the environment itself.
import {
  createPendingReceiptObjectSource,
  createPendingReceiptQueue,
  createPendingReceiptStore,
  closePools,
  readReceiptKeys,
  workerDatabase,
} from "../database/index.ts";
import {
  createPackageCheckpointRecorder,
  createWorkerEvidenceChainSource,
  createWorkerReconstructionCheckpointStore,
} from "../evidence/index.ts";
import { createEditStepsV1Replayer } from "../external/storage/index.ts";
import { logEvent, type LogEvent } from "../log/index.ts";
import {
  createReceiptSigningWorker,
  createReconstructionWorker,
  createSubmissionVerdictWorker,
  type ReceiptSigningWorker,
  type ReconstructionWorker,
  type SubmissionVerdictWorker,
} from "../worker/index.ts";

import { evidenceIngestDependencies, type EvidenceIngestDependencies } from "./evidence-deps.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The variable that names the evidence domain this worker process serves (never a request field). */
export const WORKER_EVIDENCE_DOMAIN_VARIABLE = "WORKER_EVIDENCE_DOMAIN_ID";
/** The document schema this worker replays (domain DOCUMENT_SCHEMA_VERSION, whose area http may not import). */
const DOCUMENT_SCHEMA_V1 = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** What is wrong with the worker's configuration, without a value; empty for a good one. */
export function workerEnvironmentProblems(env: Env): string[] {
  const problems: string[] = [];
  const url = env.WORKER_DATABASE_URL;
  if (url === undefined || url.trim() === "") problems.push("WORKER_DATABASE_URL is not set");
  const domain = env[WORKER_EVIDENCE_DOMAIN_VARIABLE];
  if (domain === undefined || !UUID.test(domain))
    problems.push(`${WORKER_EVIDENCE_DOMAIN_VARIABLE} is not a uuid`);
  return problems;
}

/** The three workers of the process and the one call that ends them and the pool. */
export type WorkerProcess = {
  readonly signing: ReceiptSigningWorker;
  readonly reconstruction: ReconstructionWorker;
  readonly verdict: SubmissionVerdictWorker;
  /** Starts every worker: a pass now, then one every interval. */
  start(): void;
  /** No pass starts after this; resolves when the running ones ended and the pool is closed. */
  stop(): Promise<void>;
};

export type WorkerProcessOptions = {
  readonly log?: LogEvent;
  /** The signer and storage; absent is `evidenceIngestDependencies(env, repositoryRoot)`. */
  readonly evidence?: Pick<EvidenceIngestDependencies, "signer" | "payloads">;
  /** The pool's end on stop; absent is `closePools`. */
  readonly closeDatabase?: () => Promise<void>;
  /** The worker's database; absent is the registry's `worker` pool. */
  readonly database?: ReturnType<typeof workerDatabase>;
};

/**
 * Builds the three workers over one pool, one signer and one storage. Throws
 * on a configuration `workerEnvironmentProblems` names; nothing is opened
 * before `start` (the pool opens on its first statement).
 */
export function createWorkerProcess(
  env: Env,
  repositoryRoot: string,
  options: WorkerProcessOptions = {},
): WorkerProcess {
  if (workerEnvironmentProblems(env).length > 0) throw new Error("worker configuration invalid");
  const evidenceDomainId = env[WORKER_EVIDENCE_DOMAIN_VARIABLE]!;
  const log = options.log ?? logEvent;
  const db = options.database ?? workerDatabase();
  const { signer, payloads } = options.evidence ?? evidenceIngestDependencies(env, repositoryRoot);
  // One statement on the worker's connection, as the stores of evidence take it.
  const query = (text: string, values: readonly unknown[]) => db.query(text, [...values]);

  const signing = createReceiptSigningWorker({
    queue: createPendingReceiptQueue(db),
    store: createPendingReceiptStore(db),
    objects: createPendingReceiptObjectSource(db),
    locator: payloads,
    presence: payloads,
    signer,
    log,
  });
  const source = createWorkerEvidenceChainSource({ query, evidenceDomainId });
  const reconstruction = createReconstructionWorker({
    source,
    recorder: createPackageCheckpointRecorder({
      source,
      payloads,
      store: createWorkerReconstructionCheckpointStore({ query, evidenceDomainId }),
      // Document schema 1 (none declared counts as 1) is replayed with the v1 edit steps, as
      // a submission is (submission-record.ts); another schema leaves the package alone.
      replayerFor: (version) =>
        version === null || version === DOCUMENT_SCHEMA_V1 ? createEditStepsV1Replayer() : null,
    }),
    log,
  });
  const verdict = createSubmissionVerdictWorker({
    verdict: {
      query,
      evidenceDomainId,
      payloads,
      readKeys: async (domain) => {
        const read = await readReceiptKeys(db, domain);
        return read.status === "ok"
          ? { status: "ok", keys: [...read.keys] }
          : { status: "unavailable", reason: read.reason };
      },
    },
    log,
  });

  const workers = [signing, reconstruction, verdict] as const;
  let stopping: Promise<void> | null = null;
  return {
    signing,
    reconstruction,
    verdict,
    start() {
      for (const worker of workers) worker.start();
    },
    stop() {
      stopping ??= (async () => {
        await Promise.allSettled(workers.map((worker) => worker.stop()));
        await (options.closeDatabase ?? closePools)();
      })();
      return stopping;
    },
  };
}
