// The port of institution.enroll_with_code (DAN-853-1b). Port of the RPC
// part of Ductus src/server/institution/enrollment-route.ts at 078c780, with
// these changes: a Result with an AppError of a closed list
// (docs/CODE_STYLE.md §8) instead of an HTTP response, which the route
// (853-1e) maps to its problem code, and the port never throws. As in Ductus,
// the row is mapped only after withActor commits (fn only hands the rows
// on): a refused guess stores its attempt in the same transaction, so a row
// of a wrong form must never roll it back. One call is one withActor
// transaction (READ COMMITTED, which the RPC requires) of one statement. The
// message of a database error is never read and its SQLSTATE never leaves
// the port.
import type { AppError, Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** No session behind the token (ZD401). */
export const ENROLLMENT_UNAUTHENTICATED = error(
  "ENROLLMENT_UNAUTHENTICATED",
  "enrollment.unauthenticated",
);
/** ZD403; the RPC does not raise it today, kept from Ductus. */
export const ENROLLMENT_FORBIDDEN = error("ENROLLMENT_FORBIDDEN", "enrollment.forbidden");
/** A wrong or expired code; the attempt is stored. */
export const ENROLLMENT_REFUSED = error("ENROLLMENT_REFUSED", "enrollment.refused");
/** The caller's attempts in the window are used up. */
export const ENROLLMENT_TOO_MANY_ATTEMPTS = error(
  "ENROLLMENT_TOO_MANY_ATTEMPTS",
  "enrollment.too_many_attempts",
);
/** A row that is not what the RPC returns; nothing is rolled back. */
export const ENROLLMENT_ROW_MALFORMED = error(
  "ENROLLMENT_ROW_MALFORMED",
  "enrollment.row_malformed",
);
/** Any other error of the database or of withActor (ZD500, ZD503 …). */
export const ENROLLMENT_DATABASE_ERROR = error(
  "ENROLLMENT_DATABASE_ERROR",
  "enrollment.database_error",
);
export const ENROLLMENT_ERRORS: readonly AppError[] = [
  ENROLLMENT_UNAUTHENTICATED,
  ENROLLMENT_FORBIDDEN,
  ENROLLMENT_REFUSED,
  ENROLLMENT_TOO_MANY_ATTEMPTS,
  ENROLLMENT_ROW_MALFORMED,
  ENROLLMENT_DATABASE_ERROR,
];

export type Enrollment = { readonly courseId: string };

export type InstitutionEnrollment = {
  enrollWithCode(token: string, code: string): Promise<Result<Enrollment>>;
};

const SQL = "SELECT outcome, enrolled_course_id FROM institution.enroll_with_code($1::text)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED: ReadonlyMap<string, AppError> = new Map([
  ["ZD401", ENROLLMENT_UNAUTHENTICATED],
  ["ZD403", ENROLLMENT_FORBIDDEN],
]);

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

/** The code of a database error, read as Ductus does; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** Own columns of exactly one row, or null. */
function onlyRow(rows: unknown): { outcome: unknown; course: unknown } | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (row === null || typeof row !== "object") return null;
  const own = (column: string) =>
    Object.hasOwn(row, column) ? (row as Record<string, unknown>)[column] : undefined;
  return { outcome: own("outcome"), course: own("enrolled_course_id") };
}

/** Ductus: enrolled with a UUID, refused or too_many_attempts with null; anything else is malformed. */
function resultOf(rows: unknown): Result<Enrollment> {
  const row = onlyRow(rows);
  if (row?.outcome === "enrolled" && typeof row.course === "string" && UUID.test(row.course)) {
    return { ok: true, value: { courseId: row.course } };
  }
  if (row?.course === null && row.outcome === "refused") return fail(ENROLLMENT_REFUSED);
  if (row?.course === null && row.outcome === "too_many_attempts") {
    return fail(ENROLLMENT_TOO_MANY_ATTEMPTS);
  }
  return fail(ENROLLMENT_ROW_MALFORMED);
}

export function createInstitutionEnrollment(withActor: WithActor): InstitutionEnrollment {
  return {
    async enrollWithCode(token, code) {
      let rows: unknown;
      try {
        rows = await withActor(token, async (tx) => (await tx.query(SQL, [code])).rows);
      } catch (thrown) {
        const sqlState = codeOf(thrown);
        const refused = typeof sqlState === "string" ? REFUSED.get(sqlState) : undefined;
        return fail(refused ?? ENROLLMENT_DATABASE_ERROR);
      }
      try {
        return resultOf(rows);
      } catch {
        // A getter or Proxy in the rows that throws: the row is not of the form.
        return fail(ENROLLMENT_ROW_MALFORMED);
      }
    },
  };
}
