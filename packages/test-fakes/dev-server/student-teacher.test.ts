import { describe, expect, it } from "vitest";

import { CODES, createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

describe("dev fake server: student routes", () => {
  it("lists the student's course with the acknowledged assignment", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const list = await send(state, "/api/v1/student/assignments", { headers });
    expect(contractProblems("student.assignments.get", list)).toEqual([]);
    expect(list.json).toMatchObject({
      courses: [{ id: IDS.course, assignments: [{ id: IDS.assignment, noticeFirst: false }] }],
    });
    const work = await send(state, "/api/v1/student/assignment-work", { headers });
    expect(contractProblems("student.assignment-work.get", work)).toEqual([]);
    expect(work.json).toEqual({
      assignments: [{ assignmentId: IDS.assignment, workState: "in_progress" }],
    });
  });

  it("a student without a course gets empty lists, then the notice first after enrolling", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    expect((await send(state, "/api/v1/student/assignments", { headers })).json).toEqual({
      courses: [],
    });
    await send(state, "/api/v1/institution/enrollments", { body: { code: CODES.valid }, headers });
    const list = await send(state, "/api/v1/student/assignments", { headers });
    expect(list.json).toMatchObject({ courses: [{ assignments: [{ noticeFirst: true }] }] });
    const work = await send(state, "/api/v1/student/assignment-work", { headers });
    expect(work.json).toMatchObject({ assignments: [{ workState: "not_started" }] });
  });

  it("shows who opened the student's own work, and nobody else's", async () => {
    const state = createState();
    const url = `/api/v1/student/works/${IDS.document}/access-log`;
    const own = await send(state, url, { headers: await signIn(state, "student") });
    expect(contractProblems("student.access-log.get", own)).toEqual([]);
    expect(own.json).toMatchObject({
      entries: [{ reader: { givenName: "Petar" }, surface: "fast_path" }],
    });
    const other = await send(state, url, { headers: await signIn(state, "student-2") });
    expect(other.status).toBe(404);
  });
});

describe("dev fake server: teacher routes", () => {
  it("lists the teacher's courses and the access", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    const courses = await send(state, "/api/v1/teacher/courses", { headers });
    expect(contractProblems("teacher.courses.get", courses)).toEqual([]);
    expect(courses.json).toMatchObject({ courses: [{}, {}] });
    const access = await send(state, "/api/v1/teacher/access", { headers });
    expect(contractProblems("teacher.access.get", access)).toEqual([]);
    expect(access.json).toMatchObject({ access: "allowed" });
    const denied = await send(state, "/api/v1/teacher/access", {
      headers: await signIn(state, "bez-uloge"),
    });
    expect(denied.json).toMatchObject({ access: "denied" });
    const student = await send(state, "/api/v1/teacher/courses", {
      headers: await signIn(state, "student"),
    });
    expect(student.status).toBe(403);
  });

  it("reads submissions only of an assignment the caller teaches", async () => {
    const state = createState();
    const url = `/api/v1/teacher/assignments/${IDS.assignment}/submissions`;
    const own = await send(state, url, { headers: await signIn(state, "nastavnik") });
    expect(contractProblems("teacher.submissions.get", own)).toEqual([]);
    expect(own.json).toEqual({
      submissions: [
        {
          studentId: IDS.student,
          documentId: IDS.document,
          submitted: false,
          revision: null,
          requestedMinute: null,
          afterDeadline: null,
        },
      ],
    });
    const many = await send(state, "/api/v1/teacher/assignment-submissions", {
      body: { assignmentIds: [IDS.assignment.toUpperCase(), IDS.assignment] },
      headers: await signIn(state, "nastavnik"),
    });
    expect(contractProblems("teacher.assignment-submissions.post", many)).toEqual([]);
    expect(many.json).toMatchObject({ assignments: [{ assignmentId: IDS.assignment }] });
    const other = await send(state, url, { headers: await signIn(state, "administrator") });
    expect(other.json).toEqual({ submissions: [] });
  });

  it("the fast path shows the work and records the opening", async () => {
    const state = createState();
    const answer = await send(state, "/api/v1/teacher/fast-path", {
      body: { assignmentId: IDS.assignment },
      headers: await signIn(state, "nastavnik"),
    });
    expect(contractProblems("teacher.fast-path.post", answer)).toEqual([]);
    expect(answer.json).toMatchObject({ students: [{ surname: "Đaković", work: "writing" }] });
    expect(state.accessLog).toHaveLength(2);
  });

  it("reads the mentor's thesis and 404 for anyone else", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    const list = await send(state, "/api/v1/teacher/mentorships", { headers });
    expect(contractProblems("teacher.mentorships.get", list)).toEqual([]);
    const one = await send(state, `/api/v1/teacher/mentorships/${IDS.mentorship}`, { headers });
    expect(contractProblems("teacher.mentorship.get", one)).toEqual([]);
    const other = await send(state, `/api/v1/teacher/mentorships/${IDS.mentorship}`, {
      headers: await signIn(state, "nastavnik-2"),
    });
    expect(other.status).toBe(404);
  });
});

