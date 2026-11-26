import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createTeacherSubmissionNotesReader } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const NOTE = "00000000-0000-4000-8000-0000000000c1";

const TEACHER = "00000000-0000-4000-8000-0000000000d1";

function setup(rows: object[] | Error, actor: string = TEACHER) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(sql: string, params?: readonly unknown[]) {
        if (sql.includes("current_actor")) {
          return { rows: [{ user_id: actor }] as Row[], rowCount: 1 };
        }
        if (rows instanceof Error) throw rows;
        calls.push(params);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  return { read: createTeacherSubmissionNotesReader(withActor), calls };
}

const coded = (code: string) => Object.assign(new Error("refused"), { code });
const row = (id: unknown, text: unknown, createdAt: unknown) => ({ id, text, createdAt });

it("returns the notes with ISO instants, naming the student in the call", async () => {
  const at = new Date("2026-11-20T09:15:00.000Z");
  const { read, calls } = setup([row(NOTE, "Izmišljena napomena.", at)]);
  expect(await read("session", ASSIGNMENT.toUpperCase(), STUDENT)).toEqual({
    status: "ok",
    body: { notes: [{ id: NOTE, text: "Izmišljena napomena.", createdAt: at.toISOString() }] },
  });
  expect(calls).toEqual([[ASSIGNMENT, STUDENT]]);
});

it("returns an empty list without notes", async () => {
  const { read } = setup([]);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({
    status: "ok",
    body: { notes: [] },
  });
});

it("answers not_found for a malformed id without a query", async () => {
  const { read, calls } = setup([]);
  expect(await read("session", "x", STUDENT)).toEqual({ status: "not_found" });
  expect(await read("session", ASSIGNMENT, "")).toEqual({ status: "not_found" });
  expect(calls).toEqual([]);
});

it("maps ZD403 to not_found, ZD401 to unauthenticated, anything else to unavailable", async () => {
  expect(await setup(coded("ZD403")).read("s", ASSIGNMENT, STUDENT)).toEqual({
    status: "not_found",
  });
  expect(await setup(coded("ZD401")).read("s", ASSIGNMENT, STUDENT)).toEqual({
    status: "unauthenticated",
  });
  expect(await setup(new Error("down")).read("s", ASSIGNMENT, STUDENT)).toEqual({
    status: "unavailable",
  });
});

it("is unavailable for a malformed row", async () => {
  const bad = [
    row(NOTE, 5, new Date()),
    row(NOTE, "t", "2026-11-20"),
    row(NOTE, "t", new Date(NaN)),
  ];
  for (const one of bad) {
    expect(await setup([one]).read("s", ASSIGNMENT, STUDENT)).toEqual({ status: "unavailable" });
  }
});

it("refuses the caller's own notes without reading them, as the database would serve them", async () => {
  const { read, calls } = setup([row(NOTE, "Izmišljena napomena.", new Date())], STUDENT);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "not_found" });
  expect(calls).toEqual([]);
});
