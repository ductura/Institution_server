// SRV-1809: the port of the transfer from an answer of the assistant maps the
// database answer and its codes, and never reads a row of an unexpected shape
// as a record. All values are invented.
import { describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createAiTransfers } from "./index.ts";

const TOKEN = "izmisljeni-token-rada-000000000000000000001";
const ROW = {
  transferId: "00000000-0000-4000-8000-0000000000a1",
  recordSha256: "a".repeat(64),
  recordText: '{"transferSchema":"ductus-ai-transfer-v1"}',
};
const dbError = (code: string) => Object.assign(new Error(code), { code });

function portWith(query: (...args: unknown[]) => Promise<unknown>) {
  const withActor: WithActor = (token, run) =>
    run({
      query: (sql: string, params: unknown[]) => query(token, sql, params),
    } as unknown as ActorTransaction);
  return createAiTransfers(withActor);
}

describe("ai transfer port", () => {
  it("calls the function with the work, the answer and the text, and reads the row", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [ROW] });
    const out = await portWith(query).create(TOKEN, "izmisljeni-rad-0001", ROW.transferId, "Lorem");
    expect(out).toEqual({ status: "ok", ...ROW });
    expect(query).toHaveBeenCalledWith(
      TOKEN,
      expect.stringContaining("assistant.create_ai_transfer($1, $2::uuid, $3)"),
      ["izmisljeni-rad-0001", ROW.transferId, "Lorem"],
    );
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["ZD409", "unavailable"],
    ["57014", "unavailable"],
  ])("%s is %s", async (code, status) => {
    const query = vi.fn(async () => {
      throw dbError(code);
    });
    expect(
      await portWith(query).create(TOKEN, "izmisljeni-rad-0001", ROW.transferId, "Lorem"),
    ).toEqual({ status });
  });

  it.each([
    ["no row", []],
    ["two rows", [ROW, ROW]],
    ["an id that is not a uuid", [{ ...ROW, transferId: "nije-uuid" }]],
    ["a hash that is not hex", [{ ...ROW, recordSha256: "Z".repeat(64) }]],
    ["an empty record", [{ ...ROW, recordText: "" }]],
    ["a record that is not text", [{ ...ROW, recordText: 1 }]],
  ])("%s is unavailable", async (_name, rows) => {
    const query = vi.fn().mockResolvedValue({ rows });
    expect(
      await portWith(query).create(TOKEN, "izmisljeni-rad-0001", ROW.transferId, "Lorem"),
    ).toEqual({ status: "unavailable" });
  });
});
