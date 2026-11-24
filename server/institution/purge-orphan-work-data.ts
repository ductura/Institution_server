// SRV-MENTOR-3B (Ductus#2055; review of #669): the scheduled job that removes
// what a work leaves behind outside its document once the document is gone:
// the student's note to self and reading place, the "student je vidio"
// marks, the messages and the teachers' private notes. Once a day (slot from
// midnight UTC) it calls collaboration.purge_orphan_work_data, which only
// the retention role may execute and which goes through the per-work
// deletions (delete_work_self_notes, delete_work_items_seen,
// delete_work_messages, delete_teacher_notes). A work that still exists is
// never touched, so the job needs no period and no cut.
//
// The definition says "execute", but the schedule runs only the jobs on its
// EXECUTE_ALLOWED list; until this name is put there (an owner decision,
// see the PR) the schedule calls only `candidates`, the dry run that counts
// in a transaction it rolls back.
//
// The worker's composition root passes the schedule's registerScheduledJob
// and the retention port (createOrphanWorkDataPurge of the queue's schedule
// folder). The types below are their shapes, written out here: no production
// file outside the queue folder may name it (registry-boundary.test.ts).

/** The retention port: collaboration.purge_orphan_work_data under the retention role. */
export type OrphanWorkDataPort = {
  purge(): Promise<number>;
  count(): Promise<number>;
};

/** The shape of the schedule's ScheduledJobDefinition. */
export type PurgeOrphanWorkDataJob = {
  readonly name: string;
  readonly mode: "execute" | "dry-run";
  readonly everyMs: number;
  readonly candidates: (slot: Date, signal: AbortSignal) => Promise<number>;
  readonly execute: (slot: Date, signal: AbortSignal) => Promise<number>;
};

export const PURGE_ORPHAN_WORK_DATA_JOB = "purge_orphan_work_data";
/** One slot a day, from midnight UTC. */
export const PURGE_ORPHAN_WORK_DATA_EVERY_MS = 86_400_000;

export function purgeOrphanWorkDataJob(port: OrphanWorkDataPort): PurgeOrphanWorkDataJob {
  return Object.freeze({
    name: PURGE_ORPHAN_WORK_DATA_JOB,
    mode: "execute",
    everyMs: PURGE_ORPHAN_WORK_DATA_EVERY_MS,
    candidates: () => port.count(),
    execute: () => port.purge(),
  });
}

/** Registers the job on the worker's schedule. */
export function registerPurgeOrphanWorkData(
  register: (definition: PurgeOrphanWorkDataJob) => void,
  port: OrphanWorkDataPort,
): void {
  register(purgeOrphanWorkDataJob(port));
}
