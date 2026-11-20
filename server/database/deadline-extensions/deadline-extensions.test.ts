// SRV-1108: the port of deadline extensions over a fake withActor. The input is
// checked before the database, the written row is confirmed inside the
// transaction, and ZD401, ZD403 and ZD422 are outcomes. Every id and date
// below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../with-actor.ts";

import { createDeadlineExtensions } from "./deadline-extensions.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000e1";
const T = "00000000-0000-4000-8000-0000000000c1";
const E = "00000000-0000-4000-8000-0000000000f1";
const OLD = new Date("2026-12-20T23:00:00.000Z");
const NEW = "2026-12-27T23:00:00.000Z";
const AT = new Date("2026-11-21T09:15:00.000Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: E,
  studentId: S,
  previousDueAt: OLD,
  dueAt: new Date(NEW),
  reasonId: "justified",
  createdBy: T,
  createdAt: AT,
  earlierSubmissions: false,
  ...over,
});

function port(answer: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createDeadlineExtensions(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const input = { assignmentId: A, studentId: S, dueAt: NEW, reasonId: "justified" };

describe("add", () => {
  it("refuses bad input before the database", async () => {
    for (const bad of [
      { ...input, assignmentId: "nije-uuid" },
      { ...input, studentId: "NIJE" },
      { ...input, dueAt: "2026-12-27" },
      { ...input, dueAt: "2026-02-30T00:00:00.000Z" },
      { ...input, reasonId: "drugo" },
      { ...input, reasonId: "all" },
    ]) {
      const { port: p, seen } = port([row()]);
      expect(await p.add(TOKEN, bad)).toEqual({ status: "invalid_input" });
      expect(seen).toEqual([]);
    }
  });

  it("records an extension for one student and reads the row back", async () => {
    const { port: p, seen } = port([row()]);
    expect(await p.add(TOKEN, input)).toEqual({
      status: "added",
      extension: {
        id: E,
        scope: "one",
        studentId: S,
        previousDueAt: OLD.toISOString(),
        dueAt: NEW,
        reasonId: "justified",
        createdBy: T,
        createdAt: AT.toISOString(),
      },
      existingSubmissionsUnchanged: false,
    });
    expect(seen[0]!.text).toContain("institution.extend_assignment_deadline");
    expect(seen[0]!.values).toEqual([A, S, NEW, "justified"]);
  });

  it("records an extension for all students", async () => {
    const { port: p } = port([row({ studentId: null, reasonId: "all", earlierSubmissions: true })]);
    const result = await p.add(TOKEN, { ...input, studentId: null, reasonId: "all" });
    expect(result).toMatchObject({
      status: "added",
      extension: { scope: "all", studentId: null, reasonId: "all" },
      existingSubmissionsUnchanged: true,
    });
  });

  it("an answer that is not this extension throws, so the write rolls back", async () => {
    for (const bad of [[], [row(), row()], [row({ studentId: null })], [row({ dueAt: OLD })]]) {
      await expect(port(bad).port.add(TOKEN, input)).rejects.toThrow();
    }
  });

  it("maps the refusals of the database", async () => {
    expect(await port(sqlError("ZD401")).port.add(TOKEN, input)).toEqual({
      status: "unauthorized",
    });
    expect(await port(sqlError("ZD403")).port.add(TOKEN, input)).toEqual({ status: "not_found" });
    expect(await port(sqlError("ZD422")).port.add(TOKEN, input)).toEqual({
      status: "invalid_input",
    });
    await expect(port(sqlError("57014")).port.add(TOKEN, input)).rejects.toThrow();
  });
});

describe("list", () => {
  it("lists the extensions; a reason may be null", async () => {
    const { port: p, seen } = port([row({ reasonId: null })]);
    const result = await p.list(TOKEN, A);
    expect(result).toMatchObject({ status: "read", extensions: [{ id: E, reasonId: null }] });
    expect(seen[0]!.values).toEqual([A]);
  });

  it("a malformed id is not_found and never sent", async () => {
    const { port: p, seen } = port([]);
    expect(await p.list(TOKEN, "nije-uuid")).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });

  it("a row it cannot vouch for throws; refusals are outcomes", async () => {
    await expect(port([row({ reasonId: "drugo" })]).port.list(TOKEN, A)).rejects.toThrow();
    expect(await port(sqlError("ZD403")).port.list(TOKEN, A)).toEqual({ status: "not_found" });
    expect(await port(sqlError("ZD401")).port.list(TOKEN, A)).toEqual({ status: "unauthorized" });
  });
});
