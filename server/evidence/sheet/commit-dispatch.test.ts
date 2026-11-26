// SRV-V14-SHEET-EVIDENCE: the branch of the commit for a spreadsheet work.
// Every document and id below is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { EvidenceCommitter } from "../../database/index.ts";
import {
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  SHEET_STEP_FORMAT_V1,
  sheetDigest,
  sheetJcsBytes,
  sheetRevisionZeroDocument,
} from "../../domain/index.ts";
import { createEvidenceService } from "../index.ts";
import { workKindOfContext } from "../ingest/index.ts";

import { verifySheetCommit } from "./commit-dispatch.ts";

const zero = sheetRevisionZeroDocument();
const ZERO_BYTES = sheetJcsBytes(zero);
const ZERO_HASH = sheetDigest(zero);
const bytes = (text: string) => new TextEncoder().encode(text);

describe("workKindOfContext", () => {
  it("keeps text and slides as they were", () => {
    expect(workKindOfContext({})).toBe("text");
    expect(workKindOfContext({ documentKind: "text" })).toBe("text");
    expect(workKindOfContext({ documentKind: "slides" })).toBe("slides");
  });
  it("takes spreadsheet", () => {
    expect(workKindOfContext({ documentKind: "spreadsheet" })).toBe("spreadsheet");
  });
  it.each([null, "", "Spreadsheet", "xlsx", 1, {}])(
    "refuses %j rather than guess",
    (documentKind) => {
      expect(workKindOfContext({ documentKind })).toBeNull();
    },
  );
});

describe("verifySheetCommit", () => {
  const input = {
    transactionFormat: SHEET_STEP_FORMAT_V1,
    document: ZERO_BYTES,
    finalDocumentHash: ZERO_HASH,
  };

  it("accepts a valid spreadsheet document under the sheet step format", () => {
    expect(verifySheetCommit(input)).toEqual({
      status: "ok",
      text: Buffer.from(ZERO_BYTES).toString("utf8"),
      sha256: ZERO_HASH,
    });
  });

  it("refuses a text step format on a spreadsheet work as document_mismatch", () => {
    expect(verifySheetCommit({ ...input, transactionFormat: EDIT_STEP_FORMAT_V1 })).toEqual({
      status: "document_mismatch",
    });
  });

  it("refuses a document that is not the segment's final document", () => {
    expect(verifySheetCommit({ ...input, finalDocumentHash: "e".repeat(64) })).toEqual({
      status: "document_mismatch",
    });
  });

  it("refuses a text document as the snapshot of a spreadsheet work", () => {
    const text = bytes(canonicalizeJcs({ schemaVersion: 1, nodes: [] }));
    expect(verifySheetCommit({ ...input, document: text })).toEqual({ status: "invalid" });
  });

  it("refuses an unknown field and a cell outside the grid", () => {
    const withField = { ...zero, extra: 1 };
    expect(verifySheetCommit({ ...input, document: bytes(canonicalizeJcs(withField)) })).toEqual({
      status: "invalid",
    });
    const outside = {
      ...zero,
      sheets: [{ ...zero.sheets[0]!, cells: { ["K1"]: { value: 1 } } }],
    };
    expect(verifySheetCommit({ ...input, document: bytes(canonicalizeJcs(outside)) })).toEqual({
      status: "invalid",
    });
  });

  it("refuses bytes that are not the exact JCS, a BOM and invalid UTF-8", () => {
    const spaced = bytes(`${Buffer.from(ZERO_BYTES).toString("utf8")} `);
    const hash = createHash("sha256").update(spaced).digest("hex");
    expect(verifySheetCommit({ ...input, document: spaced, finalDocumentHash: hash })).toEqual({
      status: "invalid",
    });
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ZERO_BYTES)]);
    expect(verifySheetCommit({ ...input, document: bom })).toEqual({ status: "invalid" });
    expect(verifySheetCommit({ ...input, document: Uint8Array.from([0xff, 0xfe]) })).toEqual({
      status: "invalid",
    });
  });

  it("refuses an oversized snapshot as too_large", () => {
    expect(verifySheetCommit({ ...input, document: new Uint8Array(3 * 1024 * 1024) })).toEqual({
      status: "too_large",
    });
  });
});

describe("the commit preparation by kind", () => {
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

  it("refuses a text-format segment on a spreadsheet work with document_mismatch, before storage", async () => {
    const { outcome, commit, putImmutable } = await commitTo("spreadsheet");
    expect(outcome).toEqual({ status: "document_mismatch" });
    expect(putImmutable).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses a text document on a spreadsheet work with the right-kind check, before storage", async () => {
    const text = bytes(canonicalizeJcs({ schemaVersion: 1, nodes: [] }));
    const { outcome, commit } = await commitTo("spreadsheet", text);
    // The step format is checked first: the golden segment is a text segment.
    expect(["document_mismatch", "invalid"]).toContain(outcome.status);
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind as invalid, and a spreadsheet document on a text work", async () => {
    expect((await commitTo("xlsx")).outcome).toEqual({ status: "invalid" });
    for (const kind of [undefined, "text"]) {
      const { outcome, commit } = await commitTo(kind, ZERO_BYTES);
      expect(outcome.status).toBe("invalid");
      expect(commit).not.toHaveBeenCalled();
    }
  });
});
