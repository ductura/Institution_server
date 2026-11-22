// SRV-1111: the port of the faculty thresholds over a fake withActor. Refusals
// are outcomes, a row of an unexpected shape is unavailable, and the comparison
// answers only the three words. All values are invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createFacultyThresholds } from "./index.ts";

const TOKEN = "izmisljeni-token-administratora-00000000001";

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
  return { port: createFacultyThresholds(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("faculty thresholds port", () => {
  it("reads the thresholds in order, with numeric strings turned into numbers", async () => {
    const { port: thresholds } = port([
      { kind: "assistant_inserted", thresholdPercent: "10.0", strictness: "hard" },
      { kind: "pasted_unknown", thresholdPercent: "15.0", strictness: "soft" },
    ]);
    expect(await thresholds.read(TOKEN)).toEqual({
      status: "ok",
      thresholds: [
        { origin: "assistant_inserted", thresholdPercent: 10, strictness: "hard" },
        { origin: "pasted_unknown", thresholdPercent: 15, strictness: "soft" },
      ],
    });
  });

  it("reads an empty list while nothing is written (no defaults)", async () => {
    expect(await port([]).port.read(TOKEN)).toEqual({ status: "ok", thresholds: [] });
  });

  it("sets the threshold of one kind and says whether it changed", async () => {
    const { port: thresholds, seen } = port([{ changed: true }]);
    const result = await thresholds.put(TOKEN, {
      origin: "pasted_unknown",
      thresholdPercent: 15.5,
      strictness: "hard",
    });
    expect(result).toEqual({ status: "ok", changed: true });
    expect(seen[0]!.values).toEqual(["pasted_unknown", 15.5, "hard"]);
  });

  it("clears the threshold of one kind", async () => {
    const { port: thresholds, seen } = port([{ changed: false }]);
    expect(await thresholds.clear(TOKEN, "typed")).toEqual({ status: "ok", changed: false });
    expect(seen[0]!.values).toEqual(["typed"]);
  });

  it("compares a work and answers only the three words", async () => {
    const { port: thresholds, seen } = port([
      { kind: "assistant_inserted", status: "exceeded" },
      { kind: "pasted_unknown", status: "for_review" },
    ]);
    expect(await thresholds.compare(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "ok",
      comparison: [
        { origin: "assistant_inserted", state: "exceeded" },
        { origin: "pasted_unknown", state: "for_review" },
      ],
    });
    expect(seen[0]!.values).toEqual(["izmisljeni-rad-0001"]);
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    const { port: thresholds } = port(sqlError(code));
    expect(await thresholds.read(TOKEN)).toEqual({ status });
    expect(
      await thresholds.put(TOKEN, { origin: "typed", thresholdPercent: 1, strictness: "soft" }),
    ).toEqual({ status });
    expect(await thresholds.clear(TOKEN, "typed")).toEqual({ status });
    expect(await thresholds.compare(TOKEN, "izmisljeni-rad-0001")).toEqual({ status });
  });

  it.each([
    [
      "a kind out of order",
      [
        { kind: "pasted_unknown", status: "in_line" },
        { kind: "typed", status: "in_line" },
      ],
    ],
    [
      "a repeated kind",
      [
        { kind: "typed", status: "in_line" },
        { kind: "typed", status: "in_line" },
      ],
    ],
    ["a word outside the three", [{ kind: "typed", status: "suspect" }]],
    ["an unknown kind", [{ kind: "dictated", status: "in_line" }]],
  ])("answers unavailable for the comparison with %s", async (_name, rows) => {
    expect(await port(rows).port.compare(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "unavailable",
    });
  });

  it.each([
    ["a threshold above 100", [{ kind: "typed", thresholdPercent: 101, strictness: "soft" }]],
    ["a strictness outside the list", [{ kind: "typed", thresholdPercent: 5, strictness: "firm" }]],
    [
      "a threshold that is not a number",
      [{ kind: "typed", thresholdPercent: "x", strictness: "soft" }],
    ],
  ])("answers unavailable for the thresholds with %s", async (_name, rows) => {
    expect(await port(rows).port.read(TOKEN)).toEqual({ status: "unavailable" });
  });

  it.each([[[]], [[{ changed: 7 }]], [[{ changed: "true" }]]])(
    "answers unavailable for a write answer of an unexpected shape",
    async (rows) => {
      expect(await port(rows).port.clear(TOKEN, "typed")).toEqual({ status: "unavailable" });
    },
  );
});
