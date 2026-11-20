import { describe, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";

import { createStudentNotes } from "./student-notes-route.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "D".repeat(43);
const ROW = {
  id: "00000000-0000-4000-8000-00000000019a",
  text: "Napomena o izmišljenom radu.",
  createdAt: new Date("2026-11-20T15:30:00.000Z"),
};
const NOTE = { ...ROW, createdAt: ROW.createdAt.toISOString() };

function fixture(rows: unknown[] = [ROW]) {
  const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
    rows,
    rowCount: rows.length,
  }));
  const finish = vi.fn();
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    try {
      const value = await run({
        async query<Row>(text: string, values?: readonly unknown[]) {
          const result = await query(text, values);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      });
      finish("commit");
      return value;
    } catch (error) {
      finish("rollback");
      throw error;
    }
  };
  return { query, finish, notes: createStudentNotes(withActor) };
}

describe("submission note input", () => {
  it.each([
    ["empty", ""],
    ["white space", " \t\n\u00a0"],
    ["601 characters", "a".repeat(601)],
    ["601 supplementary characters", "🌱".repeat(601)],
    ["zero byte", "a\u0000"],
    ["unpaired surrogate", "\ud800"],
    ["non-string", 1],
  ])("rejects %s before the database call", async (_label, text) => {
    const { notes, query } = fixture();
    expect(await notes.add(TOKEN, { assignmentId: ASSIGNMENT, text })).toEqual({
      status: "invalid_input",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["a", "a".repeat(600), "🌱".repeat(600), "  x\n"])("accepts valid text", async (text) => {
    const { notes } = fixture([{ ...ROW, text }]);
    expect(await notes.add(TOKEN, { assignmentId: ASSIGNMENT, text })).toEqual({
      status: "added",
      note: { ...NOTE, text },
    });
  });

  it.each(["", "not-a-uuid", ASSIGNMENT.toUpperCase(), `${ASSIGNMENT}\n`])(
    "rejects noncanonical assignment ID %j",
    async (id) => {
      const { notes, query } = fixture();
      expect(await notes.read(TOKEN, id)).toEqual({ status: "not_found" });
      expect(await notes.add(TOKEN, { assignmentId: id, text: NOTE.text })).toEqual({
        status: "invalid_input",
      });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { assignmentId: ASSIGNMENT },
    { assignmentId: ASSIGNMENT, text: NOTE.text, studentId: ROW.id },
  ])("refuses a body outside the closed contract", async (body) => {
    const { notes, query } = fixture();
    expect(await notes.add(TOKEN, body)).toEqual({ status: "invalid_input" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("student notes over the caller's transaction", () => {
  it("lists the caller's notes in database order without a student selector", async () => {
    const second = { ...ROW, id: "00000000-0000-4000-8000-00000000019b" };
    const { notes, query } = fixture([ROW, second]);
    await expect(notes.read(TOKEN, ASSIGNMENT)).resolves.toEqual({
      status: "read",
      notes: [NOTE, { ...NOTE, id: second.id }],
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("FROM app.submission_notes($1::uuid) ORDER BY created_at, id"),
      [ASSIGNMENT],
    );
    await expect(fixture([]).notes.read(TOKEN, ASSIGNMENT)).resolves.toEqual({
      status: "read",
      notes: [],
    });
  });

  it("passes the unchanged text as a parameter and returns the stored note after commit", async () => {
    const text = `  Dodatak: "izvor".\n`;
    const { notes, query, finish } = fixture([{ ...ROW, text }]);
    await expect(notes.add(TOKEN, { assignmentId: ASSIGNMENT, text })).resolves.toEqual({
      status: "added",
      note: { ...NOTE, text },
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("FROM app.add_submission_note($1::uuid, $2::text)"),
      [ASSIGNMENT, text],
    );
    expect(finish).toHaveBeenCalledExactlyOnceWith("commit");
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid_input"],
  ])("maps add refusal %s after rollback", async (code, status) => {
    const { notes, query, finish } = fixture();
    query.mockRejectedValue({ code, detail: "Interni podatak izmišljene napomene" });
    await expect(notes.add(TOKEN, { assignmentId: ASSIGNMENT, text: NOTE.text })).resolves.toEqual({
      status,
    });
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
  });

  it.each([
    ["missing row", []],
    ["multiple rows", [ROW, ROW]],
    ["wrong text", [{ ...ROW, text: "Druga napomena" }]],
    ["malformed timestamp", [{ ...ROW, createdAt: new Date(NaN) }]],
  ])("rolls back an append with %s", async (_label, rows) => {
    const { notes, finish } = fixture(rows);
    await expect(notes.add(TOKEN, { assignmentId: ASSIGNMENT, text: NOTE.text })).rejects.toThrow();
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
  });

  it("rejects the whole read when one row is malformed", async () => {
    const { notes } = fixture([ROW, { ...ROW, text: "" }]);
    await expect(notes.read(TOKEN, ASSIGNMENT)).rejects.toThrow();
  });
});
