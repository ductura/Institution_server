// The gate adapter reads exactly one known answer; anything else is an error,
// never a pass (PRODUCT §5 rule 11). All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createSubmissionDeclarationGate } from "./index.ts";

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
