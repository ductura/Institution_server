import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REVISION_ZERO_JCS,
  REVISION_ZERO_SHA256,
  verifyEvidenceChainV2,
} from "../../server/domain/index.ts";

import { buildCommitChain, type OpenedWork } from "./lanac.ts";

const work: OpenedWork = {
  documentId: "11111111-1111-4111-8111-111111111111",
  document: Buffer.from(REVISION_ZERO_JCS, "utf8").toString("base64"),
  documentHash: REVISION_ZERO_SHA256,
  evidenceProfileId: "22222222-2222-4222-8222-222222222222",
};
const minute = "2026-11-26T10:00:00.000Z";
const decode = (value: string): string => Buffer.from(value, "base64").toString("utf8");

describe("buildCommitChain", () => {
  it("builds a chain the server's own chain check accepts", async () => {
    const chain = buildCommitChain(work, ["Prvi odlomak.", " Drugi.", " Treći."], minute, "t1");
    expect(chain.map((commit) => commit.baseRevision)).toEqual([0, 1, 2]);
    const payloads = chain.map((commit) => decode(commit.segments[0] ?? ""));
    const last = payloads.at(-1) ?? "";
    const verified = await verifyEvidenceChainV2(payloads, {
      segmentHash: createHash("sha256").update(last).digest("hex"),
      segmentCount: 3,
    });
    expect(verified).toMatchObject({ ok: true, discontinuities: [] });
  });

  it("ends with the document that holds every text in order", () => {
    const chain = buildCommitChain(work, ["Prvi.", " Drugi."], minute, "t2");
    expect(decode(chain.at(-1)?.document ?? "")).toContain('"text":"Prvi. Drugi."');
  });

  it("gives every commit its own transaction id", () => {
    const ids = buildCommitChain(work, ["a", "b", "c"], minute, "t3").map(
      (commit) => commit.clientTransactionId,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("refuses a work that is not at revision zero and an empty chain", () => {
    expect(() =>
      buildCommitChain({ ...work, documentHash: "0".repeat(64) }, ["a"], minute, "x"),
    ).toThrow();
    expect(() => buildCommitChain(work, [], minute, "x")).toThrow();
  });
});
