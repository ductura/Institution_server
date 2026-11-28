// The port of the assignment RPCs (SRV-14, Ductus#2028 c.7008147932): the RPC
// part of Ductus src/server/institution/create-assignment.ts and
// assignment-version-route.ts at 078c780, in the form of
// institution-courses.ts: an outcome instead of a response, a malformed row
// thrown inside the transaction, and a port that never throws. One call is
// one withActor transaction (of one statement, or two for a creation: the
// creation with its groups, then the links as stored); the message of a database
// error is never read and its SQLSTATE never leaves the port. Inputs come
// already checked (server/institution/assignment-input.ts, the route).
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

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

/**
 * The teacher's rules fixed on creation (UGOVORI-API zs-3): outside tools and
 * the AI assistant that only summarises. Absent in the body is false.
 */
export type AssignmentSetup = {
  readonly externalToolsAllowed: boolean;
  readonly aiSummaryOnly: boolean;
};

/**
 * The kind of document an assignment asks for (institution.assignment.document_kind),
 * stored on creation and fixed (SRV-V13-VRSTA-PISAC, migration 20261220880000).
 */
export type AssignmentDocumentKind = "text" | "slides" | "spreadsheet";

const NO_SETUP: AssignmentSetup = { externalToolsAllowed: false, aiSummaryOnly: false };

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
    isPractice?: boolean,
    setup?: AssignmentSetup,
    groupIds?: readonly string[],
    documentKind?: AssignmentDocumentKind,
  ): Promise<AssignmentCreateOutcome>;
  /** documentKind null (or absent) checks nothing; another than the stored one is "invalid". */
  publishVersion(
    token: string,
    assignmentId: string,
    expectedVersion: number,
    content: AssignmentContent,
    documentKind?: AssignmentDocumentKind | null,
  ): Promise<AssignmentPublishOutcome>;
};

// F4 wave 2 #5 (1.8): the creation and the links to the course's groups in one
// statement (migration 20261220800000), which compares the stored links of a
// replayed key before anything is written; then the links as stored.
// SRV-V13-VRSTA-PISAC (20261220880000): the kind is the last argument of both; a
// replay of the key with another kind is ZD409, a version naming another kind ZD422.
const CREATE_SQL = `SELECT institution.create_assignment_with_groups(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz,
  $8::text, $9::text[], $10::text, $11::boolean, $12::integer, $13::integer, 1, $14::boolean,
  $15::boolean, $16::boolean, $17::uuid[], $18::text
) AS id`;
const PUBLISH_SQL = `SELECT institution.publish_assignment_version(
  $1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz,
  $8::text, $9::text[], $10::text, $11::boolean, $12::integer, $13::integer, $14::text
) AS version_no`;
const LINKED_SQL = "SELECT group_id FROM institution.assignment_groups($1::uuid)";
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

/**
 * Reads back the links of the assignment just created or replayed, which must
 * be exactly the groups asked (lower case, distinct: the route's); none is the
 * whole course. create_assignment_with_groups already refuses a replay of the
 * key with another set (ZD409) and a group of another course (ZD422) before it
 * writes; another set here is the same conflict and rolls back. A row of the
 * wrong form is false.
 */
async function checkGroups(
  tx: ActorTransaction,
  id: string,
  groupIds: readonly string[],
): Promise<boolean> {
  const { rows } = await tx.query(LINKED_SQL, [id]);
  const linked = rows.map((row) => (Object.hasOwn(row, "group_id") ? row.group_id : undefined));
  if (!linked.every((g): g is string => typeof g === "string" && UUID.test(g))) return false;
  const wanted = new Set(groupIds);
  const same = linked.length === wanted.size && linked.every((g) => wanted.has(g.toLowerCase()));
  if (!same) throw Object.assign(new Error("conflict"), { code: "ZD409" });
  return true;
}

export function createInstitutionAssignments(withActor: WithActor): InstitutionAssignments {
  return {
    async createAssignment(
      token,
      courseId,
      requestKey,
      content,
      isPractice = false,
      setup = NO_SETUP,
      groupIds = [],
      documentKind = "text",
    ) {
      const readId = (rows: unknown) => {
        const id = single(rows, "id");
        return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
      };
      const params = [
        courseId,
        requestKey,
        ...contentParams(content),
        isPractice,
        setup.externalToolsAllowed,
        setup.aiSummaryOnly,
        [...groupIds],
        documentKind,
      ];
      const outcome = await call(
        withActor,
        token,
        CREATE_SQL,
        params,
        readId,
        CREATE_REFUSED,
        "create_assignment_malformed",
        (tx, id) => checkGroups(tx, id, groupIds),
      );
      return "value" in outcome ? { status: "created", id: outcome.value } : outcome;
    },
    async publishVersion(token, assignmentId, expectedVersion, content, documentKind = null) {
      // Exactly the next version: anything else is a row of the wrong form.
      const readVersion = (rows: unknown) => {
        const next = single(rows, "version_no");
        return next === expectedVersion + 1 ? next : null;
      };
      const params = [assignmentId, expectedVersion, ...contentParams(content), documentKind];
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
