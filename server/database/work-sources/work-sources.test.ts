// The work source port over a fake withActor: the full record check before
// the database, DOI and ISBN in their one spelling, the RPC and its
// parameters, the confirmed row inside the transaction and the refusals as
// outcomes. Every value is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";
import { createWorkSources, isWorkSourceDoi, isWorkSourceIsbn } from "./work-sources.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const ASSIGNMENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const STUDENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = new Date("2026-11-20T10:00:00.000Z");
const RECORD = {
  id: SOURCE,
  type: "book",
  authors: [{ kind: "person", family: "Izmišljenić", given: "Mara" }],
  year: 2024,
  title: "Kućno kompostiranje",
  place: "Zagreb",
  publisher: "Izmišljena naklada",
};
const ROW = {
  id: SOURCE,
  record: RECORD,
  doi: null,
  isbn: "9789530000001",
  undated: false,
  requirement: null,
  createdAt: AT,
  updatedAt: AT,
};
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

/** Each transaction answers its statements from `answers` in order; a throw rolls back. */
function fake(...answers: (unknown[] | Error)[]) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  let rolledBack = 0;
  const withActor = (async (_token, fn) => {
    try {
      return await fn({
        async query(sql: string, values: readonly unknown[] = []) {
          seen.push({ sql, values });
          const next = answers.shift() ?? [];
          if (next instanceof Error) throw next;
          return { rows: next, rowCount: next.length };
        },
      } as unknown as ActorTransaction);
    } catch (error) {
      rolledBack += 1;
      throw error;
    }
  }) as WithActor;
  return { port: createWorkSources(withActor), seen, rolledBack: () => rolledBack };
}

describe("DOI and ISBN spelling", () => {
  it.each([
    ["10.1000/izmisljeno.2024", true],
    ["10.1000/Izmisljeno", false],
    ["doi:10.1000/x", false],
    ["10.1000/a b", false],
    [`10.1000/${"a".repeat(293)}`, false],
  ])("DOI %s: %s", (doi, ok) => expect(isWorkSourceDoi(doi)).toBe(ok));

  it.each([
    ["9789530000001", true],
    ["9789530000000", false],
    ["953000009X", true],
    ["9530000001", false],
    ["978-953-0-00000-0", false],
    ["9771234567890", false],
  ])("ISBN %s: %s", (isbn, ok) => expect(isWorkSourceIsbn(isbn)).toBe(ok));
});

