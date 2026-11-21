// The port of direct edits (SRV-1702) over a scripted transaction: the SQL and
// parameters each call sends, the mapping of rows, and the closed statuses for
// database errors and rows of an unexpected shape. The database itself is
// db/main/tests/200-teacher-direct-edit.sql.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createDirectEdits } from "./direct-edit.ts";

const AT = new Date("2026-11-21T09:00:00.000Z");
const TOKEN = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const HASH = "4f".repeat(32);

type Row = Record<string, unknown>;
function scripted(results: (Row[] | Error)[]) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const withActor = (async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        const next = results.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next, rowCount: next.length };
      },
    } as never)) as WithActor;
  return { port: createDirectEdits(withActor), calls };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });

describe("createDirectEdits.read", () => {
  it("reads the setting and the record in one transaction", async () => {
    const run = scripted([
      [{ mode: "direct", changedAt: AT }],
      [
        { kind: "mode", source: "student", mode: "direct", bytes: null, at: AT },
        { kind: "teacher_edit", source: "teacher", mode: null, bytes: 412, at: AT },
      ],
    ]);
    expect(await run.port.read("t", "doc-a")).toEqual({
      status: "ok",
      mode: "direct",
      changedAt: AT.toISOString(),
      record: [
        { kind: "mode", source: "student", mode: "direct", at: AT.toISOString() },
        { kind: "teacher_edit", source: "teacher", bytes: 412, at: AT.toISOString() },
      ],
    });
    expect(run.calls.map((c) => c.text)).toEqual([
      expect.stringContaining("collaboration.read_direct_edit($1)"),
      expect.stringContaining("collaboration.list_direct_edit_record($1)"),
    ]);
    expect(run.calls.every((c) => c.values[0] === "doc-a")).toBe(true);
  });

  it("answers a never changed setting with a null time", async () => {
    const run = scripted([[{ mode: "suggestions", changedAt: null }], []]);
    expect(await run.port.read("t", "doc-a")).toEqual({
      status: "ok",
      mode: "suggestions",
      changedAt: null,
      record: [],
    });
  });

  it.each([
    ["an unknown mode", [[{ mode: "on", changedAt: null }], []]],
    ["no setting row", [[], []]],
    ["a bad time", [[{ mode: "direct", changedAt: "jučer" }], []]],
    [
      "a teacher edit with a mode",
      [
        [{ mode: "direct", changedAt: AT }],
        [{ kind: "teacher_edit", source: "teacher", mode: "direct", bytes: 1, at: AT }],
      ],
    ],
    [
      "a change of mode by a teacher",
      [
        [{ mode: "direct", changedAt: AT }],
        [{ kind: "mode", source: "teacher", mode: "direct", bytes: null, at: AT }],
      ],
    ],
  ])("answers unavailable for %s", async (_name, rows) => {
    expect(await scripted(rows as Row[][]).port.read("t", "doc-a")).toEqual({
      status: "unavailable",
    });
  });
});

describe("createDirectEdits.set", () => {
  it("sends the mode and maps the answer", async () => {
    const run = scripted([[{ outcome: "applied", mode: "direct", changedAt: AT }]]);
    expect(await run.port.set("t", "doc-a", "direct")).toEqual({
      status: "ok",
      outcome: "applied",
      mode: "direct",
      changedAt: AT.toISOString(),
    });
    expect(run.calls[0]!.text).toContain("collaboration.set_direct_edit($1, $2)");
    expect(run.calls[0]!.values).toEqual(["doc-a", "direct"]);
  });

  it("refuses an answer for another mode", async () => {
    const run = scripted([[{ outcome: "applied", mode: "suggestions", changedAt: AT }]]);
    expect(await run.port.set("t", "doc-a", "direct")).toEqual({ status: "unavailable" });
  });
});

describe("createDirectEdits.publishTeacherEdit", () => {
  it("sends the hash read and the text, and maps the outcomes", async () => {
    const run = scripted([
      [{ outcome: "accepted", token: TOKEN }],
      [{ outcome: "unchanged", token: TOKEN }],
      [{ outcome: "conflict", token: null }],
    ]);
    expect(await run.port.publishTeacherEdit("t", "doc-a", HASH, "{}")).toEqual({
      status: "accepted",
      token: TOKEN,
    });
    expect(await run.port.publishTeacherEdit("t", "doc-a", HASH, "{}")).toEqual({
      status: "unchanged",
      token: TOKEN,
    });
    expect(await run.port.publishTeacherEdit("t", "doc-a", HASH, "{}")).toEqual({
      status: "conflict",
      token: null,
    });
    expect(run.calls[0]!.text).toContain("collaboration.publish_teacher_direct_edit($1, $2, $3)");
    expect(run.calls[0]!.values).toEqual(["doc-a", HASH, "{}"]);
  });

  it("never passes on a token with a conflict", async () => {
    const run = scripted([[{ outcome: "conflict", token: TOKEN }]]);
    expect(await run.port.publishTeacherEdit("t", "doc-a", HASH, "{}")).toEqual({
      status: "unavailable",
    });
  });
});

describe("database errors", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("%s is %s on every call", async (code, status) => {
    const run = scripted([dbError(code), dbError(code), dbError(code)]);
    expect(await run.port.read("t", "doc-a")).toEqual({ status });
    expect(await run.port.set("t", "doc-a", "direct")).toEqual({ status });
    expect(await run.port.publishTeacherEdit("t", "doc-a", HASH, "{}")).toEqual({ status });
  });
});
