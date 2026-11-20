// The teacher's reads (SRV-13) over a fake withActor: the statement, the
// mapping and order of the rows, and every refusal. All values are invented.
import { describe, expect, it } from "vitest";

import { createAssignmentSubmissionsReader, submissionOf } from "./assignment-submissions.ts";
import { createMentoredWorksReader, mentoredWorkOf } from "./mentored-works.ts";
import {
  createTeacherAccessReader,
  createTeacherCoursesReader,
  teacherCoursesOf,
} from "./teacher-reads.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const C1 = "2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e01";
const C2 = "2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e02";
const A1 = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const A2 = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02";
const USER = "6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e01";
const INSTITUTION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";

const fake =
  (answer: () => Record<string, unknown>[], seen: string[] = []): WithActor =>
  async (token, fn) =>
    fn({
      query: async (text: string) => {
        seen.push(`${String(token)}|${text}`);
        const rows = answer();
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

const assignment = (id: string, due: string, title: string) => ({
  assignmentId: id,
  title,
  workType: "seminar_paper",
  opensAt: new Date("2026-10-01T06:00:00Z"),
  dueAt: new Date(due),
  currentVersion: 1,
  enrolledStudents: 2,
});
const course = (id: string, name: string, year = "2026/2027") => ({
  courseId: id,
  courseName: name,
  academicYear: year,
  aiPolicy: "partially_allowed",
});

describe("teacherCoursesOf", () => {
  it("groups assignments by course in the statement's order", () => {
    const rows = [
      { ...course(C2, "Cestovni promet"), assignmentId: null },
      { ...course(C1, "Čitanje grada"), ...assignment(A1, "2026-12-14T22:59:00Z", "Prvi") },
      { ...course(C1, "Čitanje grada"), ...assignment(A2, "2027-01-31T22:59:00Z", "Drugi") },
    ];
    const list = teacherCoursesOf(rows);
    expect(list.map((c) => c.name)).toEqual(["Cestovni promet", "Čitanje grada"]);
    expect(list[1]!.assignments.map((a) => a.title)).toEqual(["Prvi", "Drugi"]);
    expect(list[1]!.assignments[0]).toEqual({
      id: A1,
      title: "Prvi",
      workType: "seminar_paper",
      opensAt: "2026-10-01T06:00:00.000Z",
      dueAt: "2026-12-14T22:59:00.000Z",
      currentVersion: 1,
      enrolledStudents: 2,
    });
    expect(list[0]!.assignments).toEqual([]);
  });

  it.each([
    ["an unknown policy", { ...course(C1, "X"), aiPolicy: "maybe", assignmentId: null }],
    ["an empty name", { ...course(C1, ""), assignmentId: null }],
    ["a bad year", { ...course(C1, "X", "2026"), assignmentId: null }],
    [
      "a bad work type",
      { ...course(C1, "X"), ...assignment(A1, "2027-01-01T00:00:00Z", "T"), workType: "poem" },
    ],
    [
      "a version 0",
      { ...course(C1, "X"), ...assignment(A1, "2027-01-01T00:00:00Z", "T"), currentVersion: 0 },
    ],
    [
      "a text date",
      { ...course(C1, "X"), ...assignment(A1, "2027-01-01T00:00:00Z", "T"), dueAt: "2027" },
    ],
  ])("throws on %s", (_name, row) => {
    expect(() => teacherCoursesOf([row])).toThrow("malformed");
  });

  it("throws when one course comes with two names", () => {
    expect(() =>
      teacherCoursesOf([
        { ...course(C1, "X"), assignmentId: null },
        { ...course(C1, "Y"), assignmentId: null },
      ]),
    ).toThrow("malformed");
  });
});

describe("createTeacherCoursesReader", () => {
  it("reads institution.list_teacher_courses() under the caller's token", async () => {
    const seen: string[] = [];
    const read = createTeacherCoursesReader(fake(() => [], seen));
    expect(await read(TOKEN)).toEqual({ ok: true, courses: [] });
    expect(seen).toHaveLength(1);
    // The order is the database's: year descending, then Croatian collation, then the id.
    expect(seen[0]).toContain(
      'ORDER BY academic_year DESC, course_name COLLATE "hr-x-icu", course_id,',
    );
    expect(seen[0]).toMatch(
      new RegExp(`^${TOKEN}\\|[\\s\\S]*institution\\.list_teacher_courses\\(\\)`),
    );
  });

  it("ZD401 is unauthenticated, ZD403 not_found, anything else is thrown", async () => {
    expect(await createTeacherCoursesReader(failing("ZD401"))(TOKEN)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(await createTeacherCoursesReader(failing("ZD403"))(TOKEN)).toEqual({
      ok: false,
      reason: "not_found",
    });
    await expect(createTeacherCoursesReader(failing("08006"))(TOKEN)).rejects.toThrow();
  });
});

describe("createTeacherAccessReader", () => {
  const row = (allowed: unknown, user: unknown = USER, institution: unknown = INSTITUTION) => [
    { userId: user, institutionId: institution, allowed },
  ];

  it("allowed and denied come with the principal; no actor is unauthenticated", async () => {
    expect(await createTeacherAccessReader(fake(() => row(true)))(TOKEN)).toEqual({
      ok: true,
      access: "allowed",
      userId: USER,
      institutionId: INSTITUTION,
    });
    expect(await createTeacherAccessReader(fake(() => row(false)))(TOKEN)).toMatchObject({
      ok: true,
      access: "denied",
    });
    expect(await createTeacherAccessReader(fake(() => row(false, null, null)))(TOKEN)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it.each([
    ["no row", () => []],
    ["a null role", () => row(null)],
    ["a user that is not a uuid", () => row(true, "x")],
  ])("throws on %s", async (_name, answer) => {
    await expect(createTeacherAccessReader(fake(answer))(TOKEN)).rejects.toThrow("malformed");
  });
});

const id = (n: number) => `3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c${String(n).padStart(2, "0")}`;
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

type Seen = { token: unknown; sql: string; values: readonly unknown[] };
function fakeReads(...answers: (unknown[] | Error)[]) {
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

  // Codex P2 on #349: evidence.document.id counts code points (isWorkId), so
  // 256 of them are one work id even when they take 512 UTF-16 units.
  it("counts a document id in code points, as evidence.document does", () => {
    const emoji = "\u{1F600}";
    for (const id of [emoji.repeat(129), emoji.repeat(256), "a".repeat(256)]) {
      expect(mentoredWorkOf(mentored(1, { document_id: id }))?.documentId).toBe(id);
    }
    for (const id of [emoji.repeat(257), "a".repeat(257), "", " rad", "a\u0085b"]) {
      expect(mentoredWorkOf(mentored(1, { document_id: id }))).toBeNull();
    }
  });

  it("asks for the actor first; no actor is unauthenticated without the read", async () => {
    const { withActor, seen } = fakeReads([{ user_id: null, institution_id: null }]);
    expect(await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN)).toEqual({
      status: "unauthenticated",
    });
    expect(seen.map((s) => s.sql)).toEqual([
      "SELECT user_id, institution_id FROM app.current_actor()",
    ]);
  });

  it("lists, and reads one by id; a repeated mentorship is unavailable", async () => {
    const actor = [{ user_id: id(90), institution_id: id(91) }];
    let { withActor, seen } = fakeReads(actor, [mentored(1), mentored(2)]);
    const list = await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN);
    expect(list.status === "ok" && list.works.map((w) => w.mentorshipId)).toEqual([id(1), id(2)]);
    expect(seen[1]!.values).toEqual([null]);
    ({ withActor, seen } = fakeReads(actor, [mentored(1)]));
    const one = await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, id(1));
    expect(one.status === "ok" && one.work.mentorshipId).toBe(id(1));
    expect(seen[1]!.values).toEqual([id(1)]);
    ({ withActor } = fakeReads(actor, [mentored(1), mentored(1)]));
    expect((await createMentoredWorksReader(withActor).readMentoredWorks(TOKEN)).status).toBe(
      "unavailable",
    );
  });

  it("a malformed, unknown or other id is the same not_found", async () => {
    const actor = [{ user_id: id(90), institution_id: id(91) }];
    let { withActor, seen } = fakeReads();
    expect(await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, "x")).toEqual({
      status: "not_found",
    });
    expect(seen).toEqual([]);
    ({ withActor } = fakeReads(actor, []));
    expect(await createMentoredWorksReader(withActor).readMentoredWork(TOKEN, id(1))).toEqual({
      status: "not_found",
    });
    ({ withActor } = fakeReads(actor, [mentored(2)]));
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
    const { withActor, seen } = fakeReads([submitted(2), open(3)]);
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
    let { withActor, seen } = fakeReads();
    expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, ["x"])).toEqual({
      status: "ok",
      submissions: new Map(),
    });
    expect(seen).toEqual([]);
    ({ withActor } = fakeReads(coded("ZD401")));
    expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, [id(1)])).toEqual({
      status: "unauthenticated",
    });
    for (const rows of [[submitted(2), submitted(2)], [{ ...open(3), assignment_id: id(9) }]]) {
      ({ withActor } = fakeReads(rows));
      expect(await createAssignmentSubmissionsReader(withActor)(TOKEN, [id(1)])).toEqual({
        status: "unavailable",
        reason: "row_malformed",
      });
    }
  });
});
