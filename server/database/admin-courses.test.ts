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
    expect(await port.createCourse(TOKEN, COURSE)).toEqual({ status: "created", id: ID });
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
