import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

// SRV-03 on the dev fake server: the administrator's course, the groups of a
// course and a teacher's new assignment. All values are invented.
const COURSE = {
  name: "Izmišljeni kolegij administratorice",
  academicYear: "2026/2027",
  aiPolicy: "prohibited",
  holderId: IDS.teacher2,
  groups: ["Grupa A"],
};
const CONTENT = {
  title: "Izmišljeni naslov",
  instructions: "Izmišljene upute.",
  workType: "essay",
  opensAt: "2026-10-01T06:00:00Z",
  dueAt: "2027-01-31T22:59:00Z",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: null,
  wordMax: 2500,
};

describe("dev fake server: course setup", () => {
  it("the administrator creates a course with its holder and groups; a teacher may not", async () => {
    const state = createState();
    const url = "/api/v1/institution/admin/courses";
    const admin = await signIn(state, "administrator");
    const made = await send(state, url, { body: COURSE, headers: admin });
    expect(contractProblems("institution.admin-courses.post", made)).toEqual([]);
    expect(await send(state, url, { body: COURSE, headers: admin })).toMatchObject({
      json: made.json,
    });
    const other = await send(state, url, {
      body: { ...COURSE, aiPolicy: "encouraged" },
      headers: admin,
    });
    expect(other.status).toBe(409);
    const teacher = await signIn(state, "nastavnik");
    expect((await send(state, url, { body: COURSE, headers: teacher })).status).toBe(403);
  });

  it("the holder adds a group and a teacher; the list names the teachers, not the students", async () => {
    const state = createState();
    const holder = await signIn(state, "nastavnik");
    const groups = `/api/v1/institution/courses/${IDS.course}/groups`;
    const added = await send(state, groups, { body: { name: "Grupa C" }, headers: holder });
    const id = (added.json as { id: string }).id;
    expect(await send(state, groups, { body: { name: "Grupa C" }, headers: holder })).toMatchObject(
      {
        json: { id },
      },
    );
    const teachers = `/api/v1/institution/groups/${id}/teachers`;
    const body = { teacherId: IDS.teacher2 };
    expect((await send(state, teachers, { body, headers: holder })).json).toEqual({
      assigned: true,
    });
    expect((await send(state, teachers, { body, headers: holder })).json).toEqual({
      assigned: false,
    });
    const list = await send(state, groups, { headers: holder });
    expect(contractProblems("institution.course-groups.get", list)).toEqual([]);
    expect(list.json).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ id, teachers: [expect.objectContaining({ id: IDS.teacher2 })] }),
      ]),
    });
    const student = await signIn(state, "student");
    expect((await send(state, groups, { headers: student })).status).toBe(403);
  });

  it("a teacher creates an assignment once per requestKey; other content under the key is 409", async () => {
    const state = createState();
    const url = `/api/v1/institution/courses/${IDS.course}/assignments`;
    const teacher = await signIn(state, "nastavnik");
    const headers = teacher;
    const body = { requestKey: "b15e6f70-8192-4da4-8eb5-f60718293a05", ...CONTENT };
    const made = await send(state, url, { body, headers });
    expect(contractProblems("institution.course-assignments.post", made)).toEqual([]);
    expect((await send(state, url, { body, headers })).json).toEqual(made.json);
    expect((await send(state, url, { body: { ...body, title: "Drugi" }, headers })).status).toBe(
      409,
    );
    const wider = {
      ...body,
      requestKey: "b15e6f70-8192-4da4-8eb5-f60718293a06",
      aiPolicy: "encouraged",
    };
    expect((await send(state, url, { body: wider, headers: teacher })).status).toBe(422);
  });
});
