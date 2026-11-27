import { describe, expect, it } from "vitest";

import { createSubmissionReconstructionPort } from "./submission-reconstruction.ts";
import type { WithActor } from "./with-actor.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";

function port(rows: unknown[] | Error) {
  const sent: unknown[][] = [];
  const withActor: WithActor = async (token, fn) => {
    if (rows instanceof Error) throw rows;
    return fn({
      async query(_text, values) {
        sent.push([token, ...(values ?? [])]);
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
  };
  return { port: createSubmissionReconstructionPort(withActor), sent };
}

describe("the student's read of the reconstruction state (F4-PM2-R01)", () => {
  it.each(["pending", "verified", "mismatch"])("reads %s", async (state) => {
    const { port: p, sent } = port([{ outcome: "found", state }]);
    expect(await p.read("t", ID)).toEqual({ status: "read", state });
    expect(sent).toEqual([["t", ID]]);
  });

  it("not_found with no state is not_found", async () => {
    expect(await port([{ outcome: "not_found", state: null }]).port.read("t", ID)).toEqual({
      status: "not_found",
    });
  });

  it("an id that is not a lowercase uuid is never sent", async () => {
    const { port: p, sent } = port([{ outcome: "found", state: "pending" }]);
    expect(await p.read("t", ID.toUpperCase())).toEqual({ status: "not_found" });
    expect(await p.read("t", "nije-uuid")).toEqual({ status: "not_found" });
    expect(sent).toEqual([]);
  });

  it("ZD401 is unauthorized, any other fault throws", async () => {
    const noSession = Object.assign(new Error("not authenticated"), { code: "ZD401" });
    expect(await port(noSession).port.read("t", ID)).toEqual({ status: "unauthorized" });
    await expect(port(new Error("izmišljen kvar")).port.read("t", ID)).rejects.toThrow();
  });

  it.each<[string, unknown[]]>([
    ["no row", []],
    [
      "two rows",
      [
        { outcome: "found", state: "pending" },
        { outcome: "found", state: "pending" },
      ],
    ],
    ["a state outside the three", [{ outcome: "found", state: "gotovo" }]],
    ["found without a state", [{ outcome: "found", state: null }]],
    ["an unknown outcome", [{ outcome: "ok", state: "pending" }]],
    ["not_found with a state", [{ outcome: "not_found", state: "pending" }]],
  ])("%s throws, so the route answers 503", async (_name, rows) => {
    await expect(port(rows).port.read("t", ID)).rejects.toThrow(
      "Invalid submission reconstruction",
    );
  });
});
