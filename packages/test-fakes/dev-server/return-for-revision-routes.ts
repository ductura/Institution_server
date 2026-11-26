import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

// SRV-1606: the teacher returns a whole submitted work for revision. As on the
// server: only a submitted work, the teacher of its course (the student owner is
// refused, everybody else does not see it); the work is open again and the
// student submits anew. The fake keeps no history of rounds for it.
export const RETURN_FOR_REVISION_HANDLERS: Handlers = {
  "work.return-for-revision.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    if (body.comment.trim() === "") return { error: "invalid_input" };
    if (work.state !== "submitted") return { error: "conflict" };
    const returnedAt = new Date().toISOString();
    const round =
      state.workReturns.filter((entry) => entry.documentId === work.documentId).length + 1;
    const record = {
      id: randomUUID(),
      documentId: work.documentId,
      round,
      comment: body.comment,
      revisionDueAt:
        body.revisionDueAt === undefined ? null : new Date(body.revisionDueAt).toISOString(),
      returnedAt,
    };
    state.workReturns.push(record);
    work.state = "in_progress";
    work.submittedAt = null;
    work.submissionReceipt = null;
    return {
      status: 200,
      body: {
        id: record.id,
        state: "returned_for_revision",
        round,
        comment: record.comment,
        revisionDueAt: record.revisionDueAt,
        returnedAt,
      },
    };
  },
  // F4-NAS-R16-SRV: the due date of the open return. The student owner and a teacher
  // of the work read it, everybody else does not see the work. Open means the work
  // was returned and not submitted again.
  "work.revision-due.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const last = state.workReturns.filter((entry) => entry.documentId === work.documentId).at(-1);
    if (last === undefined || last.closed === true || work.state === "submitted") {
      return { status: 200, body: { returned: null } };
    }
    return {
      status: 200,
      body: {
        returned: {
          round: last.round,
          revisionDueAt: last.revisionDueAt,
          returnedAt: last.returnedAt,
        },
      },
    };
  },
};
