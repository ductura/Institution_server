// SRV-1314: the port of event amendments and disputes over a fake withActor.
// The input is checked before the database, the written row is confirmed
// inside the transaction, and ZD401, ZD403 and ZD422 are outcomes. Every id,
// date and text below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createEventDisputes } from "./event-disputes.ts";

const TOKEN = "izmisljeni-token-studenta-0000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000e1";
const D = "00000000-0000-4000-8000-0000000000d1";
const AT = new Date("2026-11-21T09:15:00.000Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: D,
  kind: "dispute",
  eventId: "pastes/0",
  text: "Lijepljenje je iz mojih bilješki.",
  createdAt: AT,
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
  return { port: createEventDisputes(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const input = {
  assignmentId: A,
  kind: "dispute",
  eventId: "pastes/0",
  text: "Lijepljenje je iz mojih bilješki.",
};

describe("add", () => {
  it("refuses bad input before the database", async () => {
    for (const bad of [
      { ...input, assignmentId: "nije-uuid" },
      { ...input, assignmentId: A.toUpperCase() },
      { ...input, kind: "note" },
      { ...input, kind: "Dispute" },
      { ...input, eventId: "" },
      { ...input, eventId: "Pastes/0" },
      { ...input, eventId: "0/pastes" },
      { ...input, eventId: "pastes 0" },
      { ...input, eventId: `a${"b".repeat(128)}` },
      { ...input, text: "" },
      { ...input, text: " \n\t " },
      { ...input, text: "a".repeat(1001) },
      { ...input, text: "🌱".repeat(1001) },
    ]) {
      const { port: p, seen } = port([row()]);
      expect(await p.add(TOKEN, bad)).toEqual({ status: "invalid_input" });
      expect(seen).toEqual([]);
    }
  });

  it("counts code points, as the database does", async () => {
    const text = "🌱".repeat(1000);
    const { port: p } = port([row({ text })]);
    expect(await p.add(TOKEN, { ...input, text })).toMatchObject({ status: "added" });
  });

  it("adds a record through the RPC and reads the row back", async () => {
    const { port: p, seen } = port([row()]);
    expect(await p.add(TOKEN, input)).toEqual({
      status: "added",
      record: {
        id: D,
        kind: "dispute",
        eventId: "pastes/0",
        text: input.text,
        createdAt: AT.toISOString(),
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain(
      "FROM app.add_event_dispute($1::uuid, $2::text, $3::text, $4::text)",
    );
    expect(seen[0]!.values).toEqual([A, "dispute", "pastes/0", input.text]);
  });

  it("adds an amendment", async () => {
    const amendment = { ...input, kind: "amendment", eventId: "sessions/1" };
    const { port: p } = port([row({ kind: "amendment", eventId: "sessions/1" })]);
    expect(await p.add(TOKEN, amendment)).toMatchObject({
      status: "added",
      record: { kind: "amendment", eventId: "sessions/1" },
    });
  });

  it("an answer that is not this record throws, so the write rolls back", async () => {
    for (const bad of [
      [],
      [row(), row()],
      [row({ kind: "amendment" })],
      [row({ eventId: "gaps/0" })],
      [row({ text: "Drugi tekst" })],
      [row({ id: "nije-uuid" })],
      [row({ createdAt: "2026-11-21" })],
    ]) {
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
  it("reads the caller's own records with a null student", async () => {
    const { port: p, seen } = port([row(), row({ id: S, kind: "amendment" })]);
    const result = await p.list(TOKEN, A);
    expect(result).toMatchObject({
      status: "read",
      records: [
        { id: D, kind: "dispute" },
        { id: S, kind: "amendment" },
      ],
    });
    expect(seen[0]!.text).toContain(
      "FROM app.event_disputes($1::uuid, $2::uuid) ORDER BY created_at, id",
    );
    expect(seen[0]!.values).toEqual([A, null]);
  });

  it("names the student for a reader of the work", async () => {
    const { port: p, seen } = port([]);
    expect(await p.list(TOKEN, A, S)).toEqual({ status: "read", records: [] });
    expect(seen[0]!.values).toEqual([A, S]);
  });

  it("a malformed id is not_found and never sent", async () => {
    for (const [assignment, student] of [
      ["nije-uuid", null],
      [A, "nije-uuid"],
    ] as const) {
      const { port: p, seen } = port([]);
      expect(await p.list(TOKEN, assignment, student)).toEqual({ status: "not_found" });
      expect(seen).toEqual([]);
    }
  });

  it("a row it cannot vouch for throws; refusals are outcomes", async () => {
    await expect(port([row({ kind: "note" })]).port.list(TOKEN, A)).rejects.toThrow();
    await expect(port([row({ text: "" })]).port.list(TOKEN, A)).rejects.toThrow();
    expect(await port(sqlError("ZD403")).port.list(TOKEN, A, S)).toEqual({ status: "not_found" });
    expect(await port(sqlError("ZD401")).port.list(TOKEN, A)).toEqual({ status: "unauthorized" });
    await expect(port(sqlError("57014")).port.list(TOKEN, A)).rejects.toThrow();
  });
});
