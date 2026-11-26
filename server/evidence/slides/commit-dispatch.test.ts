// SRV-V13-EVIDENCE-SLAJD: the branch of the commit by kind of work. Every
// document and id below is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { EvidenceCommitter } from "../../database/index.ts";
import {
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  SLIDE_STEP_FORMAT_V1,
  slidesRevisionZeroDocument,
  slidesSnapshotSha256,
  slidesSnapshotText,
} from "../../domain/index.ts";
import { createEvidenceService } from "../index.ts";

import { verifySlidesCommit, workKindOfContext } from "./commit-dispatch.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const zero = slidesRevisionZeroDocument();
const ZERO_BYTES = bytes(slidesSnapshotText(zero));
const ZERO_HASH = slidesSnapshotSha256(zero);

describe("workKindOfContext", () => {
  it("takes a context without a kind, or with text, as a text work", () => {
    expect(workKindOfContext({})).toBe("text");
    expect(workKindOfContext({ documentKind: "text" })).toBe("text");
  });
  it("takes slides", () => {
    expect(workKindOfContext({ documentKind: "slides" })).toBe("slides");
  });
  it.each([null, "", "Slides", "pptx", 1, {}])("refuses %j rather than guess", (documentKind) => {
    expect(workKindOfContext({ documentKind })).toBeNull();
  });
});

describe("verifySlidesCommit", () => {
  const input = {
    transactionFormat: SLIDE_STEP_FORMAT_V1,
    document: ZERO_BYTES,
    finalDocumentHash: ZERO_HASH,
  };

  it("accepts a valid slides document under the slide step format", () => {
    expect(verifySlidesCommit(input)).toEqual({
      status: "ok",
      text: slidesSnapshotText(zero),
      sha256: ZERO_HASH,
    });
  });

  it("refuses a text step format on a slides work as document_mismatch", () => {
    expect(verifySlidesCommit({ ...input, transactionFormat: EDIT_STEP_FORMAT_V1 })).toEqual({
      status: "document_mismatch",
    });
  });

  it("refuses a document that is not the segment's final document", () => {
    expect(verifySlidesCommit({ ...input, finalDocumentHash: "e".repeat(64) })).toEqual({
      status: "document_mismatch",
    });
  });

  it("refuses a text document as the snapshot of a slides work", () => {
    const text = bytes(canonicalizeJcs({ schemaVersion: 1, nodes: [] }));
    expect(verifySlidesCommit({ ...input, document: text })).toEqual({ status: "invalid" });
  });

  it("refuses bytes that are not the exact JCS of the document", () => {
    const spaced = bytes(`${slidesSnapshotText(zero)} `);
    const hash = createHash("sha256").update(spaced).digest("hex");
    expect(verifySlidesCommit({ ...input, document: spaced, finalDocumentHash: hash })).toEqual({
      status: "invalid",
    });
  });

  it("refuses an oversized snapshot as too_large", () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    expect(verifySlidesCommit({ ...input, document: big })).toEqual({ status: "too_large" });
  });
});

describe("the commit preparation by kind", () => {
  // A text-format segment of the invented golden chain (see service.test.ts).
  const { chain } = JSON.parse(
    readFileSync(
      new URL("../../domain/forensics/golden-vectors/evidence-v2.json", import.meta.url),
      "latin1",
    ),
  ) as {
    chain: {
      segments: {
        canonicalUtf8Hex: string;
        segment: { documentId: string; evidenceProfileId: string };
      }[];
    };
  };
  const golden = chain.segments[0]!;

  async function commitTo(documentKind: unknown, document: Uint8Array = ZERO_BYTES) {
    const readContext = vi.fn().mockResolvedValue({
      status: "ok",
      context: {
        evidencePackageId: "paket-izmisljeni-1",
        institutionId: "00000000-0000-4000-8000-0000000000a1",
        evidenceDomainId: "00000000-0000-4000-8000-0000000000d1",
        evidenceProfileId: golden.segment.evidenceProfileId,
        maxPayloadBytes: 262144,
        transactionKnown: false,
        documentSchemaVersion: 1,
        ...(documentKind === undefined ? {} : { documentKind }),
        state: {
          currentRevision: 0,
          documentHash: "a".repeat(64),
          headSegmentHash: null,
          lastSequenceTo: 0,
        },
      },
    });
    const commit = vi.fn();
    const putImmutable = vi.fn();
    const service = createEvidenceService({
      committer: { readContext, commit } as unknown as EvidenceCommitter,
      payloads: { putImmutable, storageRefFor: vi.fn() } as never,
    });
    const outcome = await service.commit("zeton", {
      documentId: golden.segment.documentId,
      clientTransactionId: "tx-izmisljeni-1",
      baseRevision: 0,
      segment: Buffer.from(golden.canonicalUtf8Hex, "hex"),
      document,
    });
    return { outcome, commit, putImmutable };
  }

  it("refuses a text-format segment on a slides work with document_mismatch, before storage", async () => {
    const { outcome, commit, putImmutable } = await commitTo("slides");
    expect(outcome).toEqual({ status: "document_mismatch" });
    expect(putImmutable).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind of work as invalid, before storage", async () => {
    const { outcome, commit, putImmutable } = await commitTo("pptx");
    expect(outcome).toEqual({ status: "invalid" });
    expect(putImmutable).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaves the text path as it was: a slides document on a text work is refused there", async () => {
    for (const kind of [undefined, "text"]) {
      const { outcome, commit } = await commitTo(kind, ZERO_BYTES);
      // The text validator refuses a slides document; nothing of it reaches the database.
      expect(outcome.status).toBe("invalid");
      expect(commit).not.toHaveBeenCalled();
    }
  });
});
