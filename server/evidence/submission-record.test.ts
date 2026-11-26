import { describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/with-actor.ts";
import { InMemoryEvidencePayloadStore } from "../external/storage/in-memory-evidence-payload-store.ts";

import { sheetRevisionZeroDocument } from "../domain/index.ts";

// SRV-V14-SHEET-SUBMIT: a test may replace the sheet reconstruction once; by default the real one runs.
const sheetOverride = vi.hoisted(() => ({ next: null as null | (() => unknown) }));
vi.mock("./submission-reconstruction.ts", async (original) => {
  const real = await original<typeof import("./submission-reconstruction.ts")>();
  return {
    ...real,
    reconstructSheetSubmission: (...args: Parameters<typeof real.reconstructSheetSubmission>) => {
      const fake = sheetOverride.next;
      sheetOverride.next = null;
      return fake ? fake() : real.reconstructSheetSubmission(...args);
    },
  };
});

import { reconstructSubmissionRecord } from "./submission-record.ts";

// Invented ids and hashes. The record below is well formed but has no stored
// bytes, so a reconstruction of it ends in `mismatch` (missing payload): what
// is tested here is only how rows become a record or a closed fault.
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const ROW = {
  outcome: "found",
  institution_id: "00000000-0000-4000-8000-0000000000a1",
  evidence_package_id: "pkg-1",
  evidence_domain_id: "00000000-0000-4000-8000-0000000000d1",
  document_id: "doc-1",
  principal_id: "00000000-0000-4000-8000-0000000000e1",
  revision: "2",
  content_hash: "d".repeat(64),
  head_segment_hash: "c".repeat(64),
  segment_count: 2,
  segments: [
    { segmentHash: "b".repeat(64), receiptPayload: "{}", signature: { algorithm: "Ed25519" } },
    { segmentHash: "c".repeat(64), receiptPayload: "{}", signature: null },
  ],
};

function database(
  rows: unknown[],
  options: { fail?: boolean; keys?: unknown[]; kind?: unknown[] } = {},
) {
  const ran: string[] = [];
  const withActor: WithActor = async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text) {
        const which = text.includes("read_submission_record")
          ? "record"
          : text.includes("document_kind")
            ? "kind"
            : "keys";
        ran.push(which);
        if (options.fail) throw new Error("connection reset: secret detail");
        const result = (
          which === "record"
            ? rows
            : which === "kind"
              ? (options.kind ?? [{ document_kind: "text" }])
              : (options.keys ?? [])
        ) as never[];
        return { rows: result, rowCount: result.length };
      },
    };
    return fn(tx);
  };
  return { withActor, ran };
}

const run = (
  rows: unknown[],
  options?: { fail?: boolean; keys?: unknown[]; kind?: unknown[] },
  request = REQUEST,
) => {
  const db = database(rows, options);
  return reconstructSubmissionRecord(
    { withActor: db.withActor, payloads: new InMemoryEvidencePayloadStore() },
    "t",
    request,
  ).then((result) => ({ result, ran: db.ran }));
};

