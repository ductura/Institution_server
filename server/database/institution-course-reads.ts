// The reads of the administrator's course screen A-03 (DAN-1089; contract
// Ductus#2028 c.6968016327). Port of Ductus src/server/institution/
// institution-courses.ts (DAN-313) and of nameOf and compareByName in
// teacher-roles.ts at 70c168f over institution.institution_courses(year) and
// institution.institution_academic_years(). One withActor transaction of one
// STABLE statement each. Who asks and which institution come only from the
// session token; ZD401 is unauthenticated, ZD403 forbidden, ZD422 invalid.
// Any row that is not what the function returns makes the whole read
// unavailable, never a shorter list. Changes: an outcome (status) instead of
// Ductus `kind`, forbidden instead of notFound (the route answers 403, not
// the page's 404), nothing is logged (Ductus logged a constant message and
// the SQLSTATE), and no SQLSTATE leaves the port. As in Ductus, an error
// whose `code` cannot be read rejects the read; the route answers it 503.
import type { ActorTransaction, WithActor } from "./with-actor.ts";

export type PersonName = { readonly givenName: string; readonly familyName: string } | null;
export type CoursePerson = { readonly personId: string; readonly name: PersonName };
export type InstitutionGroup = {
  readonly groupId: string;
  readonly name: string;
  /** Open students of the group who are still open students of the course. */
  readonly students: number;
  readonly teachers: CoursePerson[];
};
export type InstitutionCourse = {
  readonly courseId: string;
  readonly name: string;
  readonly students: number;
  readonly holder: CoursePerson | null;
  readonly team: CoursePerson[];
  readonly groups: InstitutionGroup[];
};

type Refused = { readonly status: "unauthenticated" | "forbidden" | "unavailable" };
export type InstitutionCoursesOutcome =
  | { readonly status: "ok"; readonly academicYear: string; readonly courses: InstitutionCourse[] }
  | Refused
  | { readonly status: "invalid" };
export type AcademicYearsOutcome = { readonly status: "ok"; readonly years: string[] } | Refused;

export type InstitutionCourseReads = {
  readCourses(token: string, academicYear: unknown): Promise<InstitutionCoursesOutcome>;
  readAcademicYears(token: string): Promise<AcademicYearsOutcome>;
};

type Row = Record<string, unknown>;

const COURSES = `SELECT kind, course_id::text, course_name, group_id::text, group_name, user_id::text,
  given_name, family_name, students
  FROM institution.institution_courses($1)`;
const YEARS = "SELECT academic_year FROM institution.institution_academic_years()";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YEAR = /^([0-9]{4})\/([0-9]{4})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LABEL_MAX = 200;
const NAME_MAX = 255;
const REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD422", "invalid"],
] as const);

/** The form and the rule create_course requires: YYYY/YYYY, the second the year after the first. */
export function isAcademicYear(value: unknown): value is string {
  const m = typeof value === "string" ? YEAR.exec(value) : null;
  return m !== null && Number(m[2]) === Number(m[1]) + 1;
}

const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A course or group name as institution.is_plain_label stored it, counted in code points. */
const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  /\S/u.test(value) &&
  [...value].length <= LABEL_MAX &&
  !CONTROL.test(value);
/** A name of the login claims (Ductus isName): 1 to 255 code points, no control character. */
const isName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  [...value].length <= NAME_MAX &&
  !CONTROL.test(value);

/** Both names, or null for neither; undefined for anything else. */
function nameOf(given: unknown, family: unknown): PersonName | undefined {
  if (given === null && family === null) return null;
  if (isName(given) && isName(family)) return { givenName: given, familyName: family };
  return undefined;
}

// Croatian collation (ECMA-402: localeCompare with a locale compares as that
// locale's collator, Ductus `new Intl.Collator("hr")`); it returns a number,
// never text (local/no-hardcoded-text bars the Intl namespace in server code).
const collate = (a: string, b: string) => a.localeCompare(b, "hr");
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Surname, then given name (Croatian collation), then id; people without a name last, by id. */
function compareByName(a: CoursePerson, b: CoursePerson): number {
  if (a.name === null || b.name === null) {
    return a.name === b.name ? byId(a.personId, b.personId) : a.name === null ? 1 : -1;
  }
  return (
    collate(a.name.familyName, b.name.familyName) ||
    collate(a.name.givenName, b.name.givenName) ||
    byId(a.personId, b.personId)
  );
}
const byLabel = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  collate(a.name, b.name) || byId(a.id, b.id);

type GroupDraft = InstitutionGroup & { courseId: string; teacherIds: Set<string> };
type Draft = Omit<InstitutionCourse, "groups" | "holder"> & {
  holder: CoursePerson | null;
  groups: GroupDraft[];
  teamIds: Set<string>;
};
const nulls = (row: Row, keys: readonly string[]) => keys.every((k) => row[k] === null);

