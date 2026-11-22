// The work language port over a fake withActor: the statements and values of
// each RPC, the ZD codes by name, a malformed row as unavailable and the
// document path in one transaction (Ductus work-language.test.ts and
// work-language-route.test.ts at 078c780). All values are invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "./with-actor.ts";
import { createWorkLanguages } from "./work-language.ts";

const TOKEN = "izmisljeni-token-ustanove-0000000000000001";
const ASSIGNMENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const STUDENT = "5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d01";
const DOCUMENT = "izmisljeni-rad-0001";

type Seen = { token: unknown; sql: string; values: readonly unknown[] };

/** A withActor whose statements answer from `answer` in order; one transaction per call. */
function fake(...answers: (unknown[] | Error)[]) {
  const seen: Seen[] = [];
  let transactions = 0;
  const withActor = (async (token, fn) => {
    transactions += 1;
    const tx = {
      async query(sql: string, values: readonly unknown[] = []) {
        seen.push({ token, sql, values });
        const next = answers.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next, rowCount: next.length };
      },
    } as unknown as ActorTransaction;
    return fn(tx);
  }) as WithActor;
  return { port: createWorkLanguages(withActor), seen, transactions: () => transactions };
}
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

describe("setAssignmentWorkLanguage", () => {
  it("passes the session, assignment, version and language, and answers the version", async () => {
    const { port, seen } = fake([{ version: 4 }]);
    expect(await port.setAssignmentWorkLanguage(TOKEN, ASSIGNMENT, 3, "en")).toEqual({
      status: "updated",
      version: 4,
    });
    expect(seen).toEqual([
      {
        token: TOKEN,
        sql: "SELECT institution.set_assignment_work_language($1, $2, $3) AS version",
        values: [ASSIGNMENT, 3, "en"],
      },
    ]);
  });

  it.each<[string, unknown[]]>([
    ["an older version", [{ version: 2 }]],
    ["a version as text", [{ version: "4" }]],
    ["no row", []],
    ["two rows", [{ version: 4 }, { version: 4 }]],
  ])("%s is unavailable", async (_name, rows) => {
    const { port } = fake(rows);
    expect(await port.setAssignmentWorkLanguage(TOKEN, ASSIGNMENT, 3, "en")).toEqual({
      status: "unavailable",
      reason: "assignment_language_malformed",
    });
  });

  it("refuses an id that is not a version 1-8 UUID without asking", async () => {
    const { port, seen } = fake();
    const nil = "00000000-0000-0000-0000-000000000000";
    expect(await port.setAssignmentWorkLanguage(TOKEN, nil, 3, "en")).toEqual({
      status: "forbidden",
    });
    expect(seen).toEqual([]);
  });
});

describe("the ZD codes of every write", () => {
  const writes = [
    (p: ReturnType<typeof fake>["port"]) => p.setAssignmentWorkLanguage(TOKEN, ASSIGNMENT, 3, "en"),
    (p: ReturnType<typeof fake>["port"]) => p.setWorkLanguage(TOKEN, ASSIGNMENT, STUDENT, "en"),
    (p: ReturnType<typeof fake>["port"]) =>
      p.setWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT, "en"),
  ];
  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD409", { status: "conflict" }],
    ["ZD422", { status: "invalid" }],
    ["XX000", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, expected) => {
    for (const write of writes) {
      const { port } = fake(coded(code));
      expect(await write(port)).toEqual(expected);
    }
  });
});

describe("setWorkLanguage", () => {
  it("sets or removes the exception and answers the language the work has afterwards", async () => {
    const { port, seen } = fake([{ language: "hr" }]);
    expect(await port.setWorkLanguage(TOKEN, ASSIGNMENT, STUDENT, null)).toEqual({
      status: "updated",
      language: "hr",
    });
    expect(seen[0]!.values).toEqual([ASSIGNMENT, STUDENT, null]);
    expect(seen[0]!.sql).toBe("SELECT institution.set_work_language($1, $2, $3) AS language");
  });

  it("a language the database does not know is unavailable", async () => {
    const { port } = fake([{ language: "HR" }]);
    expect(await port.setWorkLanguage(TOKEN, ASSIGNMENT, STUDENT, "en")).toEqual({
      status: "unavailable",
      reason: "work_language_malformed",
    });
  });
});

