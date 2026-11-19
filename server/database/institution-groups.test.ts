// The seminar group port (SRV-15) over a fake withActor: the statements and
// their parameters, every refusal by SQLSTATE and a row of the wrong form as
// unavailable. The port never throws. All values are invented.
import { describe, expect, it } from "vitest";

import { createInstitutionGroups } from "./institution-groups.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-nositelja-0000000000000001";
const COURSE = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const GROUP = "9a3c4d5e-6f70-4b82-8c93-d4e5f6071803";
const TEACHER = "8f2b3c4d-5e6f-4a71-9b82-c3d4e5f60703";

const seen: { token: unknown; text: string; values: readonly unknown[] }[] = [];
const answering =
  (rows: unknown[]): WithActor =>
  async (token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ token, text, values });
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

describe("createGroup", () => {
  it("calls create_seminar_group with the course and name; the id in lower case", async () => {
    seen.length = 0;
    const port = createInstitutionGroups(answering([{ id: GROUP.toUpperCase() }]));
    expect(await port.createGroup(TOKEN, COURSE, "Grupa C")).toEqual({
      status: "created",
      id: GROUP,
    });
    expect(seen).toEqual([
      {
        token: TOKEN,
        text: expect.stringContaining("create_seminar_group("),
        values: [COURSE, "Grupa C"],
      },
    ]);
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD422", { status: "invalid" }],
    ["08006", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, outcome) => {
    expect(await createInstitutionGroups(failing(code)).createGroup(TOKEN, COURSE, "A")).toEqual(
      outcome,
    );
  });
});

describe("assignGroupTeacher", () => {
  it("answers whether the teacher is new to the group, read before the call writes", async () => {
    seen.length = 0;
    const port = createInstitutionGroups(answering([{ assigned: false }]));
    expect(await port.assignGroupTeacher(TOKEN, GROUP, TEACHER)).toEqual({
      status: "assigned",
      assigned: false,
    });
    // The course's group lock first, then the read in a later snapshot and the call.
    expect(seen.map((q) => q.values)).toEqual([
      [GROUP, TEACHER],
      [GROUP, TEACHER],
    ]);
    expect(seen[0]!.text).toMatch(
      /pg_advisory_xact_lock\([\s\S]*'institution\.seminar_group:' \|\| g\.course_id::text/,
    );
    expect(seen[1]!.text).toMatch(
      /WITH earlier AS[\s\S]*assign_group_teacher\(\$1::uuid, \$2::uuid\)/,
    );
  });

  it("ZD422 (a teacher who is not confirmed) is invalid; a row of another form is unavailable", async () => {
    expect(
      await createInstitutionGroups(failing("ZD422")).assignGroupTeacher(TOKEN, GROUP, TEACHER),
    ).toEqual({ status: "invalid" });
    expect(
      await createInstitutionGroups(answering([{ assigned: "yes" }])).assignGroupTeacher(
        TOKEN,
        GROUP,
        TEACHER,
      ),
    ).toEqual({ status: "unavailable", reason: "assign_teacher_malformed" });
  });
});
