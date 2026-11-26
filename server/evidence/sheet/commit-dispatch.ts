// SRV-V14-SHEET-EVIDENCE: the branch of the commit preparation for a work of
// kind `spreadsheet` (WEB docs/nalazi/val14-razlika.md, task 4). A spreadsheet
// work is judged by the spreadsheet validator and the sheet step format; a
// text or slides work never reaches this code. Signature, chain and receipt
// are the same for every kind: this only decides whether the received
// document is the right kind of document for the work.
import { createHash } from "node:crypto";

import {
  MAX_SHEET_SNAPSHOT_BYTES,
  SHEET_STEP_FORMAT_V1,
  sheetJcsBytes,
  validateSheetDocument,
} from "../../domain/index.ts";

export type SheetCommitInput = {
  /** `captureContext.transactionFormat` of the verified segment. */
  transactionFormat: string;
  /** The document bytes as received (JCS of the document after the last event). */
  document: Uint8Array;
  /** `finalDocumentHash` of the verified segment. */
  finalDocumentHash: string;
};

export type SheetCommitVerdict =
  | { status: "ok"; text: string; sha256: string }
  | { status: "invalid" | "too_large" | "document_mismatch" };

/**
 * A snapshot is accepted only as the exact JCS bytes of a valid spreadsheet
 * document: strict UTF-8 with no byte order mark, a document the validator
 * accepts, and a canonical form identical to the received bytes. The hash is
 * that of the received bytes. Same rules as the text and slides snapshots.
 */
function verifySheetSnapshot(bytes: Uint8Array): SheetCommitVerdict {
  if (!(bytes instanceof Uint8Array)) return { status: "invalid" };
  if (bytes.byteLength > MAX_SHEET_SNAPSHOT_BYTES) return { status: "too_large" };
  const received = Buffer.from(bytes);
  let text: string;
  let parsed: unknown;
  try {
    // Strict UTF-8: invalid bytes decode to U+FFFD and would not encode back to the same bytes.
    text = received.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(received)) return { status: "invalid" };
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  const valid = validateSheetDocument(parsed);
  if (!valid.ok) return { status: "invalid" };
  if (!Buffer.from(sheetJcsBytes(valid.doc)).equals(received)) return { status: "invalid" };
  return { status: "ok", text, sha256: createHash("sha256").update(received).digest("hex") };
}

/**
 * Judges a commit to a spreadsheet work. A step format other than
 * `ductus-sheet-steps-v1` (a text or slide format on a spreadsheet) and a
 * document whose hash is not the segment's final hash are `document_mismatch`
 * (422); a document the validator refuses (a text document on a spreadsheet
 * work, an unknown field, a cell outside the grid) is `invalid`, an oversized
 * one `too_large`.
 */
export function verifySheetCommit(input: SheetCommitInput): SheetCommitVerdict {
  if (input.transactionFormat !== SHEET_STEP_FORMAT_V1) return { status: "document_mismatch" };
  const snapshot = verifySheetSnapshot(input.document);
  if (snapshot.status !== "ok") return snapshot;
  if (snapshot.sha256 !== input.finalDocumentHash) return { status: "document_mismatch" };
  return snapshot;
}
