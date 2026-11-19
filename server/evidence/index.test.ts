import { describe, expect, it } from "vitest";
import * as domain from "../domain/index.ts";
import * as area from "./index.ts";

describe("server/evidence public interface", () => {
  it("exports the service factory, the replay reader, the pending receipt signer, the retry decision and loop, the domain's wire limits and the snapshot check, nothing else", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DUCTUS_ASYNC_COMMIT_PROTOCOL",
      "DUCTUS_PROTOCOL_VERSION",
      "MAX_COMMIT_REQUEST_BYTES",
      "MAX_DOCUMENT_SNAPSHOT_BYTES",
      "MAX_REPLAY_PAGE_SEGMENTS",
      "MAX_SIGNATURE_RETRY_ATTEMPTS",
      "MAX_SIGNATURE_RETRY_DELAY_MS",
      "REPLAY_FORMAT",
      "createEvidenceService",
      "createSignPendingReceipt",
      "createSignPendingReceiptWithRetry",
      "decideSignatureRetry",
      "readReplayPage",
      "signatureRetryDelayMs",
      "verifyDocumentSnapshot",
    ]);
  });

  // The contract's own number is held to the domain in
  // tests/contracts/evidence-domain.test.ts (MAX_COMMIT_BODY_BYTES).
  it("B2: http reads the domain's limits through this area, unchanged", () => {
    expect(area.MAX_COMMIT_REQUEST_BYTES).toBe(domain.MAX_COMMIT_REQUEST_BYTES);
    expect(area.DUCTUS_PROTOCOL_VERSION).toBe(domain.DUCTUS_PROTOCOL_VERSION);
    expect(area.DUCTUS_ASYNC_COMMIT_PROTOCOL).toBe(domain.DUCTUS_ASYNC_COMMIT_PROTOCOL);
    expect(area.MAX_DOCUMENT_SNAPSHOT_BYTES).toBe(domain.MAX_DOCUMENT_SNAPSHOT_BYTES);
    expect(area.verifyDocumentSnapshot).toBe(domain.verifyDocumentSnapshot);
  });
});
