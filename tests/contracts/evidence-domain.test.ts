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
