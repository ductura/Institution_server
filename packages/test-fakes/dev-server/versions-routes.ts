// The versions of a work on the dev fake server (work.versions.get, SRV-9A):
// the same list for the student and the teachers of its course (readerOf).
// The fake keeps no history of checkpoints, so a work shows the checkpoint of
// its current revision (revision 0, the empty document, is never a version)
// and its submission; one page, never a next one. The real list, its access
// log row and the submission cut are app.read_work_versions.
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

/** An instant on its whole minute (D-24). */
const minuteOf = (iso: string): string => {
  const time = Date.parse(iso);
  return new Date(time - (time % 60_000)).toISOString();
};

export const VERSIONS_HANDLERS: Handlers = {
  "work.versions.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    const before = query.beforeRevision === undefined ? null : Number(query.beforeRevision);
    if (before !== null && before < 2) return { error: "invalid_input" };
    const below = (revision: number) => before === null || revision < before;
    const assignment = state.assignments.find((a) => a.id === work.assignmentId);
    const versions = [];
    if (work.submittedAt !== null && assignment !== undefined && below(work.revision)) {
      versions.push({
        kind: "submission" as const,
        revision: work.revision,
        savedMinute: minuteOf(work.submittedAt),
        afterDeadline: work.submittedAt > assignment.content.dueAt,
      });
    }
    if (work.revision > 0 && work.lastChangeAt !== null && below(work.revision)) {
      versions.push({
        kind: "checkpoint" as const,
        revision: work.revision,
        savedMinute: minuteOf(work.lastChangeAt),
      });
    }
    return { status: 200, body: { versions, nextBeforeRevision: null } };
  },
};
