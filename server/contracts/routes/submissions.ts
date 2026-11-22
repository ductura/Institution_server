import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SignedSubmissionReceipt } from "./evidence.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-1903 (P-D3, owner decision of 21. 11. 2026): a student withdraws a
// confirmed submission and submits again (submission.submit.post) while the
// deadline in force lasts. Every submission and withdrawal is recorded with
// its own signed receipt and is never changed; the teacher sees the last
// valid submission (teacher.submissions.get, student.submission.get) and the
// history here. Withdrawal is allowed by default; the teacher of the
// assignment switches it off or on. Database: app.withdraw_submission,
// app.attach_withdrawal_receipt, app.my_submission_history,
// app.teacher_submission_history, institution.set_submission_withdrawal
// (20261201100100).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** The database clock with exactly six fraction digits, in UTC, as in the receipts. */
const Microsecond = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$",
});
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const WITHDRAWAL_RECEIPT_SCHEMA = "ductus-submission-withdrawal-receipt-v1";

/**
 * The signed receipt of a withdrawal, as the submission receipt v2: the
 * signature is Ed25519 over the schema name, a newline and the SHA-256 of the
 * payload's JCS text, whose digest payloadDigestSha256 is. dueAt is the
 * deadline in force at the click; submissionReceiptSha256 is the digest of the
 * withdrawn submission's receipt.
 */
export const SignedWithdrawalReceipt = closed({
  payload: closed({
    receiptSchema: Type.Literal(WITHDRAWAL_RECEIPT_SCHEMA),
    withdrawalId: Uuid,
    submissionId: Uuid,
    submissionReceiptSha256: Sha256,
    evidenceDomainId: Uuid,
    principalId: Uuid,
    assignmentId: Uuid,
    withdrawnAt: Microsecond,
    dueAt: Microsecond,
    signedAt: Microsecond,
  }),
  payloadDigestSha256: Sha256,
  signature: SignedSubmissionReceipt.properties.signature,
});

const Event = Type.Union([
  closed({
    kind: Type.Literal("submission"),
    id: Uuid,
    attempt: Positive,
    submissionId: Uuid,
    revision: Positive,
    at: Instant,
    afterDeadline: Type.Boolean(),
    /** Null while the receipt is not bound yet. */
    receipt: Type.Union([SignedSubmissionReceipt, Type.Null()]),
  }),
  closed({
    kind: Type.Literal("withdrawal"),
    id: Uuid,
    attempt: Positive,
    submissionId: Uuid,
    revision: Positive,
    at: Instant,
    receipt: Type.Union([SignedWithdrawalReceipt, Type.Null()]),
  }),
]);
const History = Type.Array(Event, { maxItems: 2000 });

const AssignmentParams = closed({ assignmentId: Type.String({ minLength: 1 }) });

