import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createStudentWorkStarter, StudentWorkRowError } from "./start.ts";
import { languageOf, rulesVersionOf } from "./start.ts";
import { worksOf } from "./works.ts";

/** A database row: camelCase keys here, snake_case columns as the driver gives them. */
const columns = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );

// SRV-1412: the row checks of the two ports. A row the statements never
// return throws, so withActor rolls back and the route answers 503.
const row = (overrides: Record<string, unknown> = {}) =>
  columns({
    documentId: "w-1",
    assignmentId: "00000000-0000-4000-8000-000000001412",
    title: "Izmišljeni esej",
    courseId: "00000000-0000-4000-8000-0000000014f1",
    courseName: "Izmišljeni kolegij",
    academicYear: "2026/2027",
    dueAt: "2026-12-15T22:59:00.000Z",
    revision: "0",
    state: "none",
    requestedAt: null,
    language: "hr",
    noticeChanged: false,
    afterDeadline: null,
    ...overrides,
  });

function fakeActor(answers: Record<string, unknown[]>): WithActor {
  return (_token, run) =>
    run({
      query: async (sql: string) => {
        // The keys name the function a statement calls, in camelCase.
        const key = Object.keys(answers).find((name) =>
          sql.includes(Object.keys(columns({ [name]: 0 }))[0]!),
        );
        const rows =
          key === undefined ? [] : answers[key]!.map((r) => columns(r as Record<string, unknown>));
        return { rows, rowCount: rows.length };
      },
    } as ActorTransaction);
}

describe("starting a work", () => {
  it("answers the work, its rules version and language", async () => {
    const starter = createStudentWorkStarter(
      fakeActor({
        openStudentWork: [{ outcome: "opened", documentId: "w-1" }],
        assignmentInstitutionConfig: [{ version: 3 }],
        workLanguage: [{ language: "en" }],
      }),
    );
    expect(await starter.start("t", "a")).toEqual({
      status: "started",
      work: { workId: "w-1", rulesVersion: 3, language: "en" },
    });
  });

  it("passes the database's refusals and never a prototype key as one", async () => {
    for (const outcome of ["unauthenticated", "not_found", "not_accepting", "not_configured"]) {
      const starter = createStudentWorkStarter(
        fakeActor({ openStudentWork: [{ outcome, documentId: null }] }),
      );
      expect(await starter.start("t", "a")).toEqual({ status: outcome });
    }
    for (const outcome of ["__proto__", "toString", "opened"]) {
      const starter = createStudentWorkStarter(
        fakeActor({ openStudentWork: [{ outcome, documentId: null }] }),
      );
      await expect(starter.start("t", "a")).rejects.toBeInstanceOf(StudentWorkRowError);
    }
  });

  it("reads a rules version and a language only in their own form", () => {
    expect(rulesVersionOf([])).toBeNull();
    expect(rulesVersionOf([{ version: 1 }])).toBe(1);
    for (const rows of [
      [{ version: 0 }],
      [{ version: "1" }],
      [{ version: 1 }, { version: 2 }],
      null,
    ]) {
      expect(() => rulesVersionOf(rows)).toThrow(StudentWorkRowError);
    }
    expect(languageOf("hr")).toBe("hr");
    expect(() => languageOf(null)).toThrow(StudentWorkRowError);
    expect(() => languageOf("de")).toThrow(StudentWorkRowError);
  });
});

describe("the student's works", () => {
  it("orders by due time and maps the submission state", () => {
    const works = worksOf([
      row({
        documentId: "w-2",
        assignmentId: "00000000-0000-4000-8000-000000001413",
        dueAt: "2027-01-20T22:59:00.000Z",
        state: "potvrdeno",
        requestedAt: "2027-01-19T10:15:00.000Z",
        revision: "7",
      }),
      row(),
    ]);
    expect(works.map((w) => [w.workId, w.state, w.revision, w.submittedAt])).toEqual([
      ["w-1", "in_progress", 0, null],
      ["w-2", "submitted", 7, "2027-01-19T10:15:00.000Z"],
    ]);
  });

  // F4 1.6: the notice flag is the database's boolean; afterDeadline only once recorded.
  it("passes whether the notice changed and, once recorded, whether the submission was late", () => {
    const [unchanged] = worksOf([row()]);
    expect(unchanged!.noticeChangedSinceSeen).toBe(false);
    expect(unchanged!).not.toHaveProperty("afterDeadline");
    const [changed] = worksOf([
      row({
        noticeChanged: true,
        state: "potvrdeno",
        requestedAt: "2027-01-19T10:15:00.000Z",
        afterDeadline: true,
      }),
    ]);
    expect(changed).toMatchObject({ noticeChangedSinceSeen: true, afterDeadline: true });
    const [onTime] = worksOf([
      row({ state: "ceka", requestedAt: "2027-01-19T10:15:00.000Z", afterDeadline: false }),
    ]);
    expect(onTime!.afterDeadline).toBe(false);
  });

  it("copies only the named columns", () => {
    const [work] = worksOf([row({ grade: "A", accommodation: true })]);
    expect(Object.keys(work!)).not.toContain("grade");
    expect(Object.keys(work!)).not.toContain("accommodation");
  });

  it("refuses a malformed, inherited or repeated row", () => {
    const inherited = Object.create(row()) as object;
    for (const rows of [
      [row({ state: "not_found" })],
      [row({ state: "ceka", requestedAt: null })],
      [row({ revision: "-1" })],
      [row({ language: "de" })],
      [row({ title: "" })],
      [row({ noticeChanged: null })],
      [row({ noticeChanged: "true" })],
      [row({ noticeChanged: undefined })],
      [row({ afterDeadline: "false" })],
      [row({ afterDeadline: undefined })],
      [inherited],
      [row(), row()],
      [null],
    ]) {
      expect(() => worksOf(rows)).toThrow(StudentWorkRowError);
    }
  });
});
