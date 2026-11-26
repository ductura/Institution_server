// Jazzer.js target for the DOCX import (ISTR-8). `run.ts` bundles this file to
// CommonJS and hands it to Jazzer.js; the target itself runs nothing on import.
// One parser: `readDocx`. A crash is an uncaught exception, a hang is cut by
// libFuzzer's `-timeout`, a memory blow-up by `-rss_limit_mb`; both are set in
// `run.ts`. Anything else must be a valid answer of the import contract.
import {
  IMPORT_READ_REJECT_CODES,
  resolveImportReadLimits,
  type ImportReadLimitsV1,
} from "../../server/contracts/index.ts";
import { readDocx } from "../../server/import/docx/index.ts";

/** Largest input the fuzzer builds; also the `maxInputBytes` of the read. */
export const FUZZ_MAX_INPUT_BYTES = 256 * 1024;

// Tighter than the production ceiling, so a bomb is refused in milliseconds
// and the fuzzer keeps its execution rate. Each key may only tighten (L3).
const resolved = resolveImportReadLimits({
  maxInputBytes: FUZZ_MAX_INPUT_BYTES,
  maxEntries: 200,
  maxPartBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlAttributes: 500,
});
if (resolved === null) throw new Error("fuzz limits are not a valid tightening of the ceiling");
const limits: ImportReadLimitsV1 = resolved;

/** One execution: throws only when the import breaks its own contract. */
export function check(data: Uint8Array): void {
  const bytes = data.length > FUZZ_MAX_INPUT_BYTES ? data.subarray(0, FUZZ_MAX_INPUT_BYTES) : data;
  const read = readDocx(bytes, limits);
  if (read.ok) {
    if (read.content.schemaVersion !== 2) throw new Error("imported content is not document v2");
    return;
  }
  if (!(IMPORT_READ_REJECT_CODES as readonly string[]).includes(read.code)) {
    throw new Error(`readDocx answered with a code outside the contract: ${String(read.code)}`);
  }
}

/** Entry point Jazzer.js calls for every input. */
export function fuzz(data: Buffer): void {
  check(data);
}
