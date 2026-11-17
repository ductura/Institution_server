// The worker's side of the job queue (DAN-820, VS-1b part 1). Its own folder,
// not re-exported by server/database/index.ts: the web process never opens a
// queue, so its bundle never loads pg-boss. The worker process opens it over a
// login of its own and passes its fence.
export {
  JobQueueError,
  openJobQueue,
  type AttemptFence,
  type JobHandler,
  type JobOutcome,
  type JobQueue,
  type JobQueueErrorCode,
  type JobQueueSettings,
} from "./job-queue.ts";
// The fence the worker process passes (DAN-822-5).
export { MAX_FENCE_MS, startAttemptFence } from "./attempt-fence.ts";
