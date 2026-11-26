import { describe, expect, it, vi } from "vitest";

import { InMemoryEvidencePayloadStore } from "../external/storage/in-memory-evidence-payload-store.ts";

// A test may replace the reconstruction once; by default the real one runs.
const override = vi.hoisted(() => ({ next: null as null | (() => unknown) }));
vi.mock("./submission-record.ts", async (original) => {
  const real = await original<typeof import("./submission-record.ts")>();
  return {
    ...real,
    reconstructRecordedSubmission: (
      ...args: Parameters<typeof real.reconstructRecordedSubmission>
    ) => {
      const fake = override.next;
      override.next = null;
      return fake ? fake() : real.reconstructRecordedSubmission(...args);
    },
  };
});

import { runSubmissionVerdictPass, type VerdictQuery } from "./submission-verdict.ts";

// Invented ids and hashes. The record is well formed but has no stored bytes,
// so the real reconstruction of it ends in `mismatch` (missing payload).
const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const SUB1 = "00000000-0000-4000-8000-0000000000f1";
const SUB2 = "00000000-0000-4000-8000-0000000000f2";
const RECORD = {
  outcome: "found",
  institution_id: "00000000-0000-4000-8000-0000000000a1",
  evidence_package_id: "pkg-1",
  evidence_domain_id: DOMAIN,
  document_id: "doc-1",
  principal_id: "00000000-0000-4000-8000-0000000000e1",
  revision: "2",
  content_hash: "d".repeat(64),
  head_segment_hash: "c".repeat(64),
  segment_count: 1,
  segments: [{ segmentHash: "c".repeat(64), receiptPayload: "{}", signature: null }],
  document_kind: "text",
};

type Options = {
  list?: unknown[];
  record?: unknown[];
  keep?: unknown[];
  failOn?: "list" | "record" | "keep";
};
function setup(options: Options = {}) {
  const calls: { kind: string; values: readonly unknown[] }[] = [];
  const query: VerdictQuery = async (text, values) => {
    const kind = text.includes("to_reconstruct")
      ? "list"
      : text.includes("worker_submission_record")
        ? "record"
        : "keep";
    calls.push({ kind, values });
    if (options.failOn === kind) throw new Error("connection reset: secret detail");
    const rows =
      kind === "list"
        ? (options.list ?? [{ submission_id: SUB1 }])
        : kind === "record"
          ? (options.record ?? [RECORD])
          : (options.keep ?? [{ outcome: "mismatch" }]);
    return { rows };
  };
  const readKeys = vi.fn(async () => ({ status: "ok" as const, keys: [] }));
  const run = (extra: Record<string, unknown> = {}) =>
    runSubmissionVerdictPass({
      query,
      evidenceDomainId: DOMAIN,
      payloads: new InMemoryEvidencePayloadStore(),
      readKeys,
      ...extra,
    });
  return { run, calls, readKeys };
}

describe("the worker's second reconstruction of a recorded submission (F4-PM2-R01)", () => {
  it("keeps NULL as the hash when the reconstruction does not match, and counts the database's verdict", async () => {
    const { run, calls } = setup();
    expect(await run()).toEqual({ listed: 1, verified: 0, mismatch: 1, unavailable: 0 });
    expect(calls.map((c) => c.kind)).toEqual(["list", "record", "keep"]);
    expect(calls[0]!.values).toEqual([DOMAIN, 100]);
    expect(calls[2]!.values).toEqual([DOMAIN, SUB1, null]);
  });

  it("hands the database the hash it reconstructed and counts verified only on its word", async () => {
    override.next = () => ({
      status: "match",
      head: { segmentHash: "c".repeat(64), segmentCount: 1 },
      documentSha256: "a".repeat(64),
    });
    const { run, calls } = setup({ keep: [{ outcome: "verified" }] });
    expect(await run()).toEqual({ listed: 1, verified: 1, mismatch: 0, unavailable: 0 });
    expect(calls[2]!.values).toEqual([DOMAIN, SUB1, "a".repeat(64)]);
  });

  it("a verdict that already exists changes no count", async () => {
    const { run } = setup({ keep: [{ outcome: "exists" }] });
    expect(await run()).toEqual({ listed: 1, verified: 0, mismatch: 0, unavailable: 0 });
  });

  it("nothing to reconstruct reads no key and no record", async () => {
    const { run, calls, readKeys } = setup({ list: [] });
    expect(await run()).toEqual({ listed: 0, verified: 0, mismatch: 0, unavailable: 0 });
    expect(calls.map((c) => c.kind)).toEqual(["list"]);
    expect(readKeys).not.toHaveBeenCalled();
  });

  it("an outage of the storage keeps no verdict", async () => {
    override.next = () => ({ status: "unavailable", stage: "storage", reason: "x" });
    const { run, calls } = setup();
    expect(await run()).toEqual({ listed: 1, verified: 0, mismatch: 0, unavailable: 1 });
    expect(calls.map((c) => c.kind)).toEqual(["list", "record"]);
  });

  it("a reconstruction that throws keeps no verdict", async () => {
    override.next = () => Promise.reject(new Error("izmišljen kvar"));
    const { run } = setup();
    expect(await run()).toMatchObject({ unavailable: 1, mismatch: 0, verified: 0 });
  });

  it("keys that are unavailable leave every submission for a later pass", async () => {
    const { run, calls, readKeys } = setup({
      list: [{ submission_id: SUB1 }, { submission_id: SUB2 }],
    });
    readKeys.mockResolvedValueOnce({ status: "unavailable", reason: "x" } as never);
    expect(await run()).toEqual({ listed: 2, verified: 0, mismatch: 0, unavailable: 2 });
    expect(calls.map((c) => c.kind)).toEqual(["list"]);
  });

  it.each<[string, Options]>([
    ["no record row", { record: [] }],
    ["a record that is not found", { record: [{ ...RECORD, outcome: "unavailable" }] }],
    ["a record of another form", { record: [{ ...RECORD, revision: "0" }] }],
    ["an unknown kind of work", { record: [{ ...RECORD, document_kind: "slides" }] }],
    ["a record that fails to read", { failOn: "record" }],
    ["a verdict the database refuses", { keep: [{ outcome: "not_found" }] }],
    ["a verdict write that fails", { failOn: "keep" }],
  ])("%s is left for a later pass", async (_name, options) => {
    expect(await setup(options).run()).toEqual({
      listed: 1,
      verified: 0,
      mismatch: 0,
      unavailable: 1,
    });
  });

  it("a list that fails or has a row of another shape trusts nothing", async () => {
    expect(await setup({ failOn: "list" }).run()).toEqual({
      listed: 0,
      verified: 0,
      mismatch: 0,
      unavailable: 0,
    });
    const odd = setup({ list: [{ submission_id: SUB1 }, { submission_id: "pkg-1" }] });
    expect(await odd.run()).toEqual({ listed: 0, verified: 0, mismatch: 0, unavailable: 0 });
    expect(odd.calls.map((c) => c.kind)).toEqual(["list"]);
  });

  it.each([
    { evidenceDomainId: "nije-uuid" },
    { batchLimit: 0 },
    { batchLimit: 1001 },
    { batchLimit: 1.5 },
  ])("refuses the configuration %j before any query", async (extra) => {
    const { run, calls } = setup();
    await expect(run(extra)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});
