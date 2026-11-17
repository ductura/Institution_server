// DAN-989-1: the state of the caller's own work per assignment as a route of
// its own (Ductus#1836, UGOVOR w989a). A new route, not a field in
// student.assignments.get: a new member of an existing route is a major
// release of @ductura/contracts (scripts/release/README.md, QA #92).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { ROUTES } from "./index.ts";

const ID = "student.assignment-work.get";
const route = ROUTES.find((r) => r.id === ID);
const body = route?.responses[0]?.body;
const A = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01";
const row = { assignmentId: A, workState: "in_progress" };
const list = (...rows: unknown[]) => ({ assignments: rows });
const check = (value: unknown) => body !== undefined && Value.Check(body, value);

describe("student.assignment-work.get", () => {
  it("is a signed-in GET with no input that fails only as a read", () => {
    expect(route?.method).toBe("GET");
    expect(route?.path).toBe("/api/v1/student/assignment-work");
    expect(route?.access).toBe("signed_in");
    expect(route?.request).toEqual({});
    expect(route?.responses.map((r) => r.status)).toEqual([200]);
    expect(route?.errors.map((e) => `${e.status} ${e.code}`)).toEqual([
      "401 unauthorized",
      "503 unavailable",
    ]);
  });

  it.each([
    "",
    "started",
    "Submitted",
    "notStarted",
    "inProgress",
    "draft",
    " submitted",
    "submitted\n",
  ])("refuses the state %j", (work) => {
    expect(check(list({ ...row, workState: work }))).toBe(false);
  });

  it.each([null, 0, true, ["submitted"], { work: "submitted" }])("refuses the state %j", (work) => {
    expect(check(list({ ...row, workState: work }))).toBe(false);
  });

  it.each(["\n", "\r\n", "\t", "\u00a0", "\u007f", " "])(
    "refuses an assignment id that ends in %j",
    (tail) => {
      expect(check(list({ ...row, assignmentId: `${A}${tail}` }))).toBe(false);
    },
  );

  it.each([
    "",
    "not-a-uuid",
    "1c2d3e4f5a6b4c7d8e9f0a1b2c3d4e01",
    `{${A}}`,
    A.toUpperCase(),
    ` ${A}`,
  ])("refuses the assignment id %j", (assignmentId) => {
    expect(check(list({ ...row, assignmentId }))).toBe(false);
  });

  it.each(["assignmentId", "workState"])("refuses a row without %s", (key) => {
    const partial: Record<string, unknown> = { ...row };
    delete partial[key];
    expect(check(list(partial))).toBe(false);
  });

  it.each(["__proto__", "toString", "constructor", "title", "submittedAt", "documentId"])(
    "refuses an own key %s on the row and on the answer",
    (key) => {
      const extra = JSON.parse(`{"${key}": 1}`) as object;
      expect(check(list({ ...row, ...extra }))).toBe(false);
      expect(check({ ...list(row), ...extra })).toBe(false);
      expect(check(JSON.parse(`{"assignments": [], "${key}": 1}`))).toBe(false);
    },
  );

  it("refuses an answer that is not a list of rows", () => {
    for (const value of [null, [], {}, { assignments: null }, { assignments: [null] }])
      expect(check(value)).toBe(false);
  });

  it("accepts each of the three states and an empty list", () => {
    for (const work of ["not_started", "in_progress", "submitted"])
      expect(check(list({ ...row, workState: work }))).toBe(true);
    expect(check(list())).toBe(true);
  });

  it("has a vector for every state, the empty list, 401 and 503", () => {
    const own = VECTORS.filter((v) => v.route === ID);
    expect(own.map((v) => `${v.name} ${v.response.status}`)).toEqual([
      "ready 200",
      "ready-empty 200",
      "signed-out 401",
      "unavailable 503",
    ]);
    const ready = own[0]?.response.body as
      { assignments: { assignmentId: string; workState: string }[] } | undefined;
    expect(ready?.assignments.map((r) => r.workState).sort()).toEqual([
      "in_progress",
      "not_started",
      "submitted",
    ]);
    // One row per assignment, by assignmentId: the order the read promises.
    const ids = ready?.assignments.map((r) => r.assignmentId) ?? [];
    expect(ids).toEqual([...new Set(ids)].sort());
  });
});
