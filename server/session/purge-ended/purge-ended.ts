// SRV-1303 (M10.0-S2; D-273 MQ08, MQ14): the first scheduled job of the
// worker. Once a day it removes the session rows that ended (closed, past
// their twelve hours or idle for two hours) more than 30 days before the
// slot's start (D-200 P2), through app.purge_ended_sessions, which only the
// retention role may execute. It is on the schedule's EXECUTE_ALLOWED list, so
// it executes; with any other mode it only counts.
//
// The cut is the slot's start minus the 30 days, never the clock at the time
// the job runs: a second run of the same slot deletes nothing more.
//
// The job registers itself through the schedule's registerScheduledJob (the
// schedule folder of the worker's job queue); the worker's composition root
// passes that function and the retention port (createEndedSessionsPurge
// there). The types below are their shapes, written out here: no production
// file outside the queue folder may name it (registry-boundary.test.ts in
// server/database), so this area does not import it, not even as a type.

/** The retention port: app.purge_ended_sessions under the retention role. */
export type EndedSessionsPort = {
  purge(before: Date): Promise<number>;
  count(before: Date): Promise<number>;
};

/** The shape of the schedule's ScheduledJobDefinition. */
export type PurgeEndedSessionsJob = {
  readonly name: string;
  readonly mode: "execute" | "dry-run";
  readonly everyMs: number;
  readonly candidates: (slot: Date, signal: AbortSignal) => Promise<number>;
  readonly execute: (slot: Date, signal: AbortSignal) => Promise<number>;
};

/** The shape of the schedule's registerScheduledJob. */
export type RegisterJob = (definition: PurgeEndedSessionsJob) => void;

export const PURGE_ENDED_SESSIONS_JOB = "purge_ended_sessions";
/** D-200 P2: a session row is kept this long after its session ended. */
export const SESSION_RETENTION_MS = 30 * 86_400_000;
/** One slot a day, from midnight UTC. */
export const PURGE_ENDED_SESSIONS_EVERY_MS = 86_400_000;

/** The cut for the slot that starts at `slot`: sessions that ended before it go. */
export function purgeCut(slot: Date): Date {
  return new Date(slot.getTime() - SESSION_RETENTION_MS);
}

export function purgeEndedSessionsJob(port: EndedSessionsPort): PurgeEndedSessionsJob {
  return Object.freeze({
    name: PURGE_ENDED_SESSIONS_JOB,
    mode: "execute",
    everyMs: PURGE_ENDED_SESSIONS_EVERY_MS,
    candidates: (slot: Date) => port.count(purgeCut(slot)),
    execute: (slot: Date) => port.purge(purgeCut(slot)),
  });
}

/** Registers the job on the worker's schedule. */
export function registerPurgeEndedSessions(register: RegisterJob, port: EndedSessionsPort): void {
  register(purgeEndedSessionsJob(port));
}
