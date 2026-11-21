import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  checkTransferLinkV1,
  EVIDENCE_TRANSFER_SOURCES_V4,
  EvidenceTransferLinkV1,
  PASTE_ORIGIN_KINDS_V4,
  TRANSFER_LINK_RULES_V1,
  type TransferRecordFoundV1,
} from "./transfer-link.ts";

// SRV-1809 (plan M9.0-S1; Ductus docs/contracts/evidence-segment-v4.md, "Polja
// događaja v4" and "Prihvat i rekonstrukcija"). One shape for import, AI
// transfer and paste origin; a foreign and a missing record answer alike (C7).
// All data is invented.

const ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const DOC = "doc-lorem-1";

const importLink = { source: "import", importId: ID, importManifestSha256: H1 } as const;
const transferLink = { source: "ai-transfer", aiTransferId: ID, aiTransferSha256: H1 } as const;
const pasteLink = {
  source: "paste",
  pasteOrigin: { kind: "ai-response", refId: ID, textSha256: H1 },
} as const;

const foundImport: TransferRecordFoundV1 = {
  source: "import",
  importId: ID,
  documentId: DOC,
  manifestSha256: H1,
};
const foundTransfer: TransferRecordFoundV1 = {
  source: "ai-transfer",
  transferId: ID,
  documentId: DOC,
  recordSha256: H1,
};

describe("evidence transfer link v1: one closed shape (K5, K11)", () => {
  it("names the sources and paste origin kinds of segment v4", () => {
    expect(EVIDENCE_TRANSFER_SOURCES_V4).toEqual(["import", "ai-transfer"]);
    expect(PASTE_ORIGIN_KINDS_V4).toEqual(["ai-response", "source-notebook"]);
  });

  it.each([
    importLink,
    transferLink,
    pasteLink,
    { ...pasteLink, pasteOrigin: { ...pasteLink.pasteOrigin, kind: "source-notebook" } },
  ])("accepts %j", (link) => {
    expect(Value.Check(EvidenceTransferLinkV1, link)).toBe(true);
  });

  it.each([
    ["a key of another source", { ...importLink, aiTransferId: ID }],
    ["the import keys beside ai-transfer", { ...importLink, source: "ai-transfer" }],
    ["a paste origin beside import", { ...importLink, pasteOrigin: pasteLink.pasteOrigin }],
    ["a paste origin on drop (O-6)", { source: "drop", pasteOrigin: pasteLink.pasteOrigin }],
    [
      "text in the origin (D9)",
      { ...pasteLink, pasteOrigin: { ...pasteLink.pasteOrigin, text: "Lorem" } },
    ],
    [
      "a title in the origin (D9)",
      { ...pasteLink, pasteOrigin: { ...pasteLink.pasteOrigin, title: "Lorem" } },
    ],
    ["an unknown kind", { ...pasteLink, pasteOrigin: { ...pasteLink.pasteOrigin, kind: "web" } }],
    ["a nil uuid", { ...transferLink, aiTransferId: "00000000-0000-0000-0000-000000000000" }],
    ["an upper-case hash", { ...transferLink, aiTransferSha256: "A".repeat(64) }],
    ["a missing hash", { source: "import", importId: ID }],
    ["an unknown source", { source: "editor-import", importId: ID, importManifestSha256: H1 }],
  ])("refuses %s", (_name, link) => {
    expect(Value.Check(EvidenceTransferLinkV1, link)).toBe(false);
  });
});

describe("evidence transfer link v1: the check in commit and reserve (C7, K12)", () => {
  it("passes the record of the same principal, document, id and hash", () => {
    expect(checkTransferLinkV1(importLink, DOC, foundImport)).toEqual({ ok: true });
    expect(checkTransferLinkV1(transferLink, DOC, foundTransfer)).toEqual({ ok: true });
  });

  it.each([
    ["missing or foreign", transferLink, null, "record_missing"],
    ["another source", transferLink, foundImport, "source_mismatch"],
    ["another source, import", importLink, foundTransfer, "source_mismatch"],
    [
      "another document",
      transferLink,
      { ...foundTransfer, documentId: "doc-lorem-2" },
      "document_mismatch",
    ],
    ["another id", transferLink, { ...foundTransfer, transferId: OTHER }, "id_mismatch"],
    ["another hash", transferLink, { ...foundTransfer, recordSha256: H2 }, "hash_mismatch"],
    ["another import id", importLink, { ...foundImport, importId: OTHER }, "id_mismatch"],
    ["another manifest hash", importLink, { ...foundImport, manifestSha256: H2 }, "hash_mismatch"],
  ] as const)("%s answers invalid", (_name, link, found, rule) => {
    const result = checkTransferLinkV1(link, DOC, found);
    expect(result).toEqual({ ok: false, outcome: "invalid", rule });
    expect(TRANSFER_LINK_RULES_V1).toContain(rule);
  });

  it("gives the client one answer for every failure", () => {
    const outcomes = new Set(
      [null, { ...foundTransfer, recordSha256: H2 }, { ...foundTransfer, documentId: "x" }].map(
        (found) => {
          const result = checkTransferLinkV1(transferLink, DOC, found);
          return result.ok ? "ok" : result.outcome;
        },
      ),
    );
    expect([...outcomes]).toEqual(["invalid"]);
  });
});