describe("setWorkLanguageForDocument", () => {
  it("names the work's student and sets the language in one transaction", async () => {
    const { port, seen, transactions } = fake([{ student_id: STUDENT }], [{ language: "en" }]);
    expect(await port.setWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT, "en")).toEqual({
      status: "updated",
      language: "en",
    });
    expect(transactions()).toBe(1);
    expect(seen.map((s) => s.values)).toEqual([
      [ASSIGNMENT, DOCUMENT],
      [ASSIGNMENT, STUDENT, "en"],
    ]);
    expect(seen[0]!.sql).toContain(
      "FROM app.assignment_works($1::uuid) x WHERE x.document_id = $2",
    );
  });

  it("a document that is no work of the caller's assignment is forbidden, without a write", async () => {
    const { port, seen } = fake([]);
    expect(await port.setWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT, "en")).toEqual({
      status: "forbidden",
    });
    expect(seen).toHaveLength(1);
  });

  it.each<[string, unknown[]]>([
    ["two works", [{ student_id: STUDENT }, { student_id: STUDENT }]],
    ["a student id that is no UUID", [{ student_id: "x" }]],
    ["no student id", [{}]],
  ])("%s is unavailable, without a write", async (_name, rows) => {
    const { port, seen } = fake(rows);
    expect(await port.setWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT, "en")).toEqual({
      status: "unavailable",
      reason: "work_language_malformed",
    });
    expect(seen).toHaveLength(1);
  });

  it("an answer that is no language is unavailable", async () => {
    const { port } = fake([{ student_id: STUDENT }], [{ language: null }]);
    expect(await port.setWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT, "en")).toEqual({
      status: "unavailable",
      reason: "work_language_malformed",
    });
  });
});

describe("readWorkLanguageForDocument", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    student_id: STUDENT,
    language: "hr",
    assignmentLanguage: "hr",
    title: "Izmišljeni naslov rada",
    exception: null,
    ...over,
  });
  const read = (...answers: (unknown[] | Error)[]) => {
    const f = fake(...answers);
    return { ...f, got: f.port.readWorkLanguageForDocument(TOKEN, ASSIGNMENT, DOCUMENT) };
  };

  it("answers title, assignment language and exception from one transaction", async () => {
    const { got, transactions, seen } = read([{ user_id: STUDENT }], [row()]);
    expect(await got).toEqual({
      status: "read",
      title: "Izmišljeni naslov rada",
      assignmentLanguage: "hr",
      exception: null,
    });
    expect(transactions()).toBe(1);
    expect(seen[1]!.values).toEqual([ASSIGNMENT, DOCUMENT]);
  });

  it("answers the exception when the work has one", async () => {
    const { got } = read([{ user_id: STUDENT }], [row({ language: "en", exception: "en" })]);
    expect(await got).toMatchObject({ status: "read", exception: "en" });
  });

  it("no live session is unauthenticated, without the read", async () => {
    const { got, seen } = read([{ user_id: null }]);
    expect(await got).toEqual({ status: "unauthenticated" });
    expect(seen).toHaveLength(1);
  });

  it.each<[string, unknown[]]>([
    ["no work", []],
    ["a work the caller may not see", [row({ language: null })]],
  ])("%s is forbidden", async (_name, rows) => {
    const { got } = read([{ user_id: STUDENT }], rows);
    expect(await got).toEqual({ status: "forbidden" });
  });

  it.each<[string, unknown[]]>([
    ["two rows", [row(), row()]],
    ["an empty title", [row({ title: "" })]],
    ["an unknown assignment language", [row({ assignmentLanguage: "de" })]],
    ["an unknown exception", [row({ exception: "de", language: "hr" })]],
    ["a language the values do not explain", [row({ language: "en" })]],
  ])("%s is unavailable", async (_name, rows) => {
    const { got } = read([{ user_id: STUDENT }], rows);
    expect(await got).toEqual({ status: "unavailable", reason: "work_language_malformed" });
  });

  it("a ZD403 is forbidden, any other error unavailable, and an assignment that is no UUID forbidden", async () => {
    expect(await read(coded("ZD403")).got).toEqual({ status: "forbidden" });
    expect(await read(new Error("x")).got).toEqual({
      status: "unavailable",
      reason: "database_error",
    });
    const { port, seen } = fake();
    expect(await port.readWorkLanguageForDocument(TOKEN, "x", DOCUMENT)).toEqual({
      status: "forbidden",
    });
    expect(seen).toEqual([]);
  });
});
