/**
 * The ISVU source port (SRV-V22-ISVU-PORT; plan val 22, Ductus
 * docs/nalazi/val22-razlika.md §3 t. 1 and t. 4; contract docs/contracts/isvu-v1.md).
 *
 * There is no real ISVU interface in this repo and none is invented: the
 * port has one adapter, the synthetic one (invented courses and students, no
 * network, no secret). The port is what a route will call; the real adapter
 * waits for an agreement with Srce and the institution, a DPIA and a legal
 * basis (OP-V22-2). This file imports nothing, so it cannot reach out.
 *
 * Grades go out only with a teacher's confirmation: `submitGrades` takes a
 * `GradeConfirmation`, and the only function that makes one is
 * `confirmGradeBatch`, which a route calls after the teacher confirmed the
 * preview. Without a confirmation, or with one for another batch, nothing
 * is passed on. The port never computes, proposes or stores a grade (PG-10).
 */
import { createHash } from "node:crypto";

/** One course of the source, as the administrator sees it. */
export type IsvuCourse = {
  readonly sourceCourseKey: string;
  readonly name: string;
  readonly academicYear: string;
  readonly enrolledCount: number;
};

/** A row in the shape the roster import reader already takes. */
export type IsvuRosterRow = {
  readonly identifier: string;
  readonly givenName: string;
  readonly familyName: string;
};

/** One grade the teacher typed in: a whole number 1 to 5. */
export type IsvuGradeRow = {
  readonly identifier: string;
  readonly grade: number;
};

export type IsvuListCoursesInput = {
  readonly institutionKey: string;
  readonly academicYear: string;
};

export const GRADE_MIN = 1;
export const GRADE_MAX = 5;
export const GRADE_BATCH_MAX_ROWS = 1000;

export type IsvuSubmitRefusal =
  "no_confirmation" | "batch_mismatch" | "invalid_batch" | "unknown_course" | "not_enrolled";

export type IsvuSubmitOutcome =
  | { readonly ok: true; readonly sent: number; readonly mode: "mock" }
  | { readonly ok: false; readonly reason: IsvuSubmitRefusal };

export type IsvuPort = {
  readonly mode: "mock";
  listCourses(input: IsvuListCoursesInput): Promise<readonly IsvuCourse[]>;
  /** The roster of a course, or null when the source has no such course. */
  listEnrolled(sourceCourseKey: string): Promise<readonly IsvuRosterRow[] | null>;
  submitGrades(
    sourceCourseKey: string,
    batch: readonly IsvuGradeRow[],
    confirmation: GradeConfirmation,
  ): Promise<IsvuSubmitOutcome>;
};

declare const confirmationBrand: unique symbol;

/**
 * A teacher's confirmation of one batch for one course. It cannot be written
 * as a literal: the brand is a type-level symbol, and at run time only an
 * object made by `confirmGradeBatch` is accepted.
 */
export type GradeConfirmation = {
  readonly [confirmationBrand]: true;
  readonly sourceCourseKey: string;
  readonly batchSha256: string;
};

const ISSUED = new WeakSet<object>();

/** True for a whole number from GRADE_MIN to GRADE_MAX. */
export function isGrade(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= GRADE_MIN && (value as number) <= GRADE_MAX
  );
}

/** A batch that may be hashed: 1 to GRADE_BATCH_MAX_ROWS rows, a grade each, no student twice. */
export function isValidBatch(batch: unknown): batch is readonly IsvuGradeRow[] {
  if (!Array.isArray(batch) || batch.length < 1 || batch.length > GRADE_BATCH_MAX_ROWS)
    return false;
  const seen = new Set<string>();
  for (const row of batch as unknown[]) {
    if (!row || typeof row !== "object") return false;
    const { identifier, grade } = row as Record<string, unknown>;
    if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 255) {
      return false;
    }
    if (!isGrade(grade) || seen.has(identifier)) return false;
    seen.add(identifier);
  }
  return true;
}

/**
 * The SHA-256 of a batch, in hex: rows ordered by identifier, one line
 * `identifier TAB grade LF` each, so the order a teacher typed them in does
 * not matter. Throws on a batch that is not valid (a programming error).
 */
export function gradeBatchSha256(batch: readonly IsvuGradeRow[]): string {
  if (!isValidBatch(batch)) throw new TypeError("gradeBatchSha256: invalid batch");
  const text = [...batch]
    .sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0))
    .map((row) => `${row.identifier}\t${row.grade}\n`)
    .join("");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The confirmation of a batch, made after the teacher confirmed its preview.
 * Only a route that holds that confirmation calls this; the adapter checks
 * that the batch it gets hashes to the same value.
 */
export function confirmGradeBatch(input: {
  readonly sourceCourseKey: string;
  readonly batchSha256: string;
}): GradeConfirmation {
  const confirmation = Object.freeze({
    sourceCourseKey: input.sourceCourseKey,
    batchSha256: input.batchSha256,
  }) as unknown as GradeConfirmation;
  ISSUED.add(confirmation);
  return confirmation;
}

/** True only for an object that `confirmGradeBatch` made. */
export function isGradeConfirmation(value: unknown): value is GradeConfirmation {
  return typeof value === "object" && value !== null && ISSUED.has(value);
}
