// SRV-22 (Ductus#2028 c.7009405737): the logic of student.submission.get, the
// caller's own submission on one assignment, over the port
// server/database/my-submission-state.ts (SRV-20 app.my_submission_state). The
// HTTP side is server/http/student-submission.ts, since this area imports
// neither http nor contracts (docs/server-map.md §2). potvrdeno hands out the
// receipt the database bound, built exactly as submission.submit.post builds
// it (server/evidence/submission-receipt.ts, storedReceipt): the payload
// parsed from the stored text, which must be its own JCS, hash to the stored
// digest and name this assignment and revision; the signature as stored. So
// the student reads the same bytes the submission answered (PRODUCT §5 rule
// 5). A stored row this read cannot vouch for is 503, never a partial answer.
// Another's, an unknown and a malformed assignment read 404 alike (C-23).
import type { MySubmissionStateReader } from "../database/index.ts";
import {
  digestSubmissionReceiptPayloadV2,
  isSignedSubmissionReceiptV2,
  isSubmissionReceiptPayloadV2,
  type SignedSubmissionReceiptV2,
} from "../domain/index.ts";

export type StudentSubmissionState =
  | { state: "none" }
  | { state: "ceka"; revision: number; requestedAt: string }
  | { state: "potvrdeno"; receipt: SignedSubmissionReceiptV2 };

export type StudentSubmissionAnswer =
  { status: 200; body: StudentSubmissionState } | { status: 401 | 404 | 503 };

// The codes of MY_SUBMISSION_STATE_* (server/database/my-submission-state.ts),
// compared by value: this area imports database only as types.
const UNAUTHENTICATED = "MY_SUBMISSION_STATE_UNAUTHENTICATED";
const NOT_FOUND = "MY_SUBMISSION_STATE_NOT_FOUND";

/** The stored receipt as on the wire, or null when any part does not check. */
export async function boundReceipt(
  text: string,
  digest: string,
  signature: unknown,
  expected: { assignmentId: string; revision: number },
): Promise<SignedSubmissionReceiptV2 | null> {
  try {
    const payload: unknown = JSON.parse(text);
    if (!isSubmissionReceiptPayloadV2(payload)) return null;
    const computed = await digestSubmissionReceiptPayloadV2(payload);
    if (computed.canonical !== text || computed.sha256 !== digest) return null;
    if (payload.assignmentId !== expected.assignmentId) return null;
    if (payload.revision !== expected.revision) return null;
    const receipt = { payload, payloadDigestSha256: computed.sha256, signature };
    return isSignedSubmissionReceiptV2(receipt) ? receipt : null;
  } catch {
    return null;
  }
}

/** The submission state of `assignmentId` for the session behind `token`. */
export async function readStudentSubmission(
  reader: MySubmissionStateReader,
  token: string,
  assignmentId: string,
): Promise<StudentSubmissionAnswer> {
  const read = await reader.state(token, assignmentId);
  if (!read.ok) {
    if (read.error.code === UNAUTHENTICATED) return { status: 401 };
    if (read.error.code === NOT_FOUND) return { status: 404 };
    return { status: 503 };
  }
  const stored = read.value;
  if (stored.state === "none") return { status: 200, body: { state: "none" } };
  if (stored.state === "ceka") {
    const { revision, requestedAt } = stored;
    return { status: 200, body: { state: "ceka", revision, requestedAt } };
  }
  const receipt = await boundReceipt(
    stored.receiptPayload,
    stored.payloadDigestSha256,
    stored.signature,
    { assignmentId, revision: stored.revision },
  );
  return receipt === null
    ? { status: 503 }
    : { status: 200, body: { state: "potvrdeno", receipt } };
}
