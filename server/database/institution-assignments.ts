// The port of the assignment RPCs (SRV-14, Ductus#2028 c.7008147932): the RPC
// part of Ductus src/server/institution/create-assignment.ts and
// assignment-version-route.ts at 078c780, in the form of
// institution-courses.ts: an outcome instead of a response, a malformed row
// thrown inside the transaction, and a port that never throws. One call is
// one withActor transaction of one statement; the message of a database
// error is never read and its SQLSTATE never leaves the port. Inputs come
// already checked (server/institution/assignment-input.ts, the route).
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

/** The content of a version as the RPCs take it, in their order. */
export type AssignmentContent = {
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

/** ZD401, ZD403, ZD409 (the same key with other content), ZD422 by name. */
export type AssignmentCreateOutcome =
  | { readonly status: "created"; readonly id: string }
  | Refused<"unauthenticated" | "forbidden" | "conflict" | "invalid">
  | Unavailable;

/** ZD401, ZD403, ZD409 (a stale expected version), ZD422 by name. */
export type AssignmentPublishOutcome =
  | { readonly status: "published"; readonly versionNo: number }
  | Refused<"unauthenticated" | "forbidden" | "version_conflict" | "invalid">
  | Unavailable;

export type InstitutionAssignments = {
  createAssignment(
    token: string,
    courseId: string,
    requestKey: string,
    content: AssignmentContent,
  ): Promise<AssignmentCreateOutcome>;
  publishVersion(
    token: string,
    assignmentId: string,
    expectedVersion: number,
    content: AssignmentContent,
  ): Promise<AssignmentPublishOutcome>;
};

const CREATE_SQL = `SELECT institution.create_assignment(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz,
  $8::text, $9::text[], $10::text, $11::boolean, $12::integer, $13::integer
) AS id`;
const PUBLISH_SQL = `SELECT institution.publish_assignment_version(
  $1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz,
  $8::text, $9::text[], $10::text, $11::boolean, $12::integer, $13::integer
) AS version_no`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CREATE_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);
const PUBLISH_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "version_conflict"],
  ["ZD422", "invalid"],
] as const);

const contentParams = (c: AssignmentContent): unknown[] => [
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

export function createInstitutionAssignments(withActor: WithActor): InstitutionAssignments {
  return {
    async createAssignment(token, courseId, requestKey, content) {
      const readId = (rows: unknown) => {
        const id = single(rows, "id");
        return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
      };
      const params = [courseId, requestKey, ...contentParams(content)];
      const outcome = await call(
        withActor,
        token,
        CREATE_SQL,
        params,
        readId,
        CREATE_REFUSED,
        "create_assignment_malformed",
      );
      return "value" in outcome ? { status: "created", id: outcome.value } : outcome;
    },
    async publishVersion(token, assignmentId, expectedVersion, content) {
      // Exactly the next version: anything else is a row of the wrong form.
      const readVersion = (rows: unknown) => {
        const next = single(rows, "version_no");
        return next === expectedVersion + 1 ? next : null;
      };
      const params = [assignmentId, expectedVersion, ...contentParams(content)];
      const outcome = await call(
        withActor,
        token,
        PUBLISH_SQL,
        params,
        readVersion,
        PUBLISH_REFUSED,
        "publish_malformed",
      );
      return "value" in outcome
        ? { status: "published", versionNo: outcome.value as number }
        : outcome;
    },
  };
}
