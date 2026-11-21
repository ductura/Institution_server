/**
 * The shared shape of what a v4 segment event says about text that came from
 * outside the editor (SRV-1809, plan M9.0-S1, D-269 O8; Ductus
 * docs/contracts/evidence-segment-v4.md, "Polja događaja v4"): one format for
 * the import (M8), the AI transfer (M9) and the known origin of a paste
 * (D-58). The event format itself is `ductus-evidence-segment-v4` in
 * server/domain/forensics and does not change here; this is the wire shape a
 * client and the server agree on, and the check the RPC of commit and
 * `reserve` makes against the record it found.
 *
 * PRIJEDLOG until the contract review, like SRV-1801.
 */
import { Type, type Static } from "@sinclair/typebox";

import { SHA256_HEX_PATTERN, UUID_V4_PATTERN } from "../import/index.ts";

/** The sources that point at a server record; v3 has neither. */
export const EVIDENCE_TRANSFER_SOURCES_V4 = Object.freeze(["import", "ai-transfer"] as const);
export type EvidenceTransferSourceV4 = (typeof EVIDENCE_TRANSFER_SOURCES_V4)[number];

/** What a `pasteOrigin` may name. Closed, like the sources. */
export const PASTE_ORIGIN_KINDS_V4 = Object.freeze(["ai-response", "source-notebook"] as const);
export type PasteOriginKindV4 = (typeof PASTE_ORIGIN_KINDS_V4)[number];

const Uuid = Type.String({ pattern: UUID_V4_PATTERN });
const Sha256 = Type.String({ pattern: SHA256_HEX_PATTERN });

export const ImportLinkV1 = Type.Object(
  { source: Type.Literal("import"), importId: Uuid, importManifestSha256: Sha256 },
  { additionalProperties: false },
);
export const AiTransferLinkV1 = Type.Object(
  { source: Type.Literal("ai-transfer"), aiTransferId: Uuid, aiTransferSha256: Sha256 },
  { additionalProperties: false },
);
/** The claim only: no text, title or author of the source (D9). */
export const PasteOriginV4 = Type.Object(
  {
    kind: Type.Union(PASTE_ORIGIN_KINDS_V4.map((kind) => Type.Literal(kind))),
    refId: Uuid,
    textSha256: Sha256,
  },
  { additionalProperties: false },
);
export const PasteOriginLinkV1 = Type.Object(
  { source: Type.Literal("paste"), pasteOrigin: PasteOriginV4 },
  { additionalProperties: false },
);

/** One of the three; anything else, or a key of one beside another source, is refused (K5, K11). */
export const EvidenceTransferLinkV1 = Type.Union([
  ImportLinkV1,
  AiTransferLinkV1,
  PasteOriginLinkV1,
]);
export type EvidenceTransferLinkV1 = Static<typeof EvidenceTransferLinkV1>;
export type PasteOriginV4 = Static<typeof PasteOriginV4>;

/**
 * The record the RPC found for the link, for the same principal; null when
 * there is none. A foreign and a missing record are both null, so they give
 * the same answer (C7).
 */
export type TransferRecordFoundV1 =
  | {
      readonly source: "import";
      readonly importId: string;
      readonly documentId: string;
      readonly manifestSha256: string;
    }
  | {
      readonly source: "ai-transfer";
      readonly transferId: string;
      readonly documentId: string;
      /** SHA-256(JCS(record)), recomputed from the stored canonical text. */
      readonly recordSha256: string;
    };

/** Why a link failed, for the server log only; the answer is always `invalid`. */
export const TRANSFER_LINK_RULES_V1 = Object.freeze([
  "record_missing",
  "source_mismatch",
  "id_mismatch",
  "document_mismatch",
  "hash_mismatch",
] as const);
export type TransferLinkRuleV1 = (typeof TRANSFER_LINK_RULES_V1)[number];

export type TransferLinkCheckV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "invalid"; readonly rule: TransferLinkRuleV1 };

const refuse = (rule: TransferLinkRuleV1): TransferLinkCheckV1 =>
  Object.freeze({ ok: false, outcome: "invalid", rule });

/**
 * The check of an `import` or `ai-transfer` event inside the commit and
 * `reserve` transaction: the record exists for the same principal and the
 * same document, and its hash is the hash the event carries. Every failure
 * answers `invalid`, so a foreign id cannot be told from a missing one (C7).
 * That one record links to at most one event is a unique constraint of the
 * table, not this function.
 */
export function checkTransferLinkV1(
  link: Static<typeof ImportLinkV1> | Static<typeof AiTransferLinkV1>,
  documentId: string,
  found: TransferRecordFoundV1 | null,
): TransferLinkCheckV1 {
  if (found === null) return refuse("record_missing");
  if (found.source !== link.source) return refuse("source_mismatch");
  if (found.documentId !== documentId) return refuse("document_mismatch");
  if (link.source === "import" && found.source === "import") {
    if (found.importId !== link.importId) return refuse("id_mismatch");
    if (found.manifestSha256 !== link.importManifestSha256) return refuse("hash_mismatch");
    return { ok: true };
  }
  if (link.source === "ai-transfer" && found.source === "ai-transfer") {
    if (found.transferId !== link.aiTransferId) return refuse("id_mismatch");
    if (found.recordSha256 !== link.aiTransferSha256) return refuse("hash_mismatch");
    return { ok: true };
  }
  return refuse("source_mismatch");
}
