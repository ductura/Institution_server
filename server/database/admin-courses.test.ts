// The administrator's course port (SRV-12) over a fake withActor: the
// statement and parameters, every refusal by SQLSTATE and a row of the wrong
// form as unavailable. The port never throws. All values are invented.
import { describe, expect, it } from "vitest";

import { createAdminCourses } from "./admin-courses.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-admina-0000000000000000001";
const ID = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const HOLDER = "8f2b3c4d-5e6f-4a71-9b82-c3d4e5f60702";
const COURSE = {
  name: "Izmišljeni seminar",
  academicYear: "2026/2027",
  aiPolicy: "encouraged",
  holderId: HOLDER,
  groups: [] as string[],
};

const seen: { text: string; values: readonly unknown[] }[] = [];
const answering =
  (rows: unknown[]): WithActor =>
  async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ text, values });
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

describe("createAdminCourses", () => {
  it("calls admin_create_course(name, year, policy, holder); the id in lower case", async () => {
    seen.length = 0;
    const port = createAdminCourses(answering([{ id: ID.toUpperCase() }]));
    expect(await port.createCourse(TOKEN, COURSE)).toEqual({
      status: "created",
      id: ID,
      groups: [],
    });
    expect(seen).toEqual([
      {
        text: expect.stringContaining("institution.admin_create_course("),
        values: ["Izmišljeni seminar", "2026/2027", "encouraged", HOLDER],
      },
    ]);
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD409", { status: "conflict" }],
    ["ZD422", { status: "invalid" }],
    ["08006", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, outcome) => {
    expect(await createAdminCourses(failing(code)).createCourse(TOKEN, COURSE)).toEqual(outcome);
  });

  it("a row of another form is unavailable", async () => {
    expect(await createAdminCourses(answering([{ id: 7 }])).createCourse(TOKEN, COURSE)).toEqual({
      status: "unavailable",
      reason: "admin_course_malformed",
    });
  });
});

// F4 wave 2 #9 (1.9): the course's first groups in the course's transaction.
describe("createAdminCourses with groups", () => {
  const G1 = "9a3c4d5e-6f70-4b82-8c93-d4e5f6071803";
  const G2 = "9a3c4d5e-6f70-4b82-8c93-d4e5f6071804";
  const WITH_GROUPS = { ...COURSE, groups: ["Grupa A", "Grupa B"] };
  /** One answer per statement, in order; a thrown answer is a refusal of that statement. */
  const scripted = (answers: (unknown[] | Error)[]) => {
    const texts: { text: string; values: readonly unknown[] }[] = [];
    let rolledBack = false;
    const withActor: WithActor = async (_token, fn) => {
      try {
        return await fn({
          query: async (text: string, values: readonly unknown[] = []) => {
            texts.push({ text, values });
            const answer = answers[texts.length - 1] ?? [];
            if (answer instanceof Error) throw answer;
            return { rows: answer as never[], rowCount: answer.length };
          },
        });
      } catch (thrown) {
        rolledBack = true;
        throw thrown;
      }
    };
    return { withActor, texts, rolledBack: () => rolledBack };
  };

  it("creates the course, reads its groups and makes each, in the request's order", async () => {
    const db = scripted([[{ id: ID }], [], [{ id: G1.toUpperCase() }], [{ id: G2 }]]);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, WITH_GROUPS)).toEqual({
      status: "created",
      id: ID,
      groups: [
        { id: G1, name: "Grupa A" },
        { id: G2, name: "Grupa B" },
      ],
    });
    expect(db.texts).toEqual([
      {
        text: expect.stringContaining("institution.admin_create_course("),
        values: expect.any(Array),
      },
      { text: "SELECT group_id, name FROM institution.course_groups($1::uuid)", values: [ID] },
      {
        text: "SELECT institution.create_seminar_group($1::uuid, $2::text) AS id",
        values: [ID, "Grupa A"],
      },
      {
        text: "SELECT institution.create_seminar_group($1::uuid, $2::text) AS id",
        values: [ID, "Grupa B"],
      },
    ]);
    expect(db.rolledBack()).toBe(false);
  });

  it("a replay with the same groups answers their ids", async () => {
    const existing = [
      { group_id: G2, name: "Grupa B" },
      { group_id: G1, name: "Grupa A" },
    ];
    const db = scripted([[{ id: ID }], existing, [{ id: G1 }], [{ id: G2 }]]);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, WITH_GROUPS)).toMatchObject({
      status: "created",
      groups: [{ id: G1 }, { id: G2 }],
    });
  });

  it.each([
    ["fewer groups", [{ group_id: G1, name: "Grupa A" }]],
    [
      "other groups",
      [
        { group_id: G1, name: "Grupa A" },
        { group_id: G2, name: "Grupa C" },
      ],
    ],
  ])("a course that already has %s is conflict and rolls back", async (_name, existing) => {
    const db = scripted([[{ id: ID }], existing]);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, WITH_GROUPS)).toEqual({
      status: "conflict",
    });
    expect(db.texts).toHaveLength(2);
    expect(db.rolledBack()).toBe(true);
  });

  it("a name the database refuses (ZD422) is invalid and rolls the course back", async () => {
    const db = scripted([[{ id: ID }], [], Object.assign(new Error("refused"), { code: "ZD422" })]);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, WITH_GROUPS)).toEqual({
      status: "invalid",
    });
    expect(db.rolledBack()).toBe(true);
  });

  it.each([
    ["a group id of another form", [[{ id: ID }], [], [{ id: "x" }]]],
    ["an existing group without a name", [[{ id: ID }], [{ group_id: G1 }]]],
  ])("%s is unavailable and rolls back", async (_name, answers) => {
    const db = scripted(answers);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, WITH_GROUPS)).toEqual({
      status: "unavailable",
      reason: "admin_course_malformed",
    });
    expect(db.rolledBack()).toBe(true);
  });

  it("no groups is the one statement of before", async () => {
    const db = scripted([[{ id: ID }]]);
    expect(await createAdminCourses(db.withActor).createCourse(TOKEN, COURSE)).toEqual({
      status: "created",
      id: ID,
      groups: [],
    });
    expect(db.texts).toHaveLength(1);
  });
});
