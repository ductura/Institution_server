import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createLegalHolds } from "./index.ts";

const HOLD = "00000000-0000-4000-8000-0000000000c1";
const ADMIN_A = "00000000-0000-4000-8000-0000000000a1";
const ADMIN_B = "00000000-0000-4000-8000-0000000000a2";
const PLACED = new Date("2026-11-02T09:30:00.000Z");
const RELEASED = new Date("2026-11-03T10:00:00.000Z");

function setup(answer: object[] | Error) {
  const calls: { sql: string; params: readonly unknown[] | undefined }[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (answer instanceof Error) throw answer;
        return { rows: answer as Row[], rowCount: answer.length };
      },
    });
  return { holds: createLegalHolds(withActor), calls };
}

/** A database row, with the column names the RPC returns. */
const row = (overrides: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries({
      holdId: HOLD,
      subjectType: "work",
      subjectId: "rad-izmisljeni-1",
      caseReference: "KLASA-2026-17",
      placedBy: ADMIN_A,
      placedAt: PLACED,
      releasedBy: null,
      releasedAt: null,
      ...overrides,
    }),
  );

const coded = (code: string) => Object.assign(new Error("refused"), { code });

it("lists the holds of the institution", async () => {
  const { holds } = setup([
    row(),
    row({ holdId: ADMIN_B, releasedBy: ADMIN_B, releasedAt: RELEASED }),
    row({ subjectType: "student", releasedAt: RELEASED }),
  ]);
  expect(await holds.list("session")).toEqual({
    status: "ok",
    holds: [
      {
        holdId: HOLD,
        subjectType: "work",
        subjectId: "rad-izmisljeni-1",
        caseReference: "KLASA-2026-17",
        placedBy: ADMIN_A,
        placedAt: PLACED.toISOString(),
        releasedBy: null,
        releasedAt: null,
      },
      expect.objectContaining({ releasedBy: ADMIN_B, releasedAt: RELEASED.toISOString() }),
      expect.objectContaining({ subjectType: "student", releasedBy: null }),
    ],
  });
});

it.each([
  ["an unknown subject type", row({ subjectType: "course" })],
  ["a placement time that is text", row({ placedAt: "2026-11-02" })],
  ["a releaser without a release time", row({ releasedBy: ADMIN_B })],
  ["a missing case reference", row({ caseReference: null })],
])("is unavailable when a listed row has %s", async (_name, bad) => {
  const { holds } = setup([row(), bad]);
  expect(await holds.list("session")).toEqual({ status: "unavailable" });
});

it("places a hold with the values as given and returns its id", async () => {
  const { holds, calls } = setup([{ holdId: HOLD }]);
  expect(
    await holds.place("session", {
      subjectType: "assignment",
      subjectId: ADMIN_B,
      caseReference: "KLASA-2026-17",
    }),
  ).toEqual({ status: "ok", holdId: HOLD });
  expect(calls.map((c) => c.params)).toEqual([["assignment", ADMIN_B, "KLASA-2026-17"]]);
});

it("releases a hold and returns the release time", async () => {
  const { holds, calls } = setup([{ releasedAt: RELEASED }]);
  expect(await holds.release("session", HOLD.toUpperCase(), "Postupak je zatvoren.")).toEqual({
    status: "ok",
    holdId: HOLD,
    releasedAt: RELEASED.toISOString(),
  });
  expect(calls.map((c) => c.params)).toEqual([[HOLD, "Postupak je zatvoren."]]);
});

it("does not ask the database to release an id that is not a uuid", async () => {
  const { holds, calls } = setup([]);
  expect(await holds.release("session", "nije-uuid", "razlog")).toEqual({ status: "not_found" });
  expect(calls).toEqual([]);
});

it.each([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
  ["57014", "unavailable"],
])("maps %s to %s on every call", async (code, status) => {
  const { holds } = setup(coded(code));
  expect(await holds.list("session")).toEqual({ status });
  expect(
    await holds.place("session", { subjectType: "work", subjectId: "x", caseReference: "y" }),
  ).toEqual({ status });
  expect(await holds.release("session", HOLD, "razlog")).toEqual({ status });
});

it.each([
  ["no row", []],
  ["an id that is not a uuid", [{ holdId: "h1" }]],
])("is unavailable when placing returns %s", async (_name, rows) => {
  const { holds } = setup(rows);
  expect(
    await holds.place("session", { subjectType: "work", subjectId: "x", caseReference: "y" }),
  ).toEqual({ status: "unavailable" });
});

it("is unavailable when releasing returns no time", async () => {
  const { holds } = setup([{ releasedAt: null }]);
  expect(await holds.release("session", HOLD, "razlog")).toEqual({ status: "unavailable" });
});