describe("save", () => {
  it("sends the checked record through save_work_source and returns the saved row", async () => {
    const { port, seen } = fake([ROW]);
    const outcome = await port.save(TOKEN, {
      assignmentId: ASSIGNMENT,
      record: RECORD,
      isbn: "9789530000001",
    });
    expect(outcome).toEqual({
      status: "saved",
      source: { ...ROW, createdAt: AT.toISOString(), updatedAt: AT.toISOString() },
    });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual(RECORD);
    expect(seen[0]?.sql).toContain("institution.save_work_source(");
    expect(seen[0]?.values).toEqual([ASSIGNMENT, expect.any(String), null, "9789530000001", false]);
  });

  it.each([
    ["an unknown field", { ...RECORD, note: "bilješka" }],
    ["a missing publisher", { ...RECORD, publisher: undefined }],
    ["a title with a leading blank", { ...RECORD, title: " Naslov" }],
    ["a year as text", { ...RECORD, year: "2024" }],
    ["an array", [RECORD]],
  ])("refuses %s before the database", async (_label, record) => {
    const { port, seen } = fake();
    expect(await port.save(TOKEN, { assignmentId: ASSIGNMENT, record })).toEqual({
      status: "invalid_input",
    });
    expect(seen).toEqual([]);
  });

  it.each([
    { doi: "10.1000/X" },
    { isbn: "9789530000000" },
    { undated: "da" as unknown as boolean },
  ])("refuses %o before the database", async (extra) => {
    const { port, seen } = fake();
    expect(await port.save(TOKEN, { assignmentId: ASSIGNMENT, record: RECORD, ...extra })).toEqual({
      status: "invalid_input",
    });
    expect(seen).toEqual([]);
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_input" }],
  ])("maps %s to an outcome", async (code, outcome) => {
    const { port } = fake(coded(code));
    expect(await port.save(TOKEN, { assignmentId: ASSIGNMENT, record: RECORD })).toEqual(outcome);
  });

  it("rolls back when the answer is not the saved source", async () => {
    const { port, rolledBack } = fake([{ ...ROW, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
    await expect(port.save(TOKEN, { assignmentId: ASSIGNMENT, record: RECORD })).rejects.toThrow(
      "unconfirmed work source",
    );
    expect(rolledBack()).toBe(1);
  });

  it("throws any other database error", async () => {
    const { port } = fake(coded("57014"));
    await expect(port.save(TOKEN, { assignmentId: ASSIGNMENT, record: RECORD })).rejects.toThrow(
      "izmišljeno",
    );
  });
});

describe("saveForStudent", () => {
  it("sends the student and the requirement through save_teacher_work_source", async () => {
    const { port, seen } = fake([{ ...ROW, requirement: "required" }]);
    const outcome = await port.saveForStudent(TOKEN, {
      assignmentId: ASSIGNMENT,
      studentId: STUDENT,
      record: RECORD,
      requirement: "required",
      undated: true,
    });
    expect(outcome).toMatchObject({ status: "saved", source: { requirement: "required" } });
    expect(seen[0]?.sql).toContain("institution.save_teacher_work_source(");
    expect(seen[0]?.values).toEqual([
      ASSIGNMENT,
      STUDENT,
      expect.any(String),
      "required",
      null,
      null,
      true,
    ]);
  });

  it("refuses an unknown requirement or student id before the database", async () => {
    const { port, seen } = fake();
    const base = { assignmentId: ASSIGNMENT, studentId: STUDENT, record: RECORD };
    expect(
      await port.saveForStudent(TOKEN, {
        ...base,
        requirement: "optional" as unknown as "required",
      }),
    ).toEqual({ status: "invalid_input" });
    expect(
      await port.saveForStudent(TOKEN, { ...base, studentId: "Student", requirement: "required" }),
    ).toEqual({
      status: "invalid_input",
    });
    expect(seen).toEqual([]);
  });
});

describe("list and remove", () => {
  it("lists the caller's own work with a null student", async () => {
    const { port, seen } = fake([
      ROW,
      {
        ...ROW,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        record: { ...RECORD, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        requirement: "recommended",
      },
    ]);
    const outcome = await port.list(TOKEN, ASSIGNMENT, null);
    expect(outcome.status === "read" && outcome.sources.map((s) => s.requirement)).toEqual([
      null,
      "recommended",
    ]);
    expect(seen[0]?.values).toEqual([ASSIGNMENT, null]);
  });

  it("throws on a row whose record is not its id's", async () => {
    const { port } = fake([
      { ...ROW, record: { ...RECORD, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
    ]);
    await expect(port.list(TOKEN, ASSIGNMENT, STUDENT)).rejects.toThrow("invalid work source row");
  });

  it("answers not_found for ids that are no lowercase UUID, without the database", async () => {
    const { port, seen } = fake();
    expect(await port.list(TOKEN, ASSIGNMENT.toUpperCase(), null)).toEqual({ status: "not_found" });
    expect(await port.remove(TOKEN, ASSIGNMENT, "x")).toEqual({ status: "not_found" });
    expect(await port.removeForStudent(TOKEN, ASSIGNMENT, "x", SOURCE)).toEqual({
      status: "not_found",
    });
    expect(seen).toEqual([]);
  });

  it("tells removed from absent and maps refusals", async () => {
    const { port, seen } = fake([{ removed: true }], [{ removed: false }], coded("ZD403"));
    expect(await port.remove(TOKEN, ASSIGNMENT, SOURCE)).toEqual({ status: "removed" });
    expect(await port.removeForStudent(TOKEN, ASSIGNMENT, STUDENT, SOURCE)).toEqual({
      status: "absent",
    });
    expect(await port.remove(TOKEN, ASSIGNMENT, SOURCE)).toEqual({ status: "not_found" });
    expect(seen.map((s) => s.sql)).toEqual([
      expect.stringContaining("institution.delete_work_source("),
      expect.stringContaining("institution.delete_teacher_work_source("),
      expect.stringContaining("institution.delete_work_source("),
    ]);
  });
});
