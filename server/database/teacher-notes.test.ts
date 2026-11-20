// The port of the teacher's notes and templates (SRV-8B) over a scripted
// transaction: the SQL and parameters each call sends, the mapping of rows,
// and the closed statuses for database errors and rows of an unexpected
// shape. The database itself is db/main/tests/158-teacher-notes-access.sql.
import { describe, expect, it } from "vitest";

import { createTeacherNotes } from "./teacher-notes.ts";
import type { WithActor } from "./with-actor.ts";

const NOTE = "4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d01";
const TEMPLATE = "4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d02";
const AT = new Date("2026-11-21T09:00:00.000Z");
const ANCHOR = {
  nodeId: "0f0e0d0c-0b0a-4000-8000-000000000001",
  quote: "prvi odlomak",
  prefix: "",
  suffix: " teksta",
  startHint: 0,
  endHint: 12,
};

/** A withActor that answers `rows`, or throws `error`; it records each statement. */
function scripted(rows: Record<string, unknown>[], error?: unknown) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const tokens: unknown[] = [];
  const withActor = (async (token, fn) => {
    tokens.push(token);
    return fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (error !== undefined) throw error;
        return { rows, rowCount: rows.length };
      },
    } as never);
  }) as WithActor;
  return { port: createTeacherNotes(withActor), calls, tokens };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });

describe("createTeacherNotes: notes", () => {
  it("creates an anchored note with the anchor as JSON, under the caller's token", async () => {
    const run = scripted([{ id: NOTE, createdAt: AT }]);
    expect(await run.port.createNote("t", "doc-a", "Provjeriti izvor.", ANCHOR)).toEqual({
      status: "created",
      id: NOTE,
      createdAt: "2026-11-21T09:00:00.000Z",
    });
    expect(run.tokens).toEqual(["t"]);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.text).toContain("collaboration.create_teacher_note($1, $2, $3::jsonb)");
    expect(run.calls[0]!.values).toEqual(["doc-a", "Provjeriti izvor.", JSON.stringify(ANCHOR)]);
  });

  it("sends a null anchor for a note on the whole work", async () => {
    const run = scripted([{ id: NOTE, createdAt: AT }]);
    await run.port.createNote("t", "doc-a", "Općenito.", null);
    expect(run.calls[0]!.values).toEqual(["doc-a", "Općenito.", null]);
  });

  it("lists the caller's notes with ISO times and anchors as stored", async () => {
    const run = scripted([
      { noteId: NOTE, body: "Prva.", anchor: ANCHOR, createdAt: AT },
      { noteId: TEMPLATE, body: "Druga.", anchor: null, createdAt: AT },
    ]);
    expect(await run.port.listNotes("t", "doc-a")).toEqual({
      status: "ok",
      items: [
        { noteId: NOTE, body: "Prva.", anchor: ANCHOR, createdAt: "2026-11-21T09:00:00.000Z" },
        { noteId: TEMPLATE, body: "Druga.", anchor: null, createdAt: "2026-11-21T09:00:00.000Z" },
      ],
    });
    expect(run.calls[0]!.text).toContain("collaboration.list_teacher_notes($1)");
    expect(run.calls[0]!.values).toEqual(["doc-a"]);
  });

  it("deletes a note by id", async () => {
    const run = scripted([{}]);
    expect(await run.port.deleteNote("t", NOTE)).toEqual({ status: "deleted" });
    expect(run.calls[0]!.text).toBe("SELECT collaboration.delete_teacher_note($1::uuid)");
    expect(run.calls[0]!.values).toEqual([NOTE]);
  });
});

describe("createTeacherNotes: templates", () => {
  it("creates, lists and deletes the caller's templates", async () => {
    const create = scripted([{ id: TEMPLATE, createdAt: AT }]);
    expect(await create.port.createTemplate("t", "Dodajte stranicu u navod.", "must")).toEqual({
      status: "created",
      id: TEMPLATE,
      createdAt: "2026-11-21T09:00:00.000Z",
    });
    expect(create.calls[0]!.values).toEqual(["Dodajte stranicu u navod.", "must"]);

    const list = scripted([
      { templateId: TEMPLATE, kind: "praise", body: "Dobro.", createdAt: AT },
    ]);
    expect(await list.port.listTemplates("t")).toEqual({
      status: "ok",
      items: [
        {
          templateId: TEMPLATE,
          kind: "praise",
          body: "Dobro.",
          createdAt: "2026-11-21T09:00:00.000Z",
        },
      ],
    });
    expect(list.calls[0]!.values).toEqual([]);

    const remove = scripted([{}]);
    expect(await remove.port.deleteTemplate("t", TEMPLATE)).toEqual({ status: "deleted" });
    expect(remove.calls[0]!.text).toBe("SELECT collaboration.delete_comment_template($1::uuid)");
  });
});

describe("createTeacherNotes: refusals", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["42501", "unavailable"],
    ["XX000", "unavailable"],
  ])("maps %s to %s, with no database message", async (code, status) => {
    const run = scripted([], dbError(code));
    expect(await run.port.listNotes("t", "doc-a")).toEqual({ status });
    expect(await run.port.deleteTemplate("t", TEMPLATE)).toEqual({ status });
  });

  it("is unavailable for an error without a code or with a throwing getter", async () => {
    expect(await scripted([], new Error("x")).port.deleteNote("t", NOTE)).toEqual({
      status: "unavailable",
    });
    const hostile = Object.defineProperty({}, "code", {
      get() {
        throw new Error("getter");
      },
    });
    expect(await scripted([], hostile).port.deleteNote("t", NOTE)).toEqual({
      status: "unavailable",
    });
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { id: NOTE, createdAt: AT },
        { id: NOTE, createdAt: AT },
      ],
    ],
    ["a time that is not a Date", [{ id: NOTE, createdAt: "2026-11-21" }]],
    ["an id that is not text", [{ id: 7, createdAt: AT }]],
  ])("is unavailable when a create answers %s", async (_why, rows) => {
    expect(await scripted(rows).port.createNote("t", "doc-a", "x", null)).toEqual({
      status: "unavailable",
    });
  });

  it("is unavailable for a listed row of an unexpected shape", async () => {
    const note = scripted([{ noteId: NOTE, body: "x", anchor: [1], createdAt: AT }]);
    expect(await note.port.listNotes("t", "doc-a")).toEqual({ status: "unavailable" });
    const template = scripted([{ templateId: TEMPLATE, kind: "ocjena", body: "x", createdAt: AT }]);
    expect(await template.port.listTemplates("t")).toEqual({ status: "unavailable" });
  });
});
