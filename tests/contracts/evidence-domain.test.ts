// DAN-758: the evidence contracts and their vectors against the domain rules they
// copy. A cross-area test: server/contracts may import nothing from the server
// (docs/server-map.md §2), so the binding lives here.
import { describe, expect, it } from "vitest";

import { MAX_COMMIT_BODY_BYTES } from "../../server/contracts/index.ts";
import { VECTORS } from "../../server/contracts/generated/fake-server/index.ts";
import {
  isPublicVerificationKey,
  isSignedEvidenceReceiptV2,
  MAX_COMMIT_REQUEST_BYTES,
  verifyCanonicalEvidencePayloadV2,
  verifyDocumentSnapshot,
  verifySignedEvidenceReceiptV2,
  type EvidenceDomainKey,
} from "../../server/domain/index.ts";

const body = (route: string, name: string): unknown => {
  const found = VECTORS.find((v) => v.route === route && v.name === name);
  if (found === undefined) throw new Error(`no vector ${route}/${name}`);
  return found.response.body;
};

describe("evidence contracts follow the domain", () => {
  it("the commit body limit is MAX_COMMIT_REQUEST_BYTES", () => {
    expect(MAX_COMMIT_BODY_BYTES).toBe(MAX_COMMIT_REQUEST_BYTES);
  });

  it("every signed receipt in the commit vectors has the domain's v2 shape", () => {
    const signed = VECTORS.filter(
      (v) => v.route === "evidence.commit.post" && v.response.status === 200,
    );
    expect(signed.length).toBeGreaterThan(0);
    for (const v of signed) {
      const { receipt } = v.response.body as { receipt: { signedReceipt: unknown } };
      expect(isSignedEvidenceReceiptV2(receipt.signedReceipt)).toBe(true);
    }
  });

  it("every receipt key in the open vectors is a public verification key", () => {
    for (const name of ["opened", "started", "opened-after-commit"]) {
      const { receiptKeys } = body("evidence.open.post", name) as {
        receiptKeys: Record<string, unknown>[];
      };
      for (const { algorithm, keyId, keyVersion, encoding, keyBase64Url } of receiptKeys) {
        const key = { algorithm, keyId, keyVersion, encoding, keyBase64Url };
        expect(isPublicVerificationKey(key)).toBe(true);
      }
    }
  });
});

type Envelope = {
  documentId: string;
  clientTransactionId: string;
  baseRevision: number;
  segments: string[];
  document: string;
};
type State = {
  currentRevision: number;
  documentHash: string;
  headSegmentHash: string | null;
  lastSequenceTo: number;
};

const request = (name: string): Envelope => {
  const found = VECTORS.find((v) => v.route === "evidence.commit.post" && v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found.request.body as Envelope;
};
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

async function segmentOf(envelope: Envelope) {
  const verified = await verifyCanonicalEvidencePayloadV2(bytes(envelope.segments[0] ?? ""));
  if (!verified.ok) throw new Error(`segment refused: ${verified.reason}`);
  return verified;
}

async function snapshotHash(envelope: Envelope): Promise<string> {
  const verified = await verifyDocumentSnapshot(bytes(envelope.document));
  if (!verified.ok) throw new Error(`snapshot refused: ${verified.reason}`);
  return verified.sha256;
}

// The bytes come from the domain golden vectors, so a faithful handler reaches the
// answer each vector names; a placeholder would end in 422 invalid instead.
describe("commit vectors are reachable by a faithful handler", () => {
  it("the committed request carries a valid segment v2 and the snapshot it ends in", async () => {
    const envelope = request("committed");
    const { segment } = await segmentOf(envelope);
    expect(segment.documentId).toBe(envelope.documentId);
    expect(await snapshotHash(envelope)).toBe(segment.finalDocumentHash);
  });

  it("the receipt verifies under the key the open route reports", async () => {
    const envelope = request("committed");
    const { segment, sha256 } = await segmentOf(envelope);
    const { receiptKeys } = body("evidence.open.post", "opened") as {
      receiptKeys: EvidenceDomainKey[];
    };
    for (const name of ["committed", "duplicate", "duplicate-signed-after-pending"]) {
      const answer = body("evidence.commit.post", name) as {
        revision: number;
        receipt: { signedReceipt: unknown };
      };
      const verified = await verifySignedEvidenceReceiptV2(
        answer.receipt.signedReceipt,
        {
          documentId: envelope.documentId,
          clientTransactionId: envelope.clientTransactionId,
          revision: answer.revision,
          evidenceDomainId: receiptKeys[0]?.evidenceDomainId ?? "",
        },
        receiptKeys,
      );
      expect(verified).toMatchObject({ ok: true });
      if (verified.ok) {
        expect(verified.payload.segmentHash).toBe(sha256);
        expect(verified.payload.sequenceTo).toBe(segment.sequenceTo);
      }
    }
  });

  it("document-mismatch sends a valid snapshot that is not the segment's end", async () => {
    const envelope = request("document-mismatch");
    const { segment } = await segmentOf(envelope);
    expect(await snapshotHash(envelope)).not.toBe(segment.finalDocumentHash);
  });

  it("each 409 state leads to its own refusal in the order of BACKEND 4.13 t. 3.5", async () => {
    const reached = async (name: string) => {
      const envelope = request(name);
      const { segment } = await segmentOf(envelope);
      const state = body("evidence.commit.post", name) as State;
      if (state.currentRevision !== envelope.baseRevision) return "stale_base";
      if (segment.predecessorSegmentHash !== state.headSegmentHash) return "chain_conflict";
      if (segment.sequenceFrom <= state.lastSequenceTo) return "invalid";
      if (
        segment.sequenceFrom !== state.lastSequenceTo + 1 ||
        segment.initialDocumentHash !== state.documentHash
      )
        return "not_continuous";
      return "passes";
    };
    expect(await reached("stale-base")).toBe("stale_base");
    expect(await reached("chain-conflict")).toBe("chain_conflict");
    expect(await reached("not-continuous")).toBe("not_continuous");
  });

  it("txid-reused reuses the committed key with other content that passes every check", async () => {
    const first = request("committed");
    const again = request("txid-reused");
    expect(again.clientTransactionId).toBe(first.clientTransactionId);
    expect(again.segments).not.toEqual(first.segments);
    const { segment } = await segmentOf(again);
    const after = body("evidence.open.post", "opened-after-commit") as State;
    expect(again.baseRevision).toBe(after.currentRevision);
    expect(segment.predecessorSegmentHash).toBe(after.headSegmentHash);
    expect(segment.sequenceFrom).toBe(after.lastSequenceTo + 1);
    expect(segment.initialDocumentHash).toBe(after.documentHash);
    expect(await snapshotHash(again)).toBe(segment.finalDocumentHash);
  });
});