describe("dev fake server: settings and support", () => {
  it("keeps a personal setting and refuses another's course", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const put = await send(state, "/api/v1/settings/values", {
      method: "PUT",
      body: {
        level: "personal",
        course: null,
        key: "notifications.email",
        value: false,
        locked: false,
        min: null,
        max: null,
      },
      headers,
    });
    expect(contractProblems("settings.values.put", put)).toEqual([]);
    expect(put.json).toMatchObject({ changed: true });
    const read = await send(state, "/api/v1/settings/values", {
      query: "?level=personal",
      headers,
    });
    expect(contractProblems("settings.values.get", read)).toEqual([]);
    expect(read.json).toMatchObject({ values: [{ key: "notifications.email", value: false }] });
    const course = await send(state, "/api/v1/settings/values", {
      query: `?level=course&course=${IDS.course}`,
      headers,
    });
    expect(course.status).toBe(404);
    const catalogue = await send(state, "/api/v1/settings/catalogue", { headers });
    expect(contractProblems("settings.catalogue.get", catalogue)).toEqual([]);
  });

  it("takes five problem reports, then too_many_reports", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const body = {
      appVersion: "1.4.0",
      browser: { family: "firefox", major: 140 },
      category: "technical",
      description: "Izmišljeni opis problema.",
      route: null,
      syncState: null,
    };
    const first = await send(state, "/api/v1/support/problem-report", { body, headers });
    expect(contractProblems("support.problem-report.post", first)).toEqual([]);
    for (let i = 0; i < 4; i++)
      await send(state, "/api/v1/support/problem-report", { body, headers });
    const over = await send(state, "/api/v1/support/problem-report", { body, headers });
    expect(over.status).toBe(429);
  });
});

describe("dev fake server: review findings on #363", () => {
  it("records openings on the five-minute grid, once per window", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    for (let i = 0; i < 2; i++)
      await send(state, "/api/v1/teacher/fast-path", {
        body: { assignmentId: IDS.assignment },
        headers,
      });
    expect(state.accessLog).toHaveLength(2);
    expect(state.accessLog[1]?.at).toMatch(/:[0-5][05]:00\.000Z$/u);
    const log = await send(state, `/api/v1/student/works/${IDS.document}/access-log`, {
      headers: await signIn(state, "student"),
    });
    expect(contractProblems("student.access-log.get", log)).toEqual([]);
  });

  it("a group teacher sees only the students of their own groups", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik-2");
    const fast = await send(state, "/api/v1/teacher/fast-path", {
      body: { assignmentId: IDS.assignment },
      headers,
    });
    expect(fast.json).toEqual({ kind: "ok", students: [] });
    const list = await send(state, `/api/v1/teacher/assignments/${IDS.assignment}/submissions`, {
      headers,
    });
    expect(list.json).toEqual({ submissions: [] });
    expect(state.accessLog).toHaveLength(1);
  });

  it("refuses a bound at the personal level and a range the key cannot hold", async () => {
    const state = createState();
    const put = (body: Record<string, unknown>, headers: Record<string, string>) =>
      send(state, "/api/v1/settings/values", { method: "PUT", body, headers });
    const personal = await put(
      {
        level: "personal",
        course: null,
        key: "notifications.email",
        value: false,
        locked: true,
        min: null,
        max: null,
      },
      await signIn(state, "student"),
    );
    expect(personal.status).toBe(422);
    const admin = await signIn(state, "administrator");
    const base = {
      level: "institution",
      course: null,
      key: "thresholds.session_gap_minutes",
      locked: false,
    };
    for (const range of [
      { value: 30, min: 100, max: 20 },
      { value: 30, min: 0, max: null },
      { value: 30, min: 40, max: null },
    ])
      expect((await put({ ...base, ...range }, admin)).status, JSON.stringify(range)).toBe(422);
    const ok = await put({ ...base, value: 30, min: 10, max: 60 }, admin);
    expect(contractProblems("settings.values.put", ok)).toEqual([]);
  });
});
