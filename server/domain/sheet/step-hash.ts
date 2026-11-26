// SRV-V14-SHEET-EVIDENCE: the SHA-256 a spreadsheet step carries for what it
// replaces or removes. Kept apart from the step reader (./model/steps.ts) so
// that the reader imports no Node module (SRV-V14-PARSERI-BEZ-NODE): it checks
// only that a hash is 64 lowercase hex digits, and application compares it with
// these.
import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../forensics/index.ts";

import type { SheetCell } from "./model/index.ts";

/** SHA-256 (lowercase hex) of the UTF-8 bytes of a text; the `replacedSha256` of a sheet name. */
export function sheetTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of the JCS text of a cell: the `replacedSha256` and `removedSha256` of a cell step. */
export function sheetCellSha256(cell: SheetCell): string {
  return sheetTextSha256(canonicalizeJcs(cell));
}

/** SHA-256 of the JCS text of a map of cells: the `removedSha256` of a row or column removal. */
export function sheetCellsSha256(cells: Record<string, SheetCell>): string {
  return sheetTextSha256(canonicalizeJcs(cells));
}
