// The port of institution.enroll_with_code (DAN-853-1b). Port of the RPC
// part of Ductus src/server/institution/enrollment-route.ts at 078c780, with
// these changes: an outcome (status) instead of an HTTP response, which the
// route (853-1c) maps to its problem code, and the port never throws. As in
// Ductus, the row is read only after withActor commits: a refused guess
// stores its attempt in the same transaction, so a row of a wrong form must
// never roll it back. One call is one withActor transaction (READ
// COMMITTED, which the RPC requires) of one statement. The message of a
// database error is never read and its SQLSTATE never leaves the port.
import type { WithActor } from "./with-actor.ts";

export type EnrollmentOutcome =
  | { readonly status: "enrolled"; readonly courseId: string }
  | { readonly status: "refused" | "too_many_attempts" | "unauthenticated" | "forbidden" }
  | { readonly status: "unavailable"; readonly reason: string };

export type InstitutionEnrollment = {
  enrollWithCode(token: string, code: string): Promise<EnrollmentOutcome>;
};

const SQL = "SELECT outcome, enrolled_course_id FROM institution.enroll_with_code($1::text)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED: ReadonlyMap<string, "unauthenticated" | "forbidden"> = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
] as const);

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
function outcomeOf(rows: unknown): EnrollmentOutcome {
  const row = onlyRow(rows);
  if (row?.outcome === "enrolled" && typeof row.course === "string" && UUID.test(row.course)) {
    return { status: "enrolled", courseId: row.course };
  }
  if ((row?.outcome === "refused" || row?.outcome === "too_many_attempts") && row.course === null) {
    return { status: row.outcome };
  }
  return { status: "unavailable", reason: "enroll_malformed" };
}

export function createInstitutionEnrollment(withActor: WithActor): InstitutionEnrollment {
  return {
    async enrollWithCode(token, code) {
      let rows: unknown;
      try {
        rows = await withActor(token, async (tx) => (await tx.query(SQL, [code])).rows);
      } catch (thrown) {
        const sqlState = codeOf(thrown);
        const status = typeof sqlState === "string" ? REFUSED.get(sqlState) : undefined;
        return status === undefined
          ? { status: "unavailable", reason: "database_error" }
          : { status };
      }
      try {
        return outcomeOf(rows);
      } catch {
        // A getter or Proxy in the rows that throws: the row is not of the form.
        return { status: "unavailable", reason: "enroll_malformed" };
      }
    },
  };
}
