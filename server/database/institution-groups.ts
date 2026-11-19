// The port of the seminar group RPCs (SRV-15, Ductus#2028 c.7008147932):
// institution.create_seminar_group and institution.assign_group_teacher, in
// the form of institution-courses.ts (an outcome, never a throw). Who may is
// the RPC's (require_course_teacher: a teacher of the course, ZD403 alike for
// another institution's or an unknown course or group); the caller comes only
// from the session. One call is one withActor transaction of one statement.
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

/** ZD401, ZD403, ZD422 (a name that is not a plain label) by name. */
export type GroupCreateOutcome =
  | { readonly status: "created"; readonly id: string }
  | Refused<"unauthenticated" | "forbidden" | "invalid">
  | Unavailable;

/** ZD401, ZD403, ZD422 (a teacher who is not confirmed) by name. */
export type GroupTeacherOutcome =
  | { readonly status: "assigned"; readonly assigned: boolean }
  | Refused<"unauthenticated" | "forbidden" | "invalid">
  | Unavailable;

export type InstitutionGroups = {
  createGroup(token: string, courseId: string, name: string): Promise<GroupCreateOutcome>;
  assignGroupTeacher(
    token: string,
    groupId: string,
    teacherId: string,
  ): Promise<GroupTeacherOutcome>;
};

const CREATE_SQL = "SELECT institution.create_seminar_group($1::uuid, $2::text) AS id";
// Whether the teacher already taught the group is read in the statement's
// snapshot, before the call writes; the RPC itself writes nothing twice.
const ASSIGN_SQL = `WITH earlier AS (
  SELECT EXISTS (
    SELECT 1 FROM institution.seminar_group_teacher t
     WHERE t.group_id = $1::uuid AND t.user_id = $2::uuid AND t.valid_to IS NULL
  ) AS was
), assigned AS (
  SELECT institution.assign_group_teacher($1::uuid, $2::uuid)
)
SELECT NOT earlier.was AS assigned FROM earlier, assigned`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD422", "invalid"],
] as const);

export function createInstitutionGroups(withActor: WithActor): InstitutionGroups {
  return {
    async createGroup(token, courseId, name) {
      const readId = (rows: unknown) => {
        const id = single(rows, "id");
        return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
      };
      const outcome = await call(
        withActor,
        token,
        CREATE_SQL,
        [courseId, name],
        readId,
        REFUSED,
        "create_group_malformed",
      );
      return "value" in outcome ? { status: "created", id: outcome.value } : outcome;
    },
    async assignGroupTeacher(token, groupId, teacherId) {
      const readAssigned = (rows: unknown) => {
        const assigned = single(rows, "assigned");
        return typeof assigned === "boolean" ? assigned : null;
      };
      const outcome = await call(
        withActor,
        token,
        ASSIGN_SQL,
        [groupId, teacherId],
        readAssigned,
        REFUSED,
        "assign_teacher_malformed",
      );
      return "value" in outcome ? { status: "assigned", assigned: outcome.value } : outcome;
    },
  };
}
