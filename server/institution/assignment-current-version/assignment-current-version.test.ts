import { describe, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";

import { readAssignmentCurrentVersion } from "./index.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "A".repeat(43);
const CURRENT = {
  assignmentId: ID,
  courseId: "00000000-0000-4000-8000-0000000000c1",
  versionNo: 2,
  opensAt: new Date("2026-10-01T06:00:00Z"),
  dueAt: new Date("2027-01-31T22:59:00Z"),
};

function actorReturning(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({ query });
  };
  return { query, withActor };
}

describe("readAssignmentCurrentVersion", () => {
  it("uses one actor query for the assignment pointer and serializes the timestamps", async () => {
    const { query, withActor } = actorReturning([CURRENT]);
    expect(await readAssignmentCurrentVersion(withActor, TOKEN, ID)).toEqual({
      kind: "found",
      body: {
        ...CURRENT,
        opensAt: "2026-10-01T06:00:00.000Z",
        dueAt: "2027-01-31T22:59:00.000Z",
      },
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [ID]);
  });

  it.each([
    { rows: [], expected: "unauthorized" },
    { rows: [{ assignmentId: null }], expected: "not_found" },
  ])("reports $expected", async ({ rows, expected }) => {
    const { withActor } = actorReturning(rows);
    expect(await readAssignmentCurrentVersion(withActor, TOKEN, ID)).toEqual({ kind: expected });
  });

  it.each([
    { name: "two rows", rows: [CURRENT, CURRENT] },
    { name: "another assignment", rows: [{ ...CURRENT, assignmentId: "other" }] },
    { name: "missing version", rows: [{ ...CURRENT, opensAt: null, dueAt: null }] },
    { name: "invalid instant", rows: [{ ...CURRENT, dueAt: new Date(NaN) }] },
  ])("refuses $name", async ({ rows }) => {
    const { withActor } = actorReturning(rows);
    await expect(readAssignmentCurrentVersion(withActor, TOKEN, ID)).rejects.toThrow();
  });
});
