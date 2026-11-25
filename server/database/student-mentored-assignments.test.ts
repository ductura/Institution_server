// INT-31 (Ductus#2055): the port of student.mentored-assignments.get over a
// fake withActor. A row the function would not return makes the whole read
// unavailable; ZD401 is unauthenticated. All values are invented.
import { describe, expect, it } from "vitest";

import { createStudentMentoredAssignmentsReader } from "./student-assignments.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "A".repeat(43);

function fake(answer: () => Promise<Record<string, unknown>[]>) {
  const seen: { token: unknown; sql: string }[] = [];
  const withActor = (async (token: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        seen.push({ token, sql });
        return { rows: await answer() };
      },
    })) as unknown as WithActor;
  return { read: createStudentMentoredAssignmentsReader(withActor), seen };
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assignmentId: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  mentorshipId: "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  title: "Izmišljeni završni rad",
  workType: "bachelor_thesis",
  dueAt: new Date("2027-05-01T12:00:00.000Z"),
  extendedDueAt: null,
  acknowledged: false,
  mentorId: "4c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  mentorGivenName: "Izmišljena",
  mentorFamilyName: "Mentorica",
  ...over,
});

describe("createStudentMentoredAssignmentsReader", () => {
  it("reads the mentored assignments of the session, in the function's order", async () => {
    const { read, seen } = fake(async () => [
      row(),
      row({
        assignmentId: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02",
        workType: "master_thesis",
        extendedDueAt: new Date("2027-06-01T12:00:00.000Z"),
        acknowledged: true,
        mentorGivenName: null,
        mentorFamilyName: null,
      }),
    ]);
    const got = await read(TOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.sql).toContain("institution.student_mentored_assignments()");
    expect(got).toEqual({
      status: "ok",
      rows: [
        {
          assignmentId: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
          mentorshipId: "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
          title: "Izmišljeni završni rad",
          workType: "bachelor_thesis",
          dueAt: "2027-05-01T12:00:00.000Z",
          extendedDueAt: null,
          acknowledged: false,
          mentor: {
            id: "4c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
            givenName: "Izmišljena",
            familyName: "Mentorica",
          },
        },
        expect.objectContaining({
          workType: "master_thesis",
          extendedDueAt: "2027-06-01T12:00:00.000Z",
          acknowledged: true,
          mentor: null,
        }),
      ],
    });
  });

  it("answers ok with no rows", async () => {
    expect(await fake(async () => []).read(TOKEN)).toEqual({ status: "ok", rows: [] });
  });

  it("is unauthenticated on ZD401 and unavailable on any other error", async () => {
    const zd401 = Object.assign(new Error("not authenticated"), { code: "ZD401" });
    expect(await fake(() => Promise.reject(zd401)).read(TOKEN)).toEqual({
      status: "unauthenticated",
    });
    expect(await fake(() => Promise.reject(new Error("izmišljeni kvar"))).read(TOKEN)).toEqual({
      status: "unavailable",
    });
  });

  it.each([
    ["an assignment id that is no uuid", { assignmentId: "zm1" }],
    ["a mentorship id that is no uuid", { mentorshipId: null }],
    ["a mentor id that is no uuid", { mentorId: "" }],
    ["an empty title", { title: "" }],
    ["no due time", { dueAt: null }],
    ["an extended due time that is no instant", { extendedDueAt: "sutra" }],
    ["an acknowledgment that is no boolean", { acknowledged: "true" }],
    ["half a mentor name", { mentorFamilyName: null }],
  ])("refuses the whole read for %s", async (_, over) => {
    expect(await fake(async () => [row(), row(over)]).read(TOKEN)).toEqual({
      status: "unavailable",
    });
  });
});
