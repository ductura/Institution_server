// The port of institution.admin_create_course (SRV-12 over SRV-07, Ductus#2028
// c.7008147932): the administrator of an institution creates a course and
// names its holder, in the form of institution-courses.ts (an outcome, never
// a throw). Who may is the RPC's (ZD403 for anyone who is not an
// administrator); the caller comes only from the session. One call is one
// withActor transaction: the course, then (F4 wave 2 #9, 1.9) its groups.
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

/** ZD401, ZD403, ZD409 (the same course with another policy or holder), ZD422 by name. */
export type AdminCourseOutcome =
  | {
      readonly status: "created";
      readonly id: string;
      readonly groups: readonly { readonly id: string; readonly name: string }[];
    }
  | Refused<"unauthenticated" | "forbidden" | "conflict" | "invalid">
  | Unavailable;

export type AdminCourseInput = {
  readonly name: string;
  readonly academicYear: string;
  readonly aiPolicy: string;
  readonly holderId: string;
  /** The course's first groups, distinct names as the route checked them; may be empty. */
  readonly groups: readonly string[];
};

export type AdminCourses = {
  createCourse(token: string, course: AdminCourseInput): Promise<AdminCourseOutcome>;
};

const CREATE_SQL =
  "SELECT institution.admin_create_course($1::text, $2::text, $3::text, $4::uuid) AS id";
// The course's groups as they stand, then each group made (create_seminar_group
// answers the same id for a name the course already has). Both allow the
// administrator of the course's institution (require_group_manager,
// migration 20261119170000), so no new function is needed.
const EXISTING_SQL = "SELECT group_id, name FROM institution.course_groups($1::uuid)";
const GROUP_SQL = "SELECT institution.create_seminar_group($1::uuid, $2::text) AS id";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);

type Group = { readonly id: string; readonly name: string };

/**
 * Makes the groups of the course just created or replayed, in the request's
 * order, into `made`. A course that already has groups (a replay, or groups the
 * holder added since) must have exactly these names, or it is the course's
 * conflict (ZD409), as admin_create_course's for another policy or holder; a
 * name the database refuses is its ZD422. Either rolls the course back too.
 * A row of the wrong form is false.
 */
async function makeGroups(
  tx: ActorTransaction,
  courseId: string,
  names: readonly string[],
  made: Group[],
): Promise<boolean> {
  const { rows } = await tx.query(EXISTING_SQL, [courseId]);
  const existing = rows.map((row) => (Object.hasOwn(row, "name") ? row.name : undefined));
  if (!existing.every((n): n is string => typeof n === "string")) return false;
  const wanted = new Set(names);
  if (
    existing.length > 0 &&
    !(existing.length === wanted.size && existing.every((n) => wanted.has(n)))
  ) {
    throw Object.assign(new Error("conflict"), { code: "ZD409" });
  }
  for (const name of names) {
    const id = single((await tx.query(GROUP_SQL, [courseId, name])).rows, "id");
    if (typeof id !== "string" || !UUID.test(id)) return false;
    made.push({ id: id.toLowerCase(), name });
  }
  return true;
}

export function createAdminCourses(withActor: WithActor): AdminCourses {
  return {
    async createCourse(token, { name, academicYear, aiPolicy, holderId, groups }) {
      const made: Group[] = [];
      const readId = (rows: unknown) => {
        const id = single(rows, "id");
        return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
      };
      const outcome = await call(
        withActor,
        token,
        CREATE_SQL,
        [name, academicYear, aiPolicy, holderId],
        readId,
        REFUSED,
        "admin_course_malformed",
        groups.length === 0 ? undefined : (tx, id) => makeGroups(tx, id, groups, made),
      );
      return "value" in outcome ? { status: "created", id: outcome.value, groups: made } : outcome;
    },
  };
}
