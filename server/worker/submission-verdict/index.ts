// Public interface of server/worker/submission-verdict (F4-PM2-R01): the
// worker that reconstructs recorded submissions once more and keeps a verdict.
export {
  createSubmissionVerdictWorker,
  MAX_SUBMISSION_VERDICT_INTERVAL_MS,
  SUBMISSION_VERDICT_FAILED_EVENT,
  SUBMISSION_VERDICT_PASS_EVENT,
  type SubmissionVerdictTimers,
  type SubmissionVerdictWorker,
  type SubmissionVerdictWorkerDeps,
} from "./submission-verdict-worker.ts";
