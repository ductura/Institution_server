// The teacher read ports over a fake withActor (Ductus teacher-courses.test.ts,
// mentored-works.test.ts and assignment-submissions.test.ts at 078c780): the
// rows as the contract's shapes, the order, the ZD codes, and a row the read
// cannot vouch for as unavailable for the whole answer. All values are invented.
import { describe, expect, it } from "vitest";

import { createAssignmentSubmissionsReader, submissionOf } from "./assignment-submissions.ts";
import { createMentoredWorksReader, mentoredWorkOf } from "./mentored-works.ts";
import { coursesOf, createTeacherCoursesReader } from "./teacher-courses.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const id = (n: number) => `3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c${String(n).padStart(2, "0")}`;
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

type Seen = { token: unknown; sql: string; values: readonly unknown[] };
function fake(...answers: (unknown[] | Error)[]) {
  const seen: Seen[] = [];
  const withActor = (async (token, fn) =>
    fn({
      async query(sql: string, values: readonly unknown[] = []) {
        seen.push({ token, sql, values });
        const next = answers.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next, rowCount: next.length };
      },
    } as unknown as ActorTransaction)) as WithActor;
  return { withActor, seen };
}

const course = (n: number, name: string, year: string, extra: Record<string, unknown> = {}) => ({
  course_id: id(n),
  course_name: name,
  academic_year: year,
  ai_policy: "encouraged",
  assignment_id: null,
  ...extra,
});
const assignment = (n: number, title: string, due: string) => ({
  assignment_id: id(n),
  title,
  work_type: "essay",
  opens_at: new Date("2026-10-01T08:00:00Z"),
  due_at: new Date(due),
  current_version: 1,
  enrolled_students: 0,
});

describe("coursesOf", () => {
  it("orders courses by year descending, then name in hr collation; assignments by due, then title", () => {
    const rows = [
      course(1, "Čitanje", "2026/2027"),
      course(2, "Cvijeće", "2026/2027"),
      course(3, "Arhiv", "2025/2026"),
      course(4, "Dvorana", "2026/2027", assignment(10, "Šuma", "2026-12-01T00:00:00Z")),
      course(4, "Dvorana", "2026/2027", assignment(11, "Sova", "2026-12-01T00:00:00Z")),
      course(4, "Dvorana", "2026/2027", assignment(12, "Zebra", "2026-11-01T00:00:00Z")),
    ];
    const courses = coursesOf(rows)!;
    // hr: C < Č < D, while code units put Č after Z.
    expect(courses.map((c) => c.name)).toEqual(["Cvijeće", "Čitanje", "Dvorana", "Arhiv"]);
    expect(courses[2]!.assignments.map((a) => a.title)).toEqual(["Zebra", "Sova", "Šuma"]);
    expect(courses[2]!.assignments[0]).toEqual({
      id: id(12),
      title: "Zebra",
      workType: "essay",
      opensAt: "2026-10-01T08:00:00.000Z",
      dueAt: "2026-11-01T00:00:00.000Z",
      currentVersion: 1,
      enrolledStudents: 0,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an upper-case course id", { course_id: id(1).toUpperCase() }],
    ["an empty name", { course_name: "" }],
    ["a year of the wrong form", { academic_year: "2026-2027" }],
    ["an unknown policy", { ai_policy: "allowed" }],
    ["an unknown work type", { ...assignment(9, "a", "2026-12-01T00:00:00Z"), work_type: "poem" }],
    ["version 0", { ...assignment(9, "a", "2026-12-01T00:00:00Z"), current_version: 0 }],
    ["a due time as text", { ...assignment(9, "a", "2026-12-01T00:00:00Z"), due_at: "2026" }],
  ])("refuses %s", (_name, change) => {
    expect(coursesOf([{ ...course(1, "Kolegij", "2026/2027"), ...change }])).toBeNull();
  });

  it("refuses a course whose rows disagree", () => {
    const rows = [course(1, "Kolegij", "2026/2027"), course(1, "Drugi", "2026/2027")];
    expect(coursesOf(rows)).toBeNull();
  });
});

describe("createTeacherCoursesReader", () => {
  it("names ZD401 and ZD403; anything else and a malformed row are unavailable", async () => {
    for (const [answer, status] of [
      [coded("ZD401"), { status: "unauthenticated" }],
      [coded("ZD403"), { status: "not_found" }],
      [coded("XX000"), { status: "unavailable", reason: "database_error" }],
      [[{ course_id: "x" }], { status: "unavailable", reason: "row_malformed" }],
      [[], { status: "ok", courses: [] }],
    ] as const) {
      const { withActor, seen } = fake(answer as unknown[] | Error);
      expect(await createTeacherCoursesReader(withActor)(TOKEN)).toEqual(status);
      expect(seen[0]!.sql).toContain("FROM institution.list_teacher_courses()");
      expect(seen[0]!.token).toBe(TOKEN);
    }
  });
});

const mentored = (n: number, extra: Record<string, unknown> = {}) => ({
  mentorship_id: id(n),
  assignment_id: id(n + 50),
  title: "Izmišljeni diplomski rad",
  work_type: "master_thesis",
  document_id: null,
  given_name: "Izmišljena",
  family_name: "Studentica",
  submitted: false,
  ...extra,
});

describe("mentored works", () => {
  it("derives the work state from the work and the submission", () => {
    expect(mentoredWorkOf(mentored(1))?.workState).toBe("not_started");
    expect(mentoredWorkOf(mentored(1, { document_id: "rad" }))?.workState).toBe("in_progress");
    expect(mentoredWorkOf(mentored(1, { document_id: "rad", submitted: true }))?.workState).toBe(
      "submitted",
    );
    expect(mentoredWorkOf(mentored(1, { submitted: true }))).toBeNull();
    expect(mentoredWorkOf(mentored(1, { submitted: null }))).toBeNull();
    expect(mentoredWorkOf(mentored(1, { given_name: null }))).toBeNull();
    expect(
      mentoredWorkOf(mentored(1, { given_name: null, family_name: null }))?.student,
    ).toBeNull();
    expect(mentoredWorkOf(mentored(1, { work_type: "essay" }))).toBeNull();
  });

  it("asks for the actor first; no actor is unauthenticated without the read", async () => {
    const { withActor, seen } = fake([{ user_id: null, institution_id: null }]);
    expect(await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN)).toEqual({
      status: "unauthenticated",
    });
    expect(seen.map((s) => s.sql)).toEqual([
      "SELECT user_id, institution_id FROM app.current_actor()",
    ]);
  });

  it("lists, and reads one by id; a repeated mentorship is unavailable", async () => {
    const actor = [{ user_id: id(90), institution_id: id(91) }];
    let { withActor, seen } = fake(actor, [mentored(1), mentored(2)]);
    const list = await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN);
    expect(list.status === "ok" && list.works.map((w) => w.mentorshipId)).toEqual([id(1), id(2)]);
    expect(seen[1]!.values).toEqual([null]);
    ({ withActor, seen } = fake(actor, [mentored(1)]));
    const one = await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, id(1));
    expect(one.status === "ok" && one.work.mentorshipId).toBe(id(1));
    expect(seen[1]!.values).toEqual([id(1)]);
    ({ withActor } = fake(actor, [mentored(1), mentored(1)]));
    expect((await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN)).status).toBe(
      "unavailable",
    );
  });

  it("a malformed, unknown or other id is the same not_found", async () => {
    const actor = [{ user_id: id(90), institution_id: id(91) }];
    let { withActor, seen } = fake();
    expect(await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, "x")).toEqual({
      status: "not_found",
    });
    expect(seen).toEqual([]);
    ({ withActor } = fake(actor, []));
    expect(await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, id(1))).toEqual({
      status: "not_found",
    });
    ({ withActor } = fake(actor, [mentored(2)]));
    expect((await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, id(1))).status).toBe(
      "unavailable",
    );
  });
});

