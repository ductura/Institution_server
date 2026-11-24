// SRV-22 (Ductus#2028 c.7009405737): the caller's own submission state and
// word range on one assignment, for student.submission.get and
// student.assignment-requirements.get, over app.my_submission_state and
// app.my_assignment_requirements (SRV-20, 20261119160000). One withActor
// transaction, one STABLE statement each, nothing written. Who asks comes only
// from the session token; the database answers not_found for an assignment of
// another course, an unknown one and a removed student alike, and an id that
// is not a uuid is never sent, so all three read NOT_FOUND. The row is checked
// against the state it names (none carries nothing, ceka a revision and the
// request instant, potvrdeno also the stored receipt); a row the port cannot
// vouch for is ROW_MALFORMED, never a partial answer. The receipt text is
// handed on as stored; server/institution/student-submission-route.ts checks
// it against its digest. Rows are read only through their own keys.

import type { AppError, Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** No session behind the token: a malformed token, or ZD401. */
export const MY_SUBMISSION_STATE_UNAUTHENTICATED = error(
  "MY_SUBMISSION_STATE_UNAUTHENTICATED",
  "mySubmissionState.unauthenticated",
);
/** Another's, an unknown or a malformed assignment: an id that is not a uuid, or not_found. */
export const MY_SUBMISSION_STATE_NOT_FOUND = error(
  "MY_SUBMISSION_STATE_NOT_FOUND",
  "mySubmissionState.not_found",
);
/** A result that is not exactly one row consistent with its state. */
export const MY_SUBMISSION_STATE_ROW_MALFORMED = error(
  "MY_SUBMISSION_STATE_ROW_MALFORMED",
  "mySubmissionState.row_malformed",
);
/** Any other error of the database or of withActor. */
export const MY_SUBMISSION_STATE_DATABASE_ERROR = error(
  "MY_SUBMISSION_STATE_DATABASE_ERROR",
  "mySubmissionState.database_error",
);
export const MY_SUBMISSION_STATE_ERRORS: readonly AppError[] = [
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
  MY_SUBMISSION_STATE_NOT_FOUND,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_DATABASE_ERROR,
];

export type StoredSubmissionState =
  | { state: "none" }
  | { state: "ceka"; revision: number; requestedAt: string }
  | {
      state: "potvrdeno";
      revision: number;
      receiptPayload: string;
      payloadDigestSha256: string;
      signature: unknown;
    };

export type StoredWordRange = { wordMin: number | null; wordMax: number | null };

export type MySubmissionStateReader = {
  /** The caller's submission state on `assignmentId`. */
  state(token: string | undefined, assignmentId: string): Promise<Result<StoredSubmissionState>>;
  /** The word range of the current version of `assignmentId`, for a student of its course. */
  requirements(token: string | undefined, assignmentId: string): Promise<Result<StoredWordRange>>;
  /**
   * SRV-30: the same state of one student, for a reader of that student's work
   * (app.teacher_submission_state). Any refusal of the database (ZD403) is NOT_FOUND.
   */
  teacherState(
    token: string | undefined,
    assignmentId: string,
    studentId: string,
  ): Promise<Result<StoredSubmissionState>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[1-9][0-9]{0,15}$/;
const MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
// The request instant as the receipt payload writes it (20261023190000):
// the database clock in UTC with six fraction digits, never a JS Date.
const STATE_SQL = `SELECT state, revision::text AS revision,
    to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
    receipt_payload, payload_digest_sha256, signature
  FROM app.my_submission_state($1::uuid)`;
const TEACHER_STATE_SQL = `SELECT state, revision::text AS revision,
    to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
    receipt_payload, payload_digest_sha256, signature
  FROM app.teacher_submission_state($1::uuid, $2::uuid)`;
const REQUIREMENTS_SQL = `SELECT outcome, word_min, word_max
  FROM app.my_assignment_requirements($1::uuid)`;

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });
export const NOT_FOUND = Symbol("not_found");

/** An own column of the row, or undefined; never one from the prototype. */
const own = (row: object, key: string): unknown =>
  Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The one row of a result, or null. */
function onlyRow(rows: unknown): object | null {
  if (!Array.isArray(rows) || rows.length !== 1 || !Object.hasOwn(rows, 0)) return null;
  const row: unknown = rows[0];
  return typeof row === "object" && row !== null ? row : null;
}

const revisionOf = (value: unknown): number | null =>
  typeof value === "string" && REVISION.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;

