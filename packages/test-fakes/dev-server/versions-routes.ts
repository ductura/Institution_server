// SRV-9A keeps its existing list. SRV-1511 adds the detail and diff. INT-21 C
// records a restore the way app.record_revision_restore does: against the
// lowest later revision with the same text that has no record yet.
import { blocksOf, diffBlocks, MAX_COMPARE_BLOCKS } from "../../../server/evidence/index.ts";

import type { Handlers } from "./server.ts";
import type { Account, State, Work } from "./state.ts";
import { readerOf } from "./state.ts";

/** An instant on its whole minute (D-24). */
const minuteOf = (iso: string): string => {
  const time = Date.parse(iso);
  return new Date(time - (time % 60_000)).toISOString();
};

function mayRead(state: State, work: Work, account: Account): boolean {
  return (
    account.id === work.studentId ||
    state.mentorships.some(
      (m) =>
        m.assignmentId === work.assignmentId &&
        m.studentId === work.studentId &&
        m.mentorId === account.id,
    )
  );
}

/** The restores recorded per work: revision -> the revision whose text it restored. */
const RESTORES = new WeakMap<object, Map<string, Map<number, number>>>();
function restoresOf(state: State, documentId: string): Map<number, number> {
  const works = RESTORES.get(state) ?? new Map<string, Map<number, number>>();
  RESTORES.set(state, works);
  const restores = works.get(documentId) ?? new Map<number, number>();
  works.set(documentId, restores);
  return restores;
}

function isSent(state: State, work: Work, revision: number): boolean {
  return (
    (work.submittedAt !== null && revision === work.revision) ||
    state.revisionRequests.some(
      (item) =>
        item.documentId === work.documentId &&
        item.response?.kind === "done" &&
        item.response.revision === revision,
    )
  );
}

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
      const restored = restoresOf(state, work.documentId).get(work.revision);
      if (restored !== undefined)
        Object.assign(versions.at(-1)!, { restoredFromRevision: restored });
    }
    return { status: 200, body: { versions, nextBeforeRevision: null } };
  },
  "work.version.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const revision = Number(params.revision);
    const from = query.compareFrom === undefined ? null : Number(query.compareFrom);
    if (
      !Number.isSafeInteger(revision) ||
      (from !== null && (!Number.isSafeInteger(from) || from >= revision))
    ) {
      return { error: "invalid_input" };
    }
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || !mayRead(state, work, account)) return { error: "not_found" };
    if ((from !== null || account.id !== work.studentId) && !isSent(state, work, revision)) {
      return { error: "not_found" };
    }
    const snapshot = work.versionSnapshots.get(revision);
    if (snapshot === undefined) return { error: "not_found" };
    const document = Buffer.from(snapshot, "base64").toString("utf8");
    if (from === null) return { status: 200, body: { revision, document } };
    const earlier = work.versionSnapshots.get(from);
    if (earlier === undefined || !isSent(state, work, from)) return { error: "not_found" };
    const before = blocksOf(Buffer.from(earlier, "base64").toString("utf8"));
    const after = blocksOf(document);
    if (before === null || after === null) return { error: "unavailable" };
    if (before.length > MAX_COMPARE_BLOCKS || after.length > MAX_COMPARE_BLOCKS) {
      return { error: "invalid_input" };
    }
    return { status: 200, body: { from, to: revision, blocks: diffBlocks(before, after) } };
  },
  "work.restore.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "owner") {
      return { error: "not_found" };
    }
    const from = body.fromRevision;
    const text = work.versionSnapshots.get(from);
    const restores = restoresOf(state, work.documentId);
    const later = [...work.versionSnapshots.entries()]
      .filter(([revision, snapshot]) => revision > from && snapshot === text)
      .map(([revision]) => revision)
      .sort((a, b) => a - b);
    const open = text === undefined ? undefined : later.find((revision) => !restores.has(revision));
    if (open !== undefined) {
      restores.set(open, from);
      return { status: 200, body: { outcome: "recorded", revision: open } };
    }
    const already = [...restores.entries()]
      .filter(([, restored]) => text !== undefined && restored === from)
      .map(([revision]) => revision);
    return already.length === 0
      ? { status: 200, body: { outcome: "no_matching_revision" } }
      : { status: 200, body: { outcome: "already_recorded", revision: Math.max(...already) } };
  },
  // SRV-2004: the owner and the teacher get the same difference; only the teacher is held to sent revisions.
  "work.compare.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const from = Number(query.from);
    const to = Number(query.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || from >= to) {
      return { error: "invalid_input" };
    }
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || !mayRead(state, work, account)) return { error: "not_found" };
    if (account.id !== work.studentId && !(isSent(state, work, from) && isSent(state, work, to))) {
      return { error: "not_found" };
    }
    const earlier = work.versionSnapshots.get(from);
    const later = work.versionSnapshots.get(to);
    if (earlier === undefined || later === undefined) return { error: "not_found" };
    const before = blocksOf(Buffer.from(earlier, "base64").toString("utf8"));
    const after = blocksOf(Buffer.from(later, "base64").toString("utf8"));
    if (before === null || after === null) return { error: "unavailable" };
    if (before.length > MAX_COMPARE_BLOCKS || after.length > MAX_COMPARE_BLOCKS) {
      return { error: "unavailable" };
    }
    return { status: 200, body: { from, to, blocks: diffBlocks(before, after) } };
  },
};