/** The rows as courses, or null when any row is not what the function returns. */
export function institutionCoursesOf(rows: readonly Row[]): InstitutionCourse[] | null {
  const courses = new Map<string, Draft>();
  const groups = new Map<string, GroupDraft>();
  const names = new Map<string, PersonName>();
  // Courses and groups first, so the other rows may come in any order.
  for (const row of rows) {
    if (row.kind === "course") {
      const { course_id: id, course_name: name, students } = row;
      if (!isId(id) || courses.has(id) || !isLabel(name) || !isCount(students)) return null;
      if (!nulls(row, ["group_id", "group_name", "user_id", "given_name", "family_name"]))
        return null;
      courses.set(id, {
        courseId: id,
        name,
        students,
        holder: null,
        team: [],
        groups: [],
        teamIds: new Set(),
      });
    } else if (row.kind === "group") {
      const { course_id: courseId, group_id: id, group_name: name, students } = row;
      if (!isId(courseId) || !isId(id) || groups.has(id) || !isLabel(name) || !isCount(students))
        return null;
      if (!nulls(row, ["course_name", "user_id", "given_name", "family_name"])) return null;
      groups.set(id, {
        groupId: id,
        name,
        students,
        teachers: [],
        courseId,
        teacherIds: new Set(),
      });
    } else if (!["holder", "team", "group_teacher"].includes(row.kind as string)) {
      return null;
    }
  }
  for (const group of groups.values()) {
    const course = courses.get(group.courseId);
    if (!course) return null;
    course.groups.push(group);
  }
  for (const row of rows) {
    if (row.kind === "course" || row.kind === "group") continue;
    const { course_id: courseId, user_id: personId } = row;
    const course = isId(courseId) ? courses.get(courseId) : undefined;
    const name = nameOf(row.given_name, row.family_name);
    if (!course || !isId(personId) || name === undefined) return null;
    if (!nulls(row, ["course_name", "group_name", "students"])) return null;
    // One person, one name pair in the institution.
    if (names.has(personId) && JSON.stringify(names.get(personId)) !== JSON.stringify(name))
      return null;
    names.set(personId, name);
    const person = { personId, name };
    if (row.kind === "holder") {
      if (row.group_id !== null || course.holder !== null) return null;
      course.holder = person;
    } else if (row.kind === "team") {
      if (row.group_id !== null || course.teamIds.has(personId)) return null;
      course.teamIds.add(personId);
      course.team.push(person);
    } else {
      const group = isId(row.group_id) ? groups.get(row.group_id) : undefined;
      if (!group || group.courseId !== course.courseId || group.teacherIds.has(personId))
        return null;
      group.teacherIds.add(personId);
      group.teachers.push(person);
    }
  }
  const result: InstitutionCourse[] = [];
  for (const course of courses.values()) {
    // A student is in at most one open group of a course.
    if (course.groups.reduce((sum, g) => sum + g.students, 0) > course.students) return null;
    // A group teacher is a team member.
    if (course.groups.some((g) => [...g.teacherIds].some((id) => !course.teamIds.has(id))))
      return null;
    result.push({
      courseId: course.courseId,
      name: course.name,
      students: course.students,
      holder: course.holder,
      team: course.team.sort(compareByName),
      groups: course.groups
        .map(({ groupId, name, students, teachers }) => ({
          groupId,
          name,
          students,
          teachers: teachers.sort(compareByName),
        }))
        .sort((a, b) => byLabel({ name: a.name, id: a.groupId }, { name: b.name, id: b.groupId })),
    });
  }
  return result.sort((a, b) =>
    byLabel({ name: a.name, id: a.courseId }, { name: b.name, id: b.courseId }),
  );
}

/** The years, newest first, or null when any row is not a distinct academic year. */
export function academicYearsOf(rows: readonly Row[]): string[] | null {
  const years = rows.map((r) => r.academic_year);
  if (!years.every(isAcademicYear) || new Set(years).size !== years.length) return null;
  return [...years].sort().reverse();
}

/** The code of a database error, read as Ductus does: a getter or Proxy that throws rejects the read. */
function codeOf(thrown: unknown): unknown {
  return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
}

type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unauthenticated" | "forbidden" | "invalid" | "unavailable" };

async function read<T>(
  withActor: WithActor,
  token: string,
  query: (tx: ActorTransaction) => Promise<Row[]>,
  parse: (rows: Row[]) => T | null,
): Promise<Read<T>> {
  let rows: Row[];
  try {
    rows = await withActor(token, query);
  } catch (error) {
    const code = codeOf(error);
    const refused = typeof code === "string" ? REFUSED.get(code as "ZD401") : undefined;
    return { status: refused ?? "unavailable" };
  }
  const value = parse(rows);
  return value === null ? { status: "unavailable" } : { status: "ok", value };
}

export function createInstitutionCourseReads(withActor: WithActor): InstitutionCourseReads {
  return {
    async readCourses(token, academicYear) {
      if (!TOKEN.test(token)) return { status: "unauthenticated" };
      if (!isAcademicYear(academicYear)) return { status: "invalid" };
      const answer = await read(
        withActor,
        token,
        async (tx) => (await tx.query<Row>(COURSES, [academicYear])).rows,
        institutionCoursesOf,
      );
      return answer.status === "ok"
        ? { status: "ok", academicYear, courses: answer.value }
        : { status: answer.status };
    },
    async readAcademicYears(token) {
      if (!TOKEN.test(token)) return { status: "unauthenticated" };
      const answer = await read(
        withActor,
        token,
        async (tx) => (await tx.query<Row>(YEARS)).rows,
        academicYearsOf,
      );
      if (answer.status === "ok") return { status: "ok", years: answer.value };
      // The years take no input; a ZD422 here is not what the function raises.
      return { status: answer.status === "invalid" ? "unavailable" : answer.status };
    },
  };
}
