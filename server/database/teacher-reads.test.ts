// The teacher's reads (SRV-13) over a fake withActor: the statement, the
// mapping and order of the rows, and every refusal. All values are invented.
import { describe, expect, it } from "vitest";

import {
  createTeacherAccessReader,
  createTeacherCoursesReader,
  teacherCoursesOf,
} from "./teacher-reads.ts";
import type { WithActor } from "./with-actor.ts";

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