function stateOf(rows: unknown): StoredSubmissionState | typeof NOT_FOUND | null {
  const row = onlyRow(rows);
  return row === null ? null : storedStateOf(row);
}

/**
 * One row of app.submission_state_of checked against the state it names, read only
 * through its own keys; not_found is NOT_FOUND, anything else it cannot vouch for null.
 * Shared with the list of my-assignment-submissions.ts, so both read a row alike.
 */
export function storedStateOf(row: object): StoredSubmissionState | typeof NOT_FOUND | null {
  const [state, revisionText, requestedAt, payload, digest, signature] = [
    "state",
    "revision",
    "requested_at",
    "receipt_payload",
    "payload_digest_sha256",
    "signature",
  ].map((key) => own(row, key));
  const noReceipt = payload === null && digest === null && signature === null;
  if (state === "none" || state === "not_found") {
    if (revisionText !== null || requestedAt !== null || !noReceipt) return null;
    return state === "none" ? { state } : NOT_FOUND;
  }
  const revision = revisionOf(revisionText);
  if (revision === null || typeof requestedAt !== "string" || !MICROSECOND.test(requestedAt)) {
    return null;
  }
  if (state === "ceka") return noReceipt ? { state, revision, requestedAt } : null;
  if (state !== "potvrdeno") return null;
  if (typeof payload !== "string" || typeof digest !== "string" || !SHA256.test(digest)) {
    return null;
  }
  if (typeof signature !== "object" || signature === null) return null;
  return { state, revision, receiptPayload: payload, payloadDigestSha256: digest, signature };
}

const boundOf = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000
      ? (value as number)
      : undefined;

function rangeOf(rows: unknown): StoredWordRange | typeof NOT_FOUND | null {
  const row = onlyRow(rows);
  if (row === null) return null;
  const [outcome, min, max] = ["outcome", "word_min", "word_max"].map((key) => own(row, key));
  if (outcome === "not_found") return min === null && max === null ? NOT_FOUND : null;
  if (outcome !== "found") return null;
  const [wordMin, wordMax] = [boundOf(min), boundOf(max)];
  if (wordMin === undefined || wordMax === undefined) return null;
  if (wordMin !== null && wordMax !== null && wordMin > wordMax) return null;
  return { wordMin, wordMax };
}

/** One statement for the session behind `token`, its rows checked by `parse`. */
async function readOne<T>(
  withActor: WithActor,
  token: string | undefined,
  ids: readonly string[],
  sql: string,
  parse: (rows: unknown) => T | typeof NOT_FOUND | null,
  refusalIsNotFound = false,
): Promise<Result<T>> {
  if (token === undefined || !TOKEN.test(token)) return fail(MY_SUBMISSION_STATE_UNAUTHENTICATED);
  if (!ids.every((id) => UUID.test(id))) return fail(MY_SUBMISSION_STATE_NOT_FOUND);
  let rows: unknown;
  try {
    rows = await withActor(token, async (tx) => (await tx.query(sql, [...ids])).rows);
  } catch (thrown) {
    const code = codeOf(thrown);
    // ZD403 is the teacher read's one answer for every refusal (SRV-20): not found (C-23).
    // The student reads answer not_found as a row, so a ZD403 there stays an error.
    if (refusalIsNotFound && code === "ZD403") return fail(MY_SUBMISSION_STATE_NOT_FOUND);
    return fail(
      code === "ZD401" ? MY_SUBMISSION_STATE_UNAUTHENTICATED : MY_SUBMISSION_STATE_DATABASE_ERROR,
    );
  }
  let value: T | typeof NOT_FOUND | null;
  try {
    value = parse(rows);
  } catch {
    value = null;
  }
  if (value === NOT_FOUND) return fail(MY_SUBMISSION_STATE_NOT_FOUND);
  return value === null ? fail(MY_SUBMISSION_STATE_ROW_MALFORMED) : { ok: true, value };
}

export function createMySubmissionStateReader(withActor: WithActor): MySubmissionStateReader {
  return {
    state: (token, assignmentId) => readOne(withActor, token, [assignmentId], STATE_SQL, stateOf),
    requirements: (token, assignmentId) =>
      readOne(withActor, token, [assignmentId], REQUIREMENTS_SQL, rangeOf),
    teacherState: (token, assignmentId, studentId) =>
      readOne(withActor, token, [assignmentId, studentId], TEACHER_STATE_SQL, stateOf, true),
  };
}
