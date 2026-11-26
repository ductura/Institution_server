// F4-STU-R02: the port of student.assignments.get over a fake withActor. It
// reads whether each assignment is a practice one, and a row without that
// answer (or with one that is not a boolean) makes the whole read unavailable,
// never a partial list. All values are invented.
import { describe, expect, it } from "vitest";

import { createStudentAssignmentsReader } from "./student-assignments.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "A".repeat(43);

function fake(answer: () => Promise<Record<string, unknown>[]>) {
  const seen: string[] = [];
  const withActor = (async (_token: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: await answer() };
      },
    })) as unknown as WithActor;
  return { read: createStudentAssignmentsReader(withActor), seen };
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  courseId: "0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e01",
  courseName: "Izmišljeni kolegij",
  academicYear: "2026/2027",
  title: "Izmišljeni zadatak",
  workType: "essay",
  dueAt: new Date("2026-12-01T22:59:00.000Z"),
  extendedDueAt: null,
  acknowledged: true,
  isPractice: false,
  ...over,
});

describe("createStudentAssignmentsReader", () => {
  it("reads whether each assignment is a practice one", async () => {
    const { read, seen } = fake(async () => [
      row(),
      row({ assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02", isPractice: true }),
    ]);
    const got = await read(TOKEN);
    expect(seen[0]).toContain('is_practice AS "isPractice"');
    expect(got.status).toBe("ok");
    if (got.status !== "ok") return;
    expect(got.rows.map((r) => [r.assignmentId.slice(-2), r.isPractice])).toEqual([
      ["01", false],
      ["02", true],
    ]);
    expect(got.rows[0]).toEqual({
      assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
      courseId: "0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e01",
      courseName: "Izmišljeni kolegij",
      academicYear: "2026/2027",
      title: "Izmišljeni zadatak",
      workType: "essay",
      dueAt: "2026-12-01T22:59:00.000Z",
      extendedDueAt: null,
      acknowledged: true,
      isPractice: false,
    });
  });

  it.each([
    ["missing", { isPractice: undefined }],
    ["null", { isPractice: null }],
    ["text", { isPractice: "true" }],
  ])("is unavailable when the practice answer is %s", async (_name, over) => {
    const { read } = fake(async () => [row(), row(over)]);
    expect(await read(TOKEN)).toEqual({ status: "unavailable" });
  });

  it("is unauthenticated on ZD401 and unavailable on another error", async () => {
    const reject = (code: string) => () => Promise.reject(Object.assign(new Error("x"), { code }));
    expect(await fake(reject("ZD401")).read(TOKEN)).toEqual({ status: "unauthenticated" });
    expect(await fake(reject("XX000")).read(TOKEN)).toEqual({ status: "unavailable" });
  });
});
