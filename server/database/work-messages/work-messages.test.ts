// The port of the work messages (SRV-1106) over a scripted transaction: the SQL
// and parameters each call sends, the mapping of rows, and the closed statuses
// for database errors and rows of an unexpected shape. The database itself is
// db/main/tests/164-work-message-access.sql.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createWorkMessages } from "./work-messages.ts";

const ID = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e01";
const AT = new Date("2026-11-21T09:00:00.000Z");

function scripted(rows: Record<string, unknown>[], error?: unknown) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const withActor = (async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (error !== undefined) throw error;
        return { rows, rowCount: rows.length };
      },
    } as never)) as WithActor;
  return { port: createWorkMessages(withActor), calls };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });
const ROW = { id: ID, senderRole: "teacher", text: "Izmišljena poruka.", createdAt: AT };

describe("createWorkMessages", () => {
  it("creates a message and maps the row", async () => {
    const run = scripted([ROW]);
    expect(await run.port.create("t", "doc-a", "Izmišljena poruka.")).toEqual({
      status: "created",
      message: { ...ROW, createdAt: "2026-11-21T09:00:00.000Z" },
    });
    expect(run.calls[0]!.text).toContain("collaboration.create_work_message($1, $2)");
    expect(run.calls[0]!.values).toEqual(["doc-a", "Izmišljena poruka."]);
  });

  it("lists in the order the database gives", async () => {
    const run = scripted([ROW, { ...ROW, id: "x", senderRole: "student" }]);
    const answer = await run.port.list("t", "doc-a");
    expect(answer).toMatchObject({ status: "ok" });
    expect("messages" in answer && answer.messages.map((m) => m.senderRole)).toEqual([
      "teacher",
      "student",
    ]);
    expect(run.calls[0]!.text).toContain("collaboration.list_work_messages($1)");
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["08006", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    expect(await scripted([], dbError(code)).port.list("t", "doc-a")).toEqual({ status });
  });

  it.each([
    [{ ...ROW, senderRole: "admin" }],
    [{ ...ROW, createdAt: "not a date" }],
    [{ ...ROW, text: 5 }],
  ])("answers unavailable for a malformed row %#", async (row) => {
    expect(await scripted([row]).port.list("t", "doc-a")).toEqual({ status: "unavailable" });
    expect(await scripted([row]).port.create("t", "doc-a", "x")).toEqual({
      status: "unavailable",
    });
  });
});
