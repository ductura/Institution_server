// SRV-0910: the port of the composition by kind of origin over a fake withActor.
// Refusals are outcomes, a row of an unexpected shape is unavailable, and the
// answer has the six kinds in the order of the list and nothing else. All
// values are invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createOriginKind, ORIGIN_KINDS } from "./index.ts";

const TOKEN = "izmisljeni-token-studenta-0000000000000001";
const ID = "00000000-0000-4000-8000-0000000000c1";

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
  return { port: createOriginKind(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const six = (percents: (string | number)[]) =>
  ORIGIN_KINDS.map((kind, index) => ({ kind, percent: percents[index] }));

describe("origin composition port", () => {
  it("returns the six kinds in order, with numeric strings turned into numbers", async () => {
    const { port: origin, seen } = port(six(["60.0", "20.0", "0.0", "10.0", "0.0", "10.0"]));
    const result = await origin.composition(TOKEN, "izmisljeni-rad-0001");
    expect(result).toEqual({
      status: "ok",
      parts: six([60, 20, 0, 10, 0, 10]),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.values).toEqual(["izmisljeni-rad-0001"]);
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    const { port: origin } = port(sqlError(code));
    expect(await origin.composition(TOKEN, "izmisljeni-rad-0001")).toEqual({ status });
  });

  it.each([
    ["five rows", six([0, 0, 0, 0, 0, 0]).slice(0, 5)],
    ["a kind out of order", [...six([0, 0, 0, 0, 0, 0])].reverse()],
    ["a share above 100", six([101, 0, 0, 0, 0, 0])],
    ["a share that is not a number", six(["x", 0, 0, 0, 0, 0])],
  ])("answers unavailable for %s", async (_name, rows) => {
    const { port: origin } = port(rows);
    expect(await origin.composition(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "unavailable",
    });
  });

  it("records a change and explains a paste through the RPCs", async () => {
    const recorded = port([{ id: ID }]);
    expect(await recorded.port.record(TOKEN, "izmisljeni-rad-0001", "typed", 12)).toEqual({
      status: "ok",
      id: ID,
    });
    expect(recorded.seen[0]!.values).toEqual(["izmisljeni-rad-0001", "typed", 12]);
    const explained = port([{ explained: true }]);
    expect(await explained.port.explain(TOKEN, "izmisljeni-rad-0001", ID)).toEqual({
      status: "ok",
      explained: true,
    });
    const bad = port([{ id: "nije-uuid" }]);
    expect(await bad.port.record(TOKEN, "izmisljeni-rad-0001", "typed", 12)).toEqual({
      status: "unavailable",
    });
  });
});
