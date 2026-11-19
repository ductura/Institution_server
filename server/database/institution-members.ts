// The port of the institution RPCs of a course's students and an
// assignment's versions (contracts institution.student-removal.post,
// institution.student-return.post, institution.assignment-versions.post).
// Port of the RPC part of Ductus src/server/institution/{student-removal-route,
// student-return-route,assignment-version-route}.ts and of rpcErrorResponse in
// mutation-route.ts at 078c780, in the form of institution-courses.ts: an
// outcome (status) instead of an HTTP response, a malformed row rolls back
// and is unavailable, the port never throws and no SQLSTATE leaves it. Who
// may do what is the SECURITY DEFINER RPC's (ZD403 alike for another
// institution's course or assignment and a missing one). Inputs come already
// checked (server/institution and the route).
import { call, single, type Refused, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

/** ZD401, ZD403 by name; ZD422 is not judged by these RPCs, so it is unavailable (Ductus). */
export type StudentRemovalOutcome =
  | { readonly status: "removed"; readonly removed: boolean }
  | Refused<"unauthenticated" | "forbidden">
  | Unavailable;

export type StudentReturnOutcome =
  | { readonly status: "allowed"; readonly allowed: boolean }
  | Refused<"unauthenticated" | "forbidden">
  | Unavailable;

/** ZD401, ZD403, ZD409 (a stale expectedVersion), ZD422 (a tightening) by name. */
export type AssignmentVersionOutcome =
  | { readonly status: "published"; readonly versionNo: number }
  | Refused<"unauthenticated" | "forbidden" | "version_conflict" | "invalid">
  | Unavailable;

/** The content of a version as the RPC takes it (server/institution AssignmentContent). */
export type AssignmentVersionContent = {
  readonly title: string;
  readonly instructions: string;
  readonly workType: string;
  readonly opensAt: string;
  readonly dueAt: string;
  readonly aiPolicy: string;
  readonly aiPurposes: readonly string[];
  readonly evidenceProfile: string;
  readonly importAllowed: boolean;
  readonly wordMin: number | null;
  readonly wordMax: number | null;
};

export type InstitutionMembers = {
  removeStudent(token: string, courseId: string, studentId: string): Promise<StudentRemovalOutcome>;
  allowStudentReturn(
    token: string,
    courseId: string,
    studentId: string,
  ): Promise<StudentReturnOutcome>;
  publishAssignmentVersion(
    token: string,
    assignmentId: string,
    expectedVersion: number,
    content: AssignmentVersionContent,
  ): Promise<AssignmentVersionOutcome>;
};

const REMOVE_SQL = "SELECT institution.remove_student($1, $2) AS removed";
const RETURN_SQL = "SELECT institution.allow_student_return($1, $2) AS allowed";
const PUBLISH_SQL = `SELECT institution.publish_assignment_version(
  $1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz,
  $8::text, $9::text[], $10::text, $11::boolean, $12::integer, $13::integer
) AS version_no`;
const MAX_VERSION = 2_147_483_647;
const MEMBER_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
] as const);
const PUBLISH_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "version_conflict"],
  ["ZD422", "invalid"],
] as const);

const readBoolean = (column: string) => (rows: unknown) => {
  const value = single(rows, column);
  return typeof value === "boolean" ? value : null;
};

export function createInstitutionMembers(withActor: WithActor): InstitutionMembers {
  return {
    async removeStudent(token, courseId, studentId) {
      const params = [courseId, studentId];
      const read = readBoolean("removed");
      const outcome = await call(
        withActor,
        token,
        REMOVE_SQL,
        params,
        read,
        MEMBER_REFUSED,
        "removal_malformed",
      );
      return "value" in outcome ? { status: "removed", removed: outcome.value } : outcome;
    },
    async allowStudentReturn(token, courseId, studentId) {
      const params = [courseId, studentId];
      const read = readBoolean("allowed");
      const outcome = await call(
        withActor,
        token,
        RETURN_SQL,
        params,
        read,
        MEMBER_REFUSED,
        "return_malformed",
      );
      return "value" in outcome ? { status: "allowed", allowed: outcome.value } : outcome;
    },
    async publishAssignmentVersion(token, assignmentId, expectedVersion, c) {
      // Ductus: exactly one row whose version is the expected one plus one.
      const readNext = (rows: unknown) => {
        const next = single(rows, "version_no");
        return next === expectedVersion + 1 &&
          Number.isSafeInteger(next) &&
          next >= 1 &&
          next <= MAX_VERSION
          ? next
          : null;
      };
      const params = [
        assignmentId,
        expectedVersion,
        c.title,
        c.instructions,
        c.workType,
        c.opensAt,
        c.dueAt,
        c.aiPolicy,
        [...c.aiPurposes],
        c.evidenceProfile,
        c.importAllowed,
        c.wordMin,
        c.wordMax,
      ];
      const outcome = await call(
        withActor,
        token,
        PUBLISH_SQL,
        params,
        readNext,
        PUBLISH_REFUSED,
        "version_malformed",
      );
      return "value" in outcome ? { status: "published", versionNo: outcome.value } : outcome;
    },
  };
}
