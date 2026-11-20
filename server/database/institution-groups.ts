// The port of the seminar group RPCs (SRV-15, Ductus#2028 c.7008147932):
// institution.create_seminar_group, institution.assign_group_teacher and the
// reader institution.course_groups, in the form of institution-courses.ts (an
// outcome, never a throw). Who may is the RPC's (owner decision "A opcija",
// c.7016215710, migration 20261119170000: the teacher of the course, an
// administrator of its institution and, for a new group and the read, a
// collaborator of the course team; ZD403 alike for another institution's or
// an unknown course or group); the caller comes only from the session. One
// call is one withActor transaction of one statement.
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

export type CourseGroupTeacher = {
  readonly id: string;
  readonly givenName: string;
  readonly familyName: string;
};
export type CourseGroup = {
  readonly id: string;
  readonly name: string;
  readonly teachers: readonly CourseGroupTeacher[];
  readonly students: number;
};

/** ZD401, ZD403 by name; a row of another form, a teacher without a name included, is unavailable. */
export type CourseGroupsOutcome =
  | { readonly status: "read"; readonly groups: readonly CourseGroup[] }
  | Refused<"unauthenticated" | "forbidden">
  | Unavailable;

export type InstitutionGroups = {
  createGroup(token: string, courseId: string, name: string): Promise<GroupCreateOutcome>;
  assignGroupTeacher(
    token: string,
    groupId: string,
    teacherId: string,
  ): Promise<GroupTeacherOutcome>;
  readCourseGroups(token: string, courseId: string): Promise<CourseGroupsOutcome>;
};

const CREATE_SQL = "SELECT institution.create_seminar_group($1::uuid, $2::text) AS id";
// Whether a place was opened is the RPC's answer, decided under the course's
// group lock (20261119170000): an administrator does not read the group
// tables, so the port could not tell it from a read of its own.
const ASSIGN_SQL = "SELECT institution.assign_group_teacher($1::uuid, $2::uuid) AS assigned";
// The order of the contract (institution.course-groups.get): groups by name,
// then id; teachers by family and given name, then id; Croatian collation.
const GROUPS_SQL = `SELECT g.group_id AS id, g.name, g.students,
  (SELECT coalesce(pg_catalog.jsonb_agg(t ORDER BY (t ->> 'family_name') COLLATE "hr-x-icu",
                   (t ->> 'given_name') COLLATE "hr-x-icu", t ->> 'id'), '[]'::jsonb)
     FROM pg_catalog.jsonb_array_elements(g.teachers) t) AS teachers
  FROM institution.course_groups($1::uuid) g
 ORDER BY g.name COLLATE "hr-x-icu", g.group_id`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD422", "invalid"],
] as const);
const READ_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
] as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A teacher of the reader's jsonb, or null; a missing name is null, never guessed. */
function teacherOf(value: unknown): CourseGroupTeacher | null {
  if (!isRecord(value)) return null;
  const { id, given_name: givenName, family_name: familyName } = value;
  return typeof id === "string" && LOWER_UUID.test(id) && isText(givenName) && isText(familyName)
    ? { id, givenName, familyName }
    : null;
}

/** Every row of the reader, or null when any one is of another form. */
export function courseGroupsOf(rows: unknown): CourseGroup[] | null {
  if (!Array.isArray(rows)) return null;
  const groups: CourseGroup[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return null;
    const { id, name, students, teachers } = row;
    if (typeof id !== "string" || !LOWER_UUID.test(id) || !isText(name)) return null;
    if (!Number.isSafeInteger(students) || (students as number) < 0) return null;
    if (!Array.isArray(teachers)) return null;
    const list = teachers.map(teacherOf);
    if (list.some((teacher) => teacher === null)) return null;
    groups.push({ id, name, teachers: list as CourseGroupTeacher[], students: students as number });
  }
  return groups;
}

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
    async readCourseGroups(token, courseId) {
      const outcome = await call(
        withActor,
        token,
        GROUPS_SQL,
        [courseId],
        courseGroupsOf,
        READ_REFUSED,
        "course_groups_malformed",
      );
      return "value" in outcome ? { status: "read", groups: outcome.value } : outcome;
    },
  };
}
