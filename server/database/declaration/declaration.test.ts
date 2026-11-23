// The port of the teacher's declaration requirement reads exactly one row of a
// boolean and a time or null; the database's refusals keep their meaning and
// anything else is unavailable, never a guess. All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createDeclarationRequirement } from "./index.ts";

function over(answer: () => unknown[]): { withActor: WithActor; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const withActor = (async (token: string, run: (tx: unknown) => unknown) =>
    run({
      async query(text: string, values: unknown[]) {
        seen.push([token, text, values]);
        const rows = answer();
        return { rows, rowCount: rows.length };
      },
    })) as unknown as WithActor;
  return { withActor, seen };
}
const ASSIGNMENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
/** A row as PostgreSQL names its columns. */
const row = (required: unknown, changedAt: unknown) =>
  Object.fromEntries([
    ["required", required],
    ["changed_at", changedAt],
  ]);
const AT = new Date("2026-11-23T10:00:00.000Z");

describe("createDeclarationRequirement", () => {
  it("reads and sets through the teacher's two RPCs", async () => {
    const { withActor, seen } = over(() => [row(true, AT)]);
    const port = createDeclarationRequirement(withActor);
    expect(await port.read("t", ASSIGNMENT)).toEqual({
      status: "ok",
      required: true,
      changedAt: "2026-11-23T10:00:00.000Z",
    });
    expect(await port.set("t", ASSIGNMENT, false)).toMatchObject({ status: "ok" });
    expect(seen).toEqual([
      [
        "t",
        "SELECT required, changed_at FROM institution.declaration_requirement($1)",
        [ASSIGNMENT],
      ],
      [
        "t",
        "SELECT required, changed_at FROM institution.set_declaration_required($1, $2)",
        [ASSIGNMENT, false],
      ],
    ]);
  });

  it("a switch never changed has no time", async () => {
    const port = createDeclarationRequirement(over(() => [row(false, null)]).withActor);
    expect(await port.read("t", ASSIGNMENT)).toEqual({
      status: "ok",
      required: false,
      changedAt: null,
    });
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("the database's %s is %s", async (code, status) => {
    const port = createDeclarationRequirement(
      over(() => {
        throw Object.assign(new Error("izmišljeno"), { code });
      }).withActor,
    );
    expect(await port.set("t", ASSIGNMENT, true)).toEqual({ status });
  });

  it.each([
    ["no row", []],
    ["two rows", [row(true, null), row(true, null)]],
    ["a text for the switch", [row("true", null)]],
    ["a text for the time", [row(true, "2026-11-23")]],
  ])("%s is unavailable", async (_name, rows) => {
    const port = createDeclarationRequirement(over(() => rows).withActor);
    expect(await port.read("t", ASSIGNMENT)).toEqual({ status: "unavailable" });
  });
});
