// The port of institution.admin_create_course (SRV-12 over SRV-07, Ductus#2028
// c.7008147932): the administrator of an institution creates a course and
// names its holder, in the form of institution-courses.ts (an outcome, never
// a throw). Who may is the RPC's (ZD403 for anyone who is not an
// administrator); the caller comes only from the session. One call is one
// withActor transaction of one statement.
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

/** ZD401, ZD403, ZD409 (the same course with another policy or holder), ZD422 by name. */
export type AdminCourseOutcome =
  | { readonly status: "created"; readonly id: string }
  | Refused<"unauthenticated" | "forbidden" | "conflict" | "invalid">
  | Unavailable;

export type AdminCourseInput = {
  readonly name: string;
  readonly academicYear: string;
  readonly aiPolicy: string;
  readonly holderId: string;
};

export type AdminCourses = {
  createCourse(token: string, course: AdminCourseInput): Promise<AdminCourseOutcome>;
};

const CREATE_SQL =
  "SELECT institution.admin_create_course($1::text, $2::text, $3::text, $4::uuid) AS id";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);

export function createAdminCourses(withActor: WithActor): AdminCourses {
  return {
    async createCourse(token, { name, academicYear, aiPolicy, holderId }) {
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
      );
      return "value" in outcome ? { status: "created", id: outcome.value } : outcome;
    },
  };
}
