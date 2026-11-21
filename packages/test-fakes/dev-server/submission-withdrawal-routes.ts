// SRV-1903 (P-D3): withdrawal of a submission in the dev fake server. The
// student withdraws the own submitted work before the deadline in force; the
// work is open again and can be submitted anew; every submission and
// withdrawal stays in the history. The teacher of the assignment switches
// withdrawal off or on. Receipts carry a stand-in signature, as the fake's
// submission receipt does; the fake makes no key.
import { createHash, randomUUID } from "node:crypto";

import { canonicalizeJcs } from "../../../server/domain/index.ts";
import type { Operations } from "../../contracts/index.ts";
import { FAKE_DOMAIN } from "./receipt-signer.ts";
import type { Handlers } from "./server.ts";
import { teachesCourse, visibleStudents, type Account, type State } from "./state.ts";
import { studentAssignments } from "./student-routes.ts";

type Event = Operations["student.submission-history.get"]["success"]["body"]["events"][number];

const UNSIGNED = {
  algorithm: "Ed25519",
  keyId: "lazni-kljuc-nepotpisano",
  keyVersion: "0",
  signatureEncoding: "raw",
  signatureBase64Url: "A".repeat(86),
} as const;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const microsecond = (iso: string): string => `${new Date(iso).toISOString().slice(0, 23)}000Z`;
const milli = (iso: string): string => new Date(iso).toISOString();

function taught(state: State, account: Account | null, assignmentId: string) {
  const assignment = state.assignments.find((a) => a.id === assignmentId.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? { assignment, course }
    : null;
}

/** The deadline in force for a student: the version's, or the latest extension of theirs or of all. */
function dueAtOf(
  state: State,
  assignmentId: string,
  studentId: string,
  versionDueAt: string,
): string {
  return state.deadlineExtensions.reduce((due, extension) => {
    if (extension.assignmentId !== assignmentId) return due;
    if (extension.studentId !== null && extension.studentId !== studentId) return due;
    return extension.dueAt > due ? extension.dueAt : due;
  }, milli(versionDueAt));
}

/** Withdrawn rounds, then the live submission, oldest first. */
function historyOf(state: State, assignmentId: string, studentId: string): Event[] {
  const events: Event[] = [];
  const rounds = state.submissionWithdrawals.filter(
    (round) => round.assignmentId === assignmentId && round.studentId === studentId,
  );
  for (const [index, round] of rounds.entries()) {
    const submission = round.submission;
    events.push({
      kind: "submission",
      id: submission.payload.submissionId,
      attempt: index + 1,
      submissionId: submission.payload.submissionId,
      revision: submission.payload.revision,
      at: milli(submission.payload.requestedAt),
      afterDeadline: submission.payload.afterDeadline,
      receipt: submission,
    });
    events.push({
      kind: "withdrawal",
      id: round.withdrawal.payload.withdrawalId,
      attempt: index + 1,
      submissionId: submission.payload.submissionId,
      revision: submission.payload.revision,
      at: milli(round.withdrawal.payload.withdrawnAt),
      receipt: round.withdrawal,
    });
  }
  const work = state.works.find(
    (w) => w.assignmentId === assignmentId && w.studentId === studentId,
  );
  const live = work?.submissionReceipt;
  if (work?.state === "submitted" && live !== null && live !== undefined) {
    events.push({
      kind: "submission",
      id: live.payload.submissionId,
      attempt: rounds.length + 1,
      submissionId: live.payload.submissionId,
      revision: live.payload.revision,
      at: milli(live.payload.requestedAt),
      afterDeadline: live.payload.afterDeadline,
      receipt: live,
    });
  }
  return events;
}

const settingOf = (state: State, assignmentId: string) =>
  state.withdrawalSettings.get(assignmentId) ?? { allowed: true, changedAt: null };

export const SUBMISSION_WITHDRAWAL_HANDLERS: Handlers = {
  "student.submission-withdrawal.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = studentAssignments(state, account).find(
      (a) => a.id === params.assignmentId.toLowerCase(),
    );
    if (assignment === undefined) return { error: "not_found" };
    const work = state.works.find(
      (w) => w.assignmentId === assignment.id && w.studentId === account.id,
    );
    const submission = work?.submissionReceipt;
    if (
      work === undefined ||
      work.state !== "submitted" ||
      submission === null ||
      submission === undefined
    )
      return { error: "not_started" };
    if (!settingOf(state, assignment.id).allowed) return { error: "not_allowed" };
    const dueAt = dueAtOf(state, assignment.id, account.id, assignment.content.dueAt);
    const withdrawnAt = now.toISOString();
    if (withdrawnAt > dueAt) return { error: "refused" };
    const payload = {
      receiptSchema: "ductus-submission-withdrawal-receipt-v1",
      withdrawalId: randomUUID(),
      submissionId: submission.payload.submissionId,
      submissionReceiptSha256: submission.payloadDigestSha256,
      evidenceDomainId: FAKE_DOMAIN,
      principalId: account.id,
      assignmentId: assignment.id,
      withdrawnAt: microsecond(withdrawnAt),
      dueAt: microsecond(dueAt),
      signedAt: microsecond(withdrawnAt),
    } as const;
    const receipt = {
      payload,
      payloadDigestSha256: sha256(canonicalizeJcs(payload)),
      signature: UNSIGNED,
    };
    state.submissionWithdrawals.push({
      assignmentId: assignment.id,
      studentId: account.id,
      submission,
      withdrawal: receipt,
    });
    // The work is open again and can be submitted anew.
    work.state = "in_progress";
    work.submittedAt = null;
    work.submissionReceipt = null;
    work.submittedDocument = null;
    return { status: 200, body: { status: "withdrawn", receipt } };
  },
  "student.submission-history.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = studentAssignments(state, account).find(
      (a) => a.id === params.assignmentId.toLowerCase(),
    );
    if (assignment === undefined) return { error: "not_found" };
    return {
      status: 200,
      body: {
        withdrawalAllowed: settingOf(state, assignment.id).allowed,
        dueAt: dueAtOf(state, assignment.id, account.id, assignment.content.dueAt),
        events: historyOf(state, assignment.id, account.id),
      },
    };
  },
  "teacher.submission-history.get": ({ state, account, params }) => {
    const found = taught(state, account, params.assignmentId);
    const studentId = params.studentId.toLowerCase();
    if (
      found === null ||
      account === null ||
      !visibleStudents(found.course, account).includes(studentId)
    )
      return { error: "not_found" };
    return { status: 200, body: { events: historyOf(state, found.assignment.id, studentId) } };
  },
  "teacher.submission-withdrawal.get": ({ state, account, params }) => {
    const found = taught(state, account, params.assignmentId);
    if (found === null) return { error: "not_found" };
    return { status: 200, body: settingOf(state, found.assignment.id) };
  },
  "teacher.submission-withdrawal.post": ({ state, account, params, body, now }) => {
    const found = taught(state, account, params.assignmentId);
    if (found === null) return { error: "not_found" };
    const current = settingOf(state, found.assignment.id);
    if (current.allowed === body.allowed) return { status: 200, body: current };
    const next = { allowed: body.allowed, changedAt: now.toISOString() };
    state.withdrawalSettings.set(found.assignment.id, next);
    return { status: 200, body: next };
  },
};
