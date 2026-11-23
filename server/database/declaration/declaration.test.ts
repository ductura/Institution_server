// The gate adapter reads exactly one known answer; anything else is an error,
// never a pass (PRODUCT §5 rule 11). All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createDeclarationRequiredSwitch, createSubmissionDeclarationGate } from "./index.ts";

function over(rows: unknown[]): { withActor: WithActor; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const withActor = (async (token: string, run: (tx: unknown) => unknown) =>
    run({
      async query(text: string, values: unknown[]) {
        seen.push([token, text, values]);
        return { rows, rowCount: rows.length };
      },
    })) as unknown as WithActor;
  return { withActor, seen };
}

describe("createSubmissionDeclarationGate", () => {
  it.each(["proceed", "declaration_required"])("passes %s through", async (gate) => {
    const { withActor, seen } = over([{ gate }]);
    const read = createSubmissionDeclarationGate(withActor);
    expect(await read("izmisljeni-token", { documentId: "izmisljeni-rad", revision: 3 })).toBe(
      gate,
    );
    expect(seen).toEqual([
      [
        "izmisljeni-token",
        "SELECT declaration.submission_gate($1, $2) AS gate",
        ["izmisljeni-rad", 3],
      ],
    ]);
  });

  it.each([
    ["no row", []],
    ["two rows", [{ gate: "proceed" }, { gate: "proceed" }]],
    ["an unknown answer", [{ gate: "satisfied" }]],
    ["a null", [{ gate: null }]],
  ])("%s is an error, never a pass", async (_name, rows) => {
    const read = createSubmissionDeclarationGate(over(rows).withActor);
    await expect(read("t", { documentId: "d", revision: 1 })).rejects.toThrow(
      "Invalid submission gate response",
    );
  });
});

describe("createDeclarationRequiredSwitch", () => {
  const ID = "00000000-0000-4000-8000-0000000000a1";
  const at = new Date("2026-11-23T10:00:00.000Z");

  it("reads and sets the switch, the instant as ISO text", async () => {
    const { withActor, seen } = over([{ required: true, changedAt: at }]);
    const port = createDeclarationRequiredSwitch(withActor);
    const read = { status: "read", required: true, changedAt: "2026-11-23T10:00:00.000Z" };
    expect(await port.read("t", ID)).toEqual(read);
    expect(await port.set("t", ID, true)).toEqual(read);
    expect(seen.map(([, , values]) => values)).toEqual([[ID], [ID, true]]);
  });

  it("never changed reads a null instant", async () => {
    const port = createDeclarationRequiredSwitch(
      over([{ required: false, changedAt: null }]).withActor,
    );
    expect(await port.read("t", ID)).toEqual({ status: "read", required: false, changedAt: null });
  });

  it("a malformed id is not_found without the database", async () => {
    const { withActor, seen } = over([]);
    const port = createDeclarationRequiredSwitch(withActor);
    expect(await port.read("t", "nije-uuid")).toEqual({ status: "not_found" });
    expect(await port.set("t", ID.toUpperCase(), true)).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_input" }],
  ])("%s is an outcome", async (code, outcome) => {
    const withActor = (async () => {
      throw Object.assign(new Error("izmišljeno"), { code });
    }) as unknown as WithActor;
    const port = createDeclarationRequiredSwitch(withActor);
    expect(await port.read("t", ID)).toEqual(outcome);
    expect(await port.set("t", ID, false)).toEqual(outcome);
  });

  it.each([
    ["no row", []],
    ["a value that is not boolean", [{ required: "da", changedAt: null }]],
    ["an instant that is not a date", [{ required: true, changedAt: "jučer" }]],
  ])("%s is an error", async (_name, rows) => {
    const port = createDeclarationRequiredSwitch(over(rows).withActor);
    await expect(port.read("t", ID)).rejects.toThrow("Invalid declaration switch response");
  });

  it("a set the database does not confirm is an error, so the write rolls back", async () => {
    const port = createDeclarationRequiredSwitch(
      over([{ required: false, changedAt: null }]).withActor,
    );
    await expect(port.set("t", ID, true)).rejects.toThrow("Unconfirmed declaration switch");
  });
});