const submitted = (student: number, extra: Record<string, unknown> = {}) => ({
  assignment_id: id(1),
  student_id: id(student),
  document_id: "rad",
  submitted: true,
  revision: "42",
  requested_minute: new Date("2026-12-15T21:30:00Z"),
  after_deadline: false,
  ...extra,
});
const open = (student: number) => ({
  assignment_id: id(1),
  student_id: id(student),
  document_id: null,
  submitted: false,
  revision: null,
  requested_minute: null,
  after_deadline: null,
});

describe("assignment submissions", () => {
  it("reads a submitted and an open row", () => {
    expect(submissionOf(submitted(2))).toEqual({
      studentId: id(2),
      documentId: "rad",
      submitted: true,
      revision: 42,
      requestedMinute: "2026-12-15T21:30:00.000Z",
      afterDeadline: false,
    });
    expect(submissionOf(open(3))?.submitted).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a revision past 16 digits", submitted(2, { revision: "12345678901234567" })],
    ["a revision as a number", submitted(2, { revision: 42 })],
    ["a time off the minute", submitted(2, { requested_minute: new Date("2026-12-15T21:30:01Z") })],
    ["no deadline flag", submitted(2, { after_deadline: null })],
    ["an open row with a revision", { ...open(3), revision: "1" }],
    ["a document id with a control character", submitted(2, { document_id: "a\u0007" })],
    ["a document id with a leading space", submitted(2, { document_id: " rad" })],
  ])("refuses %s", (_name, row) => {
    expect(submissionOf(row)).toBeNull();
  });

  it("asks once for the distinct lower-case UUIDs, and keeps an entry for each", async () => {
    const { withActor, seen } = fake([submitted(2), open(3)]);
    const read = await createAssignmentSubmissionsReader(withActor)(TOKEN, [
      id(1).toUpperCase(),
      "nije-uuid",
      id(1),
      id(4),
    ]);
    expect(seen.map((s) => s.values)).toEqual([[[id(1), id(4)]]]);
    expect(read.status === "ok" && [...read.submissions.keys()]).toEqual([id(1), id(4)]);
    expect(read.status === "ok" && read.submissions.get(id(1))!.map((s) => s.studentId)).toEqual([
      id(2),
      id(3),
    ]);
  });

  it("no valid id asks nothing; ZD401 is unauthenticated; a repeat or a stray row is unavailable", async () => {
    let { withActor, seen } = fake();
    expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, ["x"])).toEqual({
      status: "ok",
      submissions: new Map(),
    });
    expect(seen).toEqual([]);
    ({ withActor } = fake(coded("ZD401")));
    expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, [id(1)])).toEqual({
      status: "unauthenticated",
    });
    for (const rows of [[submitted(2), submitted(2)], [{ ...open(3), assignment_id: id(9) }]]) {
      ({ withActor } = fake(rows));
      expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, [id(1)])).toEqual({
        status: "unavailable",
        reason: "row_malformed",
      });
    }
  });
});
