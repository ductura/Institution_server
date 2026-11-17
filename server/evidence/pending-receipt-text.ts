// The text of a pending receipt v2, read before anything is signed (DAN-820,
// VS-1b part 1, 820c-1; plan of attack ductura/server#146 P-1). Port of
// `parsePending`, `MAX_PENDING_RECEIPT_TEXT_LENGTH` and `PendingReceiptRefusal`
// from Ductus src/application/evidence/sign-pending-receipt.ts at 333e163,
// word for word; the rest of that file comes in 820c-2 … 820c-4.
import type { PendingReceiptRow } from "../database/index.ts";
import {
  canonicalizeJcs,
  EVIDENCE_RECEIPT_SCHEMA_V1,
  isEvidenceReceiptPayloadV2,
  isPlainObject,
  type EvidenceReceiptPayloadV2,
} from "../domain/index.ts";

/** Far above any v2 payload; asked before the text is parsed. */
export const MAX_PENDING_RECEIPT_TEXT_LENGTH = 16_384;

export type PendingReceiptRefusal =
  | "receipt_malformed"
  | "not_canonical"
  | "unsupported_schema"
  | "receipt_id_mismatch"
  | "invalid"
  | "not_found"
  | "digest_mismatch";

export type ParsedPendingReceipt =
  { ok: true; payload: EvidenceReceiptPayloadV2 } | { ok: false; reason: PendingReceiptRefusal };

export function parsePendingReceipt(row: PendingReceiptRow): ParsedPendingReceipt {
  const text: unknown = row.receiptPayloadText;
  if (typeof text !== "string" || text.length > MAX_PENDING_RECEIPT_TEXT_LENGTH) {
    return { ok: false, reason: "receipt_malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "receipt_malformed" };
  }
  // D-215: no v1 receipt is signed here; the v2 signer never sees a v1 record.
  if (isPlainObject(parsed) && parsed.receiptSchema === EVIDENCE_RECEIPT_SCHEMA_V1) {
    return { ok: false, reason: "unsupported_schema" };
  }
  if (!isEvidenceReceiptPayloadV2(parsed)) {
    return { ok: false, reason: "receipt_malformed" };
  }
  // The database hashes the stored text, so only a text that is its own JCS
  // form has the digest that the signature is made over. A value JCS cannot
  // write (a lone surrogate) is malformed, not an exception.
  let canonical: string;
  try {
    canonical = canonicalizeJcs(parsed);
  } catch {
    return { ok: false, reason: "receipt_malformed" };
  }
  if (canonical !== text) {
    return { ok: false, reason: "not_canonical" };
  }
  if (parsed.receiptId !== row.receiptId) {
    return { ok: false, reason: "receipt_id_mismatch" };
  }
  return { ok: true, payload: parsed };
}
