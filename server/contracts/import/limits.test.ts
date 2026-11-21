import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  IMPORT_PENDING_LIFETIME_MS,
  IMPORT_READ_LIMITS,
  ImportReadLimitsV1,
  isImportRawByteLength,
  MAX_IMPORT_RAW_BYTES,
  resolveImportReadLimits,
} from "./limits.ts";
import { parseImportManifestV1 } from "./manifest.ts";

// SRV-1801 (ADR docs/adr/import-contract.md §4, attack classes L1 to L4 and Z).
// Every number is a PRIJEDLOG the review records (D-291); none is new except
// maxXmlAttributes and maxPdfPages, which the ADR marks unmeasured.

describe("import limits", () => {
  it("L1: the raw size limit is the B-8 segment limit of segment v4 (2 097 152 bytes)", () => {
    expect(MAX_IMPORT_RAW_BYTES).toBe(2_097_152);
    expect(isImportRawByteLength(MAX_IMPORT_RAW_BYTES)).toBe(true);
    expect(isImportRawByteLength(MAX_IMPORT_RAW_BYTES + 1)).toBe(false);
    expect(isImportRawByteLength(1)).toBe(true);
    for (const bad of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "1", 1n, null, 2 ** 53]) {
      expect(isImportRawByteLength(bad)).toBe(false);
    }
  });

  it("the read ceiling is the M8.1 defaults with the input held to the raw limit", () => {
    expect(IMPORT_READ_LIMITS).toEqual({
      maxInputBytes: MAX_IMPORT_RAW_BYTES,
      maxEntries: 2000,
      maxPartBytes: 16 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxRatio: 200,
      maxXmlDepth: 128,
      maxXmlAttributes: 2000,
      maxPdfPages: 500,
    });
    expect(Object.isFrozen(IMPORT_READ_LIMITS)).toBe(true);
    expect(Value.Check(ImportReadLimitsV1, IMPORT_READ_LIMITS)).toBe(true);
    expect(Value.Check(ImportReadLimitsV1, { ...IMPORT_READ_LIMITS, maxFiles: 1 })).toBe(false);
  });

  it("Z: a zip bomb cannot pass both the ratio and the total bound at the input limit", () => {
    // The largest inflation one input can claim is input x ratio; the total bound caps it again.
    const claimed = IMPORT_READ_LIMITS.maxInputBytes * IMPORT_READ_LIMITS.maxRatio;
    expect(Math.min(claimed, IMPORT_READ_LIMITS.maxTotalBytes)).toBe(
      IMPORT_READ_LIMITS.maxTotalBytes,
    );
    expect(IMPORT_READ_LIMITS.maxPartBytes).toBeLessThanOrEqual(IMPORT_READ_LIMITS.maxTotalBytes);
  });

  it("L3: a caller cannot loosen the read limits, only tighten them", () => {
    expect(resolveImportReadLimits()).toEqual(IMPORT_READ_LIMITS);
    expect(resolveImportReadLimits({ maxInputBytes: 64 * 1024 * 1024 })?.maxInputBytes).toBe(
      MAX_IMPORT_RAW_BYTES,
    );
    expect(resolveImportReadLimits({ maxEntries: 10 ** 9, maxRatio: 10 ** 6 })).toEqual(
      IMPORT_READ_LIMITS,
    );
    expect(resolveImportReadLimits({ maxInputBytes: 1024, maxXmlDepth: 8 })).toEqual({
      ...IMPORT_READ_LIMITS,
      maxInputBytes: 1024,
      maxXmlDepth: 8,
    });
  });

  it("L3: a malformed request never widens or drops a bound", () => {
    const polluted = JSON.parse('{"__proto__":{"maxRatio":1}}') as unknown;
    for (const bad of [
      { maxInputBytes: 0 },
      { maxInputBytes: 1.5 },
      { maxInputBytes: "1" },
      { maxInputBytes: Number.POSITIVE_INFINITY },
      { unknown: 1 },
      polluted,
      null,
      [],
      new Date(),
      "maxRatio",
    ]) {
      expect(resolveImportReadLimits(bad)).toBeNull();
    }
  });

  it("L4: a size rejection carries a code only, no name and no number", () => {
    const result = parseImportManifestV1({
      manifestSchema: "ductus-import-manifest-v1",
      importId: "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c",
      documentId: "dokument-izmisljeni-uvoz",
      importKind: "file-upload",
      fileFormat: "pdf",
      rawSha256: "1".repeat(64),
      rawByteLength: MAX_IMPORT_RAW_BYTES + 1,
      contentSha256: "2".repeat(64),
    });
    expect(result).toEqual({ ok: false, code: "MANIFEST_INVALID" });
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
  });

  it("a prepared import lives one hour", () => {
    expect(IMPORT_PENDING_LIFETIME_MS).toBe(60 * 60 * 1000);
  });
});