export const studentSubmissionWithdrawalPost = defineRoute({
  id: "student.submission-withdrawal.post",
  method: "POST",
  path: "/api/v1/student/assignments/{assignmentId}/submission/withdrawal",
  inventory: "app/api/student/assignments/[assignmentId]/submission/withdrawal/route.ts",
  access: "student_enrolled",
  summary:
    "The student withdraws the own confirmed submission of the assignment and gets the signed receipt of the withdrawal; nothing is deleted, and the work can be submitted again (submission.submit.post). No body. A retry returns the same withdrawal. 409 not_allowed: the teacher switched withdrawal off; 409 refused: the deadline in force has passed (an extension counts); 409 not_started: no recorded submission to withdraw; 409 conflict: the submission's receipt is not bound yet or a newer submission is in progress. An inaccessible, unknown or malformed assignment id returns 404. 503 when the receipt cannot be signed; a retry signs the same frozen receipt.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "withdrawn, with the signed receipt",
      body: closed({ status: Type.Literal("withdrawn"), receipt: SignedWithdrawalReceipt }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(409, "not_allowed"),
    error(409, "refused"),
    error(409, "not_started"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

const WithdrawalReceiptSummary = closed({
  withdrawalId: Uuid,
  assignmentId: Uuid,
  revision: Positive,
  withdrawnAt: Microsecond,
  /** The Ed25519 signature of the signed receipt, base64url. */
  signature: Type.String({ minLength: 1, maxLength: 512 }),
});

export const studentSubmissionWithdrawalGet = defineRoute({
  id: "student.submission-withdrawal.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/submission/withdrawal",
  inventory: "app/api/student/assignments/[assignmentId]/submission/withdrawal/route.ts",
  access: "student_enrolled",
  summary:
    "Whether the caller may withdraw the own submission of the assignment now, and the signed withdrawals so far (WEB-1903). withdrawable is the server's decision: the teacher has not switched withdrawal off, the deadline in force has not passed and the last event is a confirmed submission whose receipt is bound; the client never compares a time with a deadline. receipts lists the bound withdrawal receipts, oldest first (the full receipts are in student.submission-history.get). An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the state, with no receipts before a first withdrawal",
      body: closed({
        withdrawable: Type.Boolean(),
        receipts: Type.Array(WithdrawalReceiptSummary, { maxItems: 1000 }),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const studentSubmissionHistoryGet = defineRoute({
  id: "student.submission-history.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/submission/history",
  inventory: "app/api/student/assignments/[assignmentId]/submission/history/route.ts",
  access: "student_enrolled",
  summary:
    "The caller's submissions and withdrawals of the assignment, oldest first, each with its signed receipt (null while not bound), and whether withdrawal is allowed with the deadline in force. A withdrawal is possible when withdrawalAllowed is true, the deadline has not passed and the last event is a confirmed submission. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the history, possibly empty",
      body: closed({ withdrawalAllowed: Type.Boolean(), dueAt: Instant, events: History }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherSubmissionHistoryGet = defineRoute({
  id: "teacher.submission-history.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission-history",
  inventory:
    "app/api/teacher/assignments/[assignmentId]/students/[studentId]/submission-history/route.ts",
  access: "course_teacher",
  summary:
    "One student's submissions and withdrawals of the assignment, oldest first, each with its signed receipt (null while not bound), for a reader of the work (as teacher.submission-detail.get). The last valid submission is the last submission event not followed by a withdrawal. An inaccessible, unknown or malformed id returns 404.",
  request: {
    params: closed({
      assignmentId: Type.String({ minLength: 1 }),
      studentId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the history, possibly empty",
      body: closed({ events: History }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

const Setting = closed({
  allowed: Type.Boolean(),
  /** Null: never set, allowed by default. */
  changedAt: Type.Union([Instant, Type.Null()]),
});

export const teacherSubmissionWithdrawalGet = defineRoute({
  id: "teacher.submission-withdrawal.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/submission-withdrawal",
  inventory: "app/api/teacher/assignments/[assignmentId]/submission-withdrawal/route.ts",
  access: "course_teacher",
  summary:
    "Whether students may withdraw their submissions of the assignment (allowed by default), for its teacher. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: AssignmentParams },
  responses: [
    { status: 200, description: "the switch", body: Setting, headers: ["cache-control"] },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherSubmissionWithdrawalPost = defineRoute({
  id: "teacher.submission-withdrawal.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/submission-withdrawal",
  inventory: "app/api/teacher/assignments/[assignmentId]/submission-withdrawal/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment switches withdrawal off or on. Setting the value in force changes nothing and returns it. A withdrawal already recorded stays. An inaccessible, unknown or malformed assignment id returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ allowed: Type.Boolean() }),
  },
  responses: [
    { status: 200, description: "the switch in force", body: Setting, headers: ["cache-control"] },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const submissionsRoutes = [
  studentSubmissionWithdrawalPost,
  studentSubmissionWithdrawalGet,
  studentSubmissionHistoryGet,
  teacherSubmissionHistoryGet,
  teacherSubmissionWithdrawalGet,
  teacherSubmissionWithdrawalPost,
] as const;
