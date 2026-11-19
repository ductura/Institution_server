// The port of the institution course RPCs (DAN-852-2a, 2b; contract
// Ductus#1836 c.6943486866). Port of the RPC part of Ductus
// src/server/institution/{create-course,enrollment-code-route,
// enrollment-code-revocation-route}.ts and of rpcErrorResponse in
// mutation-route.ts at 078c780fb0e53ecaa51757d4913508834a0723a1, with these
// changes: an outcome (status) instead of an HTTP response, which the route
// (852-4) maps to its problem code; a malformed row is a private sentinel
// thrown inside fn, so withActor rolls back, instead of an Error; the course
// row is checked inside the transaction and must be exactly one (Ductus:
// after it, rows[0]), as Ductus already does for the code and the
// revocation; and the port never throws. One call is one withActor transaction of one statement.
// The message of a database error is never read and its SQLSTATE never
// leaves the port. Inputs come already checked (852-3, 852-4).
import type { WithActor } from "./with-actor.ts";

export type Refused<S extends string> = { readonly status: S };
export type Unavailable = { readonly status: "unavailable"; readonly reason: string };

/** ZD401, ZD403, ZD422 by name; anything else, and a wrong row, is unavailable. */
export type EnrollmentCodeIssueOutcome =
  | { readonly status: "issued"; readonly code: string }
  | Refused<"unauthenticated" | "forbidden" | "invalid">
  | Unavailable;

/** ZD401, ZD403, ZD409, ZD422 by name; the id is any-case UUID, as the contract's Uuid. */
export type CourseCreateOutcome =
  | { readonly status: "created"; readonly id: string }
  | Refused<"unauthenticated" | "forbidden" | "conflict" | "invalid">
  | Unavailable;

/** ZD401, ZD403 by name; ZD422 is not raised by this RPC, so it is unavailable (Ductus). */
export type EnrollmentCodeRevokeOutcome =
  | { readonly status: "revoked"; readonly revoked: boolean }
  | Refused<"unauthenticated" | "forbidden">
  | Unavailable;

export type CourseInput = { name: string; academicYear: string; aiPolicy: string };

export type InstitutionCourses = {
  createCourse(token: string, course: CourseInput): Promise<CourseCreateOutcome>;
  revokeEnrollmentCode(token: string, courseId: string): Promise<EnrollmentCodeRevokeOutcome>;
  issueEnrollmentCode(
    token: string,
    courseId: string,
    validUntil: string,
  ): Promise<EnrollmentCodeIssueOutcome>;
};

const COURSE_SQL = "SELECT institution.create_course($1, $2, $3) AS id";
const REVOKE_SQL = "SELECT institution.revoke_enrollment_code($1) AS revoked";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COURSE_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);
const REVOKE_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
] as const);
const ISSUE_SQL = "SELECT institution.create_enrollment_code($1, $2::timestamptz) AS code";
const CODE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;
const ISSUE_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD422", "invalid"],
] as const);

// Thrown inside fn for a row of the wrong form and known only by identity.
const MALFORMED: unique symbol = Symbol("institution-courses malformed row");
const unavailable = (reason: string): Unavailable => ({ status: "unavailable", reason });

/** The code of a database error, read as Ductus does; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** The one value read from the rows, or the outcome of a refusal or fault; never throws. */
export async function call<T, S extends string>(
  withActor: WithActor,
  token: string,
  sql: string,
  params: unknown[],
  read: (rows: unknown) => T | null,
  refused: ReadonlyMap<string, S>,
  malformed: string,
): Promise<{ readonly value: T } | Refused<S> | Unavailable> {
  try {
    const value = await withActor(token, async (tx) => {
      const found = read((await tx.query(sql, params)).rows);
      if (found === null) throw MALFORMED;
      return found;
    });
    return { value };
  } catch (thrown) {
    if (thrown === MALFORMED) return unavailable(malformed);
    const code = codeOf(thrown);
    const status = typeof code === "string" ? refused.get(code) : undefined;
    return status === undefined ? unavailable("database_error") : { status };
  }
}

/** The column of exactly one row, own only. */
export function single(rows: unknown, column: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row: unknown = rows[0];
  return row !== null && typeof row === "object" && Object.hasOwn(row, column)
    ? (row as Record<string, unknown>)[column]
    : undefined;
}

export function createInstitutionCourses(withActor: WithActor): InstitutionCourses {
  return {
    async createCourse(token, { name, academicYear, aiPolicy }) {
      const readId = (rows: unknown) => {
        const id = single(rows, "id");
        return typeof id === "string" && UUID.test(id) ? id : null;
      };
      const params = [name, academicYear, aiPolicy];
      const outcome = await call(
        withActor,
        token,
        COURSE_SQL,
        params,
        readId,
        COURSE_REFUSED,
        "create_malformed",
      );
      return "value" in outcome ? { status: "created", id: outcome.value } : outcome;
    },
    async revokeEnrollmentCode(token, courseId) {
      const readRevoked = (rows: unknown) => {
        const revoked = single(rows, "revoked");
        return typeof revoked === "boolean" ? revoked : null;
      };
      const outcome = await call(
        withActor,
        token,
        REVOKE_SQL,
        [courseId],
        readRevoked,
        REVOKE_REFUSED,
        "revoke_malformed",
      );
      return "value" in outcome ? { status: "revoked", revoked: outcome.value } : outcome;
    },
    async issueEnrollmentCode(token, courseId, validUntil) {
      const readCode = (rows: unknown) => {
        const code = single(rows, "code");
        return typeof code === "string" && CODE.test(code) ? code : null;
      };
      const params = [courseId, validUntil];
      const outcome = await call(
        withActor,
        token,
        ISSUE_SQL,
        params,
        readCode,
        ISSUE_REFUSED,
        "issue_malformed",
      );
      return "value" in outcome ? { status: "issued", code: outcome.value } : outcome;
    },
  };
}
