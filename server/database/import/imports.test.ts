// The port of an import (SRV-1803) over a scripted transaction: the SQL and
// parameters each call sends, the mapping of rows, and the closed statuses for
// database errors and rows of an unexpected shape. The database itself is
// db/main/tests/208-import-event.sql.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createImports } from "./imports.ts";

const AT = new Date("2026-11-21T09:00:00.000Z");
const IMPORT_ID = "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c";
const EVENT_ID = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const HASH = "4f".repeat(32);

type Row = Record<string, unknown>;
function scripted(results: (Row[] | Error)[]) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const withActor = (async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        const next = results.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next, rowCount: next.length };
      },
    } as never)) as WithActor;
  return { port: createImports(withActor), calls };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });

describe("createImports.gate", () => {
  it("asks the gate RPC with the work only", async () => {
    const run = scripted([[{ outcome: "allowed" }]]);
    expect(await run.port.gate("t", "doc-a")).toEqual({ status: "allowed" });
    expect(run.calls).toEqual([
      { text: "SELECT outcome FROM collaboration.import_gate($1)", values: ["doc-a"] },
    ]);
    expect(await scripted([[{ outcome: "not_allowed" }]]).port.gate("t", "d")).toEqual({
      status: "not_allowed",
    });
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["57014", "unavailable"],
  ])("maps %s to %s, never the message", async (code, status) => {
    expect(await scripted([dbError(code)]).port.gate("t", "d")).toEqual({ status });
  });

  it("is unavailable for a row of another shape", async () => {
    expect(await scripted([[{ outcome: "maybe" }]]).port.gate("t", "d")).toEqual({
      status: "unavailable",
    });
    expect(await scripted([[]]).port.gate("t", "d")).toEqual({ status: "unavailable" });
  });
});

describe("createImports.prepare", () => {
  const input = {
    documentId: "doc-a",
    importId: IMPORT_ID,
    manifest: "{}",
    manifestSha256: HASH,
    fileName: null,
  };
  it("sends the manifest, its hash and the name, never an owner, revision or time", async () => {
    const run = scripted([[{ outcome: "prepared", baseRevision: "7", preparedAt: AT }]]);
    expect(await run.port.prepare("t", input)).toEqual({
      status: "prepared",
      baseRevision: 7,
      preparedAt: AT.toISOString(),
    });
    expect(run.calls[0]!.text).toContain("collaboration.prepare_import($1, $2, $3, $4, $5)");
    expect(run.calls[0]!.values).toEqual(["doc-a", IMPORT_ID, "{}", HASH, null]);
  });

  it("answers not_allowed, and unavailable for a bad revision or time", async () => {
    expect(
      await scripted([
        [{ outcome: "not_allowed", baseRevision: null, preparedAt: null }],
      ]).port.prepare("t", input),
    ).toEqual({ status: "not_allowed" });
    expect(
      await scripted([[{ outcome: "prepared", baseRevision: "-1", preparedAt: AT }]]).port.prepare(
        "t",
        input,
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      await scripted([
        [{ outcome: "prepared", baseRevision: 1, preparedAt: "jučer" }],
      ]).port.prepare("t", input),
    ).toEqual({ status: "unavailable" });
    expect(await scripted([dbError("ZD422")]).port.prepare("t", input)).toEqual({
      status: "invalid",
    });
  });
});

describe("createImports.confirm", () => {
  it("returns the one event for a confirmation and its retry", async () => {
    const run = scripted([
      [{ outcome: "confirmed", eventId: EVENT_ID }],
      [{ outcome: "already-confirmed", eventId: EVENT_ID }],
    ]);
    expect(await run.port.confirm("t", "doc-a", IMPORT_ID, HASH)).toEqual({
      status: "confirmed",
      eventId: EVENT_ID,
    });
    expect(await run.port.confirm("t", "doc-a", IMPORT_ID, HASH)).toEqual({
      status: "already-confirmed",
      eventId: EVENT_ID,
    });
    expect(run.calls[0]).toEqual({
      text: 'SELECT outcome, event_id AS "eventId" FROM collaboration.confirm_import($1, $2, $3)',
      values: ["doc-a", IMPORT_ID, HASH],
    });
  });

  it.each(["NOT_FOUND", "MANIFEST_MISMATCH", "EXPIRED", "IMPORT_NOT_ALLOWED", "REVISION_CHANGED"])(
    "passes the contract code %s through",
    async (code) => {
      expect(
        await scripted([[{ outcome: code, eventId: null }]]).port.confirm(
          "t",
          "d",
          IMPORT_ID,
          HASH,
        ),
      ).toEqual({ status: "rejected", code });
    },
  );

  it("is unavailable for an unknown outcome, a missing event or a rejection with an event", async () => {
    for (const row of [
      { outcome: "done", eventId: EVENT_ID },
      { outcome: "confirmed", eventId: null },
      { outcome: "EXPIRED", eventId: EVENT_ID },
    ]) {
      expect(await scripted([[row]]).port.confirm("t", "d", IMPORT_ID, HASH)).toEqual({
        status: "unavailable",
      });
    }
    expect(await scripted([dbError("ZD401")]).port.confirm("t", "d", IMPORT_ID, HASH)).toEqual({
      status: "unauthenticated",
    });
  });
});
