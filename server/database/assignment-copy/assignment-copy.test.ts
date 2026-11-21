// SRV-1904: the port of copying an assignment over a fake withActor. The input
// is checked before the database, the answer is confirmed inside the
// transaction, and ZD401, ZD403, ZD409 and ZD422 are outcomes. Every id and
// date below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createAssignmentCopy } from "./assignment-copy.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const C = "00000000-0000-4000-8000-0000000000b2";
const K = "00000000-0000-4000-8000-000000190401";
const NEW = "00000000-0000-4000-8000-000000190402";
const input = { assignmentId: A, courseId: C, requestKey: K, opensAt: null, dueAt: null };

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
  return { port: createAssignmentCopy(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("copy", () => {
  it("copies through the RPC with the session's token", async () => {
    const { port: p, seen } = port([{ id: NEW }]);
    expect(await p.copy(TOKEN, input)).toEqual({ status: "copied", id: NEW });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("institution.copy_assignment(");
    expect(seen[0]?.values).toEqual([A, C, K, null, null]);
  });

  it("passes new dates", async () => {
    const { port: p, seen } = port([{ id: NEW }]);
    const dates = { opensAt: "2027-10-01T08:00:00.000Z", dueAt: "2027-12-15T23:00:00.000Z" };
    expect(await p.copy(TOKEN, { ...input, ...dates })).toEqual({ status: "copied", id: NEW });
    expect(seen[0]?.values).toEqual([A, C, K, dates.opensAt, dates.dueAt]);
  });

  it("answers a malformed assignment or course as not found, before the database", async () => {
    for (const bad of [
      { ...input, assignmentId: "nije-uuid" },
      { ...input, courseId: A.toUpperCase() },
    ]) {
      const { port: p, seen } = port([{ id: NEW }]);
      expect(await p.copy(TOKEN, bad)).toEqual({ status: "not_found" });
      expect(seen).toHaveLength(0);
    }
  });

  it("refuses bad input before the database", async () => {
    for (const bad of [
      { ...input, requestKey: "nije-uuid" },
      { ...input, opensAt: "2027-10-01" },
      { ...input, dueAt: "2027-02-30T00:00:00.000Z" },
      { ...input, opensAt: "2027-12-15T23:00:00.000Z", dueAt: "2027-12-15T23:00:00.000Z" },
      { ...input, opensAt: "2027-12-16T00:00:00.000Z", dueAt: "2027-12-15T23:00:00.000Z" },
    ]) {
      const { port: p, seen } = port([{ id: NEW }]);
      expect(await p.copy(TOKEN, bad)).toEqual({ status: "invalid_input" });
      expect(seen).toHaveLength(0);
    }
  });

  it("turns the database's refusals into outcomes", async () => {
    for (const [code, status] of [
      ["ZD401", "unauthorized"],
      ["ZD403", "not_found"],
      ["ZD409", "conflict"],
      ["ZD422", "invalid_input"],
    ] as const) {
      expect(await port(sqlError(code)).port.copy(TOKEN, input)).toEqual({ status });
    }
  });

  it("throws anything else, and an answer that is not one id", async () => {
    await expect(port(sqlError("XX000")).port.copy(TOKEN, input)).rejects.toThrow();
    await expect(port([]).port.copy(TOKEN, input)).rejects.toThrow("unconfirmed assignment copy");
    await expect(port([{ id: "NIJE" }]).port.copy(TOKEN, input)).rejects.toThrow(
      "unconfirmed assignment copy",
    );
    await expect(port([{ id: NEW }, { id: NEW }]).port.copy(TOKEN, input)).rejects.toThrow(
      "unconfirmed assignment copy",
    );
  });
});