describe("submission record read (B-12 step 4b1)", () => {
  it("turns the found row into the record, with a pending acceptance as no receipt, and reads the keys in the same transaction", async () => {
    const { result, ran } = await run([ROW]);
    expect(ran).toEqual(["record", "keys", "kind"]);
    expect(result).toMatchObject({
      status: "reconstructed",
      record: {
        revision: 2,
        head: { segmentHash: "c".repeat(64), segmentCount: 2 },
        segments: [
          {
            segmentHash: "b".repeat(64),
            receipt: { receiptPayload: "{}", signature: { algorithm: "Ed25519" } },
          },
          { segmentHash: "c".repeat(64), receipt: null },
        ],
      },
      outcome: { status: "mismatch", reason: "missing_payload", index: 0 },
    });
  });

  it.each(["unauthenticated", "not_found"])(
    "passes %s through and reads no key",
    async (outcome) => {
      const { result, ran } = await run([{ ...ROW, outcome }]);
      expect(result).toEqual({ status: outcome });
      expect(ran).toEqual(["record"]);
    },
  );

  it("answers a request id that is not a UUID as not found, without a query", async () => {
    const { result, ran } = await run([ROW], {}, "pkg-1");
    expect(result).toEqual({ status: "not_found" });
    expect(ran).toEqual([]);
  });

  it.each<[string, unknown[], string]>([
    ["an unavailable record", [{ ...ROW, outcome: "unavailable" }], "record_unavailable"],
    ["no row", [], "record_malformed"],
    ["two rows", [ROW, ROW], "record_malformed"],
    ["an unknown outcome", [{ ...ROW, outcome: "ok" }], "record_malformed"],
    ["revision 0", [{ ...ROW, revision: "0" }], "record_malformed"],
    ["a count other than the listing", [{ ...ROW, segment_count: 3 }], "record_malformed"],
    ["an upper-case hash", [{ ...ROW, content_hash: "D".repeat(64) }], "record_malformed"],
    [
      "a listed segment with a fourth key",
      [{ ...ROW, segments: [{ ...ROW.segments[0], extra: 1 }, ROW.segments[1]] }],
      "record_malformed",
    ],
    [
      "a signature that is not an object",
      [{ ...ROW, segments: [{ ...ROW.segments[0], signature: "x" }, ROW.segments[1]] }],
      "record_malformed",
    ],
    [
      "receipt text that is not text",
      [{ ...ROW, segments: [{ ...ROW.segments[0], receiptPayload: {} }, ROW.segments[1]] }],
      "record_malformed",
    ],
    ["a domain that is not a UUID", [{ ...ROW, evidence_domain_id: "domain" }], "record_malformed"],
  ])("answers %s as unavailable, never a reconstruction", async (_name, rows, code) => {
    const { result } = await run(rows);
    expect(result).toEqual({ status: "unavailable", stage: "record", code });
  });

  it("reads the kind of the work and reconstructs a spreadsheet with the sheet replay, which finds no stored bytes here", async () => {
    const { result } = await run([ROW], { kind: [{ document_kind: "spreadsheet" }] });
    expect(result).toMatchObject({
      status: "reconstructed",
      documentKind: "spreadsheet",
      outcome: { status: "mismatch", reason: "missing_payload" },
    });
  });

  it.each([[[]], [[{ document_kind: "text" }, { document_kind: "text" }]]])(
    "answers a kind read that is not exactly one row as unavailable",
    async (kind) => {
      const { result } = await run([ROW], { kind });
      expect(result).toEqual({ status: "unavailable", stage: "record", code: "record_malformed" });
    },
  );

  it("answers a key row of an unexpected form as unavailable", async () => {
    const { result } = await run([ROW], { keys: [{ key_id: "k" }] });
    expect(result).toEqual({
      status: "unavailable",
      stage: "record",
      code: "domain_keys_unavailable",
    });
  });

  it("answers a failed query with a closed code, no message", async () => {
    const { result } = await run([ROW], { fail: true });
    expect(result).toEqual({ status: "unavailable", stage: "record", code: "record_failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  describe("a spreadsheet work after the reconstruction (SRV-V14-SHEET-SUBMIT)", () => {
    const MATCH = {
      status: "match",
      head: { segmentHash: "c".repeat(64) },
      documentSha256: "d".repeat(64),
    };
    const sheetRun = (log: (...codes: string[]) => void) => {
      const db = database([ROW], { kind: [{ document_kind: "spreadsheet" }] });
      return reconstructSubmissionRecord(
        { withActor: db.withActor, payloads: new InMemoryEvidencePayloadStore(), log },
        "t",
        REQUEST,
      );
    };

    it("keeps the match and logs only the mark, never a result", async () => {
      sheetOverride.next = () => ({ outcome: MATCH, document: sheetRevisionZeroDocument() });
      const log = vi.fn();
      expect(await sheetRun(log)).toMatchObject({
        documentKind: "spreadsheet",
        outcome: { status: "match" },
      });
      expect(log).toHaveBeenCalledWith("submission", "calculation", "aligned");
    });

    it("blocks a match whose document is no valid spreadsheet document", async () => {
      sheetOverride.next = () => ({ outcome: MATCH, document: { schemaVersion: 1, nodes: [] } });
      const log = vi.fn();
      expect(await sheetRun(log)).toMatchObject({
        outcome: { status: "mismatch", reason: "target_mismatch" },
      });
      expect(log).not.toHaveBeenCalled();
    });

    it("does not check a record that did not match", async () => {
      sheetOverride.next = () => ({ outcome: { status: "no_evidence" }, document: null });
      const log = vi.fn();
      expect(await sheetRun(log)).toMatchObject({ outcome: { status: "no_evidence" } });
      expect(log).not.toHaveBeenCalled();
    });
  });
});
