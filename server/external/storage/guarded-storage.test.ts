// S-1E-c (DAN-837): storage behind the outside-service pattern. Invented values only.
import { describe, expect, it } from "vitest";

import { createExternalCaller } from "../../metrics/index.ts";
import { guardStorage, type GuardableStorage } from "./guarded-storage.ts";

const POLICY = { timeoutMs: 1000, retries: 2, retryDelayMs: 0, downAfter: 9, downForMs: 0 };
const IDS = { institutionId: "i-1", evidencePackageId: "p-1", segmentHash: "b".repeat(64) };

function storage(answer: { status: "unavailable"; reason: string }) {
  const calls: string[] = [];
  const store: GuardableStorage = {
    putImmutable: async () => (calls.push("put"), answer),
    readImmutable: async () => (calls.push("read"), answer),
    headImmutable: async () => (calls.push("head"), answer),
  };
  return { calls, guarded: guardStorage(store, createExternalCaller("storage", POLICY)) };
}

describe("guardStorage", () => {
  it("keeps the store's own unavailable reason", async () => {
    const { guarded } = storage({ status: "unavailable", reason: "storage_domain_unverified" });
    expect(await guarded.putImmutable({ ...IDS, canonicalPayload: "{}" })).toEqual({
      status: "unavailable",
      reason: "storage_domain_unverified",
    });
  });

  it("sends put once and retries read and head", async () => {
    const { calls, guarded } = storage({ status: "unavailable", reason: "x" });
    await guarded.putImmutable({ ...IDS, canonicalPayload: "{}" });
    await guarded.readImmutable(IDS);
    await guarded.headImmutable({ ...IDS, payloadBytes: 2 });
    expect(calls).toEqual(["put", "read", "read", "read", "head", "head", "head"]);
  });

  it("answers storage_down without reaching a store that is down", async () => {
    const calls: string[] = [];
    const store: GuardableStorage = {
      putImmutable: async () => (calls.push("put"), Promise.reject(new Error("down"))),
      readImmutable: async () => ({ status: "not_found" }),
      headImmutable: async () => ({ status: "absent" }),
    };
    const caller = createExternalCaller("storage", { ...POLICY, downAfter: 1, downForMs: 60_000 });
    const guarded = guardStorage(store, caller);
    const input = { ...IDS, canonicalPayload: "{}" };
    expect(await guarded.putImmutable(input)).toEqual({
      status: "unavailable",
      reason: "storage_unavailable",
    });
    expect(await guarded.putImmutable(input)).toEqual({
      status: "unavailable",
      reason: "storage_down",
    });
    expect(calls).toEqual(["put"]);
  });
});
