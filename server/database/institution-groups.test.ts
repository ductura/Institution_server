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
  it("answers the RPC's own word on whether it opened a place, in one statement", async () => {
    seen.length = 0;
    const port = createInstitutionGroups(answering([{ assigned: false }]));
    expect(await port.assignGroupTeacher(TOKEN, GROUP, TEACHER)).toEqual({
      status: "assigned",
      assigned: false,
    });
    // assign_group_teacher decides under the course's group lock (20261119170000);
    // an administrator reads no group table, so no read of the port's own.
    expect(seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT institution.assign_group_teacher($1::uuid, $2::uuid) AS assigned",
        values: [GROUP, TEACHER],
      },
    ]);
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

describe("readCourseGroups", () => {
  const TEACHER_ROW = { id: TEACHER, given_name: "Izmišljena", family_name: "Suradnica" };
  const ROW = { id: GROUP, name: "Grupa A", students: 2, teachers: [TEACHER_ROW] };

  it("reads course_groups for the course in the contract's order; names become camelCase", async () => {
    seen.length = 0;
    const port = createInstitutionGroups(answering([ROW]));
    expect(await port.readCourseGroups(TOKEN, COURSE)).toEqual({
      status: "read",
      groups: [
        {
          id: GROUP,
          name: "Grupa A",
          students: 2,
          teachers: [{ id: TEACHER, givenName: "Izmišljena", familyName: "Suradnica" }],
        },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.values).toEqual([COURSE]);
    expect(seen[0]!.text).toMatch(/FROM institution\.course_groups\(\$1::uuid\) g/);
    expect(seen[0]!.text).toMatch(/ORDER BY g\.name COLLATE "hr-x-icu", g\.group_id$/);
    expect(seen[0]!.text).toMatch(
      /\(t ->> 'family_name'\) COLLATE "hr-x-icu",\s+\(t ->> 'given_name'\) COLLATE "hr-x-icu", t ->> 'id'/,
    );
  });

  it("no group is an empty list", async () => {
    expect(await createInstitutionGroups(answering([])).readCourseGroups(TOKEN, COURSE)).toEqual({
      status: "read",
      groups: [],
    });
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD422", { status: "unavailable", reason: "database_error" }],
    ["08006", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, outcome) => {
    expect(await createInstitutionGroups(failing(code)).readCourseGroups(TOKEN, COURSE)).toEqual(
      outcome,
    );
  });

  it.each([
    ["a teacher without a name", { ...ROW, teachers: [{ ...TEACHER_ROW, given_name: null }] }],
    [
      "a teacher with an empty family name",
      { ...ROW, teachers: [{ ...TEACHER_ROW, family_name: "" }] },
    ],
    [
      "a teacher id in upper case",
      { ...ROW, teachers: [{ ...TEACHER_ROW, id: TEACHER.toUpperCase() }] },
    ],
    ["teachers that are not a list", { ...ROW, teachers: {} }],
    ["a negative count", { ...ROW, students: -1 }],
    ["a count that is not an integer", { ...ROW, students: "2" }],
    ["an empty name", { ...ROW, name: "" }],
    ["a group id that is not a UUID", { ...ROW, id: "grupa-a" }],
    ["a row that is not an object", null],
  ])("one row of another form (%s) makes the whole answer unavailable", async (_what, bad) => {
    expect(
      await createInstitutionGroups(answering([ROW, bad])).readCourseGroups(TOKEN, COURSE),
    ).toEqual({ status: "unavailable", reason: "course_groups_malformed" });
  });
});
