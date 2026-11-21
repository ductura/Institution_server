// M3.1 (B-8): a segment changed on its way in is refused with a closed code
// before anything is stored, or, when the change is itself a valid canonical
// segment, is stored and committed only as those very bytes under their own
// hash. No outcome carries a piece of what was received. The domain fuzz
// (P1, P2) holds the verifier alone; this holds the whole preparation of the
// service over a context that takes the unchanged segment. Data is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { fc, test } from "@fast-check/vitest";
import { describe, expect, vi } from "vitest";

import type {
  EvidenceCommitContext,
  EvidenceCommitInput,
  EvidenceCommitter,
} from "../../database/index.ts";
import { canonicalizeJcs } from "../../domain/index.ts";
import { createEvidenceService } from "../index.ts";

type GoldenSegment = {
  documentId: string;
  evidenceProfileId: string;
  initialDocumentHash: string;
  predecessorSegmentHash: string | null;
  sequenceFrom: number;
  sequenceTo: number;
};
const { chain } = JSON.parse(
  readFileSync(
    new URL("../../domain/forensics/golden-vectors/evidence-v2.json", import.meta.url),
    "latin1",
  ),
) as {
  chain: {
    segments: { canonicalUtf8Hex: string; segment: GoldenSegment }[];
    documentStates: { afterSequence: number; value: unknown }[];
  };
};
const golden = chain.segments[0]!;
const SEGMENT = new Uint8Array(Buffer.from(golden.canonicalUtf8Hex, "hex"));
const SEGMENT_TEXT = new TextDecoder().decode(SEGMENT);
const DOCUMENT = new TextEncoder().encode(
  canonicalizeJcs(
    chain.documentStates.find((s) => s.afterSequence === golden.segment.sequenceTo)?.value,
  ),
);
const STATE = {
  currentRevision: 3,
  documentHash: golden.segment.initialDocumentHash,
  headSegmentHash: golden.segment.predecessorSegmentHash,
  lastSequenceTo: golden.segment.sequenceFrom - 1,
};
const CONTEXT: EvidenceCommitContext = {
  evidencePackageId: "paket-izmisljeni-1",
  institutionId: "00000000-0000-4000-8000-0000000000a1",
  evidenceDomainId: "00000000-0000-4000-8000-0000000000d1",
  evidenceProfileId: golden.segment.evidenceProfileId,
  maxPayloadBytes: 262144,
  transactionKnown: false,
  documentSchemaVersion: 1,
  state: STATE,
};
const REFUSALS = ["invalid", "too_large", "document_mismatch"];
const CONFLICTS = ["stale_base", "chain_conflict", "not_continuous"];

async function commit(segment: Uint8Array) {
  const committed: EvidenceCommitInput[] = [];
  const stored: string[] = [];
  const committer: EvidenceCommitter = {
    readContext: async () => ({ status: "ok", context: structuredClone(CONTEXT) }),
    commit: async (_token, input) => {
      committed.push(input);
      return { status: "committed_pending", revision: 4 };
    },
  };
  const payloads = {
    putImmutable: vi.fn(async (put: { canonicalPayload: string }) => {
      stored.push(put.canonicalPayload);
      return { status: "stored" as const, storageRef: "memory:ref" };
    }),
    storageRefFor: vi.fn(async () => ({ status: "ok" as const, storageRef: "memory:known" })),
  };
  const outcome = await createEvidenceService({ committer, payloads }).commit(
    "t",
    {
      documentId: golden.segment.documentId,
      clientTransactionId: "tx-izmisljeni-1",
      baseRevision: 3,
      segment,
      document: DOCUMENT,
    },
    "deferred",
  );
  return { outcome, committed, stored };
}

/** One change of the received bytes: a byte dropped, added or replaced. */
const change = fc.record({
  kind: fc.constantFrom("drop", "add", "replace"),
  at: fc.nat({ max: SEGMENT.length - 1 }),
  byte: fc.oneof(
    fc.constantFrom(0x20, 0x22, 0x2c, 0x30, 0x5c, 0x7b, 0xc3, 0xef, 0xff),
    fc.nat(255),
  ),
});
function apply({ kind, at, byte }: { kind: string; at: number; byte: number }): Uint8Array {
  const bytes = [...SEGMENT];
  if (kind === "drop") bytes.splice(at, 1);
  else if (kind === "add") bytes.splice(at, 0, byte);
  else bytes[at] = byte;
  return new Uint8Array(bytes);
}

describe("a changed segment through the service (M3.1, B-8)", () => {
  test.prop([change], { numRuns: 300 })(
    "is a closed refusal with nothing stored, or is stored and committed as exactly its own bytes",
    async (c) => {
      const tampered = apply(c);
      const { outcome, committed, stored } = await commit(tampered);
      if (outcome.status === "committed_pending") {
        const hash = createHash("sha256").update(tampered).digest("hex");
        expect(stored).toEqual([new TextDecoder().decode(tampered)]);
        expect(committed).toHaveLength(1);
        expect(committed[0]?.descriptor.segmentHash).toBe(hash);
        expect(committed[0]?.descriptor.payloadBytes).toBe(tampered.byteLength);
        return;
      }
      expect(stored).toEqual([]);
      expect(committed).toEqual([]);
      if (CONFLICTS.includes(outcome.status)) {
        expect(outcome).toEqual({ status: outcome.status, state: STATE });
      } else {
        expect(REFUSALS).toContain(outcome.status);
        expect(outcome).toEqual({ status: outcome.status });
      }
      // No piece of the received segment travels back in the outcome.
      const answer = JSON.stringify(outcome);
      for (let i = 0; i + 24 <= SEGMENT_TEXT.length; i += 24) {
        expect(answer).not.toContain(SEGMENT_TEXT.slice(i, i + 24));
      }
    },
  );

  test.prop([fc.constant(SEGMENT)], { numRuns: 1 })(
    "takes the unchanged segment, so every refusal above is the change's",
    async (segment) => {
      const { outcome, stored } = await commit(segment);
      expect(outcome).toEqual({ status: "committed_pending", revision: 4 });
      expect(stored).toHaveLength(1);
    },
  );
});
