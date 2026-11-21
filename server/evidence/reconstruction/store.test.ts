import { describe, expect, it } from "vitest";

import {
  createWorkerReconstructionCheckpointStore,
  type WorkerReconstructionQuery,
} from "./store.ts";

// SRV-1503: the worker adapter of the reconstruction checkpoints. The query is
// a fake; ids and texts are invented.
const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const PACKAGE = "paket-izmisljeni-1503";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const row = (overrides: Record<string, unknown> = {}) => ({
  revision: "50",
  segmentHash: HASH_A,
  contentHash: HASH_B,
  body: '{"nodes":[]}',
  ...overrides,
});

function fake(answer: (text: string, values: readonly unknown[]) => unknown) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const query: WorkerReconstructionQuery = async (text, values) => {
    calls.push({ text, values });
    const result = answer(text, values);
    if (result instanceof Error) throw result;
    return result as { rows: readonly unknown[] };
  };
  return {
    calls,
    store: createWorkerReconstructionCheckpointStore({ query, evidenceDomainId: DOMAIN }),
  };
}

describe("readAtOrBefore", () => {
  it("reads the newest checkpoint through the worker RPC with the configured domain", async () => {
    const { calls, store } = fake(() => ({ rows: [row()] }));
    expect(await store.readAtOrBefore({ evidencePackageId: PACKAGE, revision: 70 })).toEqual({
      status: "found",
      checkpoint: { revision: 50, segmentHash: HASH_A, contentHash: HASH_B, body: '{"nodes":[]}' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain(
      "app.worker_reconstruction_checkpoint($1::uuid, $2, $3::bigint)",
    );
    expect(calls[0]!.values).toEqual([DOMAIN, PACKAGE, "70"]);
  });

  it("answers none for no row", async () => {
    const { store } = fake(() => ({ rows: [] }));
    expect(await store.readAtOrBefore({ evidencePackageId: PACKAGE, revision: 3 })).toEqual({
      status: "none",
    });
  });

  it.each([
    ["two rows", [row(), row()]],
    ["a revision after the asked one", [row({ revision: "71" })]],
    ["a numeric revision", [row({ revision: 50 })]],
    ["revision 0", [row({ revision: "0" })]],
    ["an upper-case hash", [row({ segmentHash: HASH_A.toUpperCase() })]],
    ["an empty text", [row({ body: "" })]],
    ["a column too many", [row({ extra: 1 })]],
    ["a missing column", [{ revision: "50", segmentHash: HASH_A, contentHash: HASH_B }]],
    ["a row that is no object", ["50"]],
  ])("refuses %s as a whole", async (_label, rows) => {
    const { store } = fake(() => ({ rows }));
    expect(await store.readAtOrBefore({ evidencePackageId: PACKAGE, revision: 70 })).toEqual({
      status: "unavailable",
      reason: "invalid_checkpoint_row",
    });
  });

  it("turns a driver error into a closed reason without its text", async () => {
    const { store } = fake(() => new Error(`connection to ${PACKAGE} failed`));
    expect(await store.readAtOrBefore({ evidencePackageId: PACKAGE, revision: 2 })).toEqual({
      status: "unavailable",
      reason: "checkpoints_failed",
    });
  });

  it("asks nothing for a request outside the contract", async () => {
    const { calls, store } = fake(() => ({ rows: [] }));
    for (const [evidencePackageId, revision] of [
      ["Paket", 2],
      ["", 2],
      [PACKAGE, 0],
      [PACKAGE, 1.5],
    ] as const) {
      expect(await store.readAtOrBefore({ evidencePackageId, revision })).toEqual({
        status: "unavailable",
        reason: "invalid_checkpoint_request",
      });
    }
    const other = createWorkerReconstructionCheckpointStore({
      query: async () => ({ rows: [] }),
      evidenceDomainId: "nije-uuid",
    });
    expect(await other.readAtOrBefore({ evidencePackageId: PACKAGE, revision: 2 })).toMatchObject({
      status: "unavailable",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("record", () => {
  const checkpoint = {
    revision: 50,
    segmentHash: HASH_A,
    contentHash: HASH_B,
    body: '{"nodes":[]}',
  };

  it.each(["recorded", "exists", "not_found", "mismatch"])(
    "passes on the outcome %s",
    async (outcome) => {
      const { calls, store } = fake(() => ({ rows: [{ outcome }] }));
      expect(await store.record({ evidencePackageId: PACKAGE, checkpoint })).toEqual({
        status: outcome,
      });
      expect(calls[0]!.text).toContain(
        "app.worker_record_reconstruction_checkpoint($1::uuid, $2, $3::bigint, $4, $5)",
      );
      // The hash is the database's: it is never sent.
      expect(calls[0]!.values).toEqual([DOMAIN, PACKAGE, "50", HASH_A, '{"nodes":[]}']);
    },
  );

  it.each([
    ["an unknown outcome", [{ outcome: "written" }]],
    ["no row", []],
    ["a row of another shape", [{ outcome: "recorded", extra: true }]],
  ])("refuses %s", async (_label, rows) => {
    const { store } = fake(() => ({ rows }));
    expect(await store.record({ evidencePackageId: PACKAGE, checkpoint })).toEqual({
      status: "unavailable",
      reason: "invalid_checkpoint_row",
    });
  });

  it("refuses a checkpoint outside the contract before asking", async () => {
    const { calls, store } = fake(() => ({ rows: [{ outcome: "recorded" }] }));
    for (const bad of [
      { revision: 0 },
      { segmentHash: "x" },
      { body: "" },
      { body: "a".repeat(2_097_153) },
    ]) {
      expect(
        await store.record({ evidencePackageId: PACKAGE, checkpoint: { ...checkpoint, ...bad } }),
      ).toEqual({
        status: "unavailable",
        reason: "invalid_checkpoint_request",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("turns a driver error into a closed reason", async () => {
    const { store } = fake(() => new Error("boom"));
    expect(await store.record({ evidencePackageId: PACKAGE, checkpoint })).toEqual({
      status: "unavailable",
      reason: "checkpoints_failed",
    });
  });
});
