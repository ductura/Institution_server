/**
 * Read limits of an import (SRV-1801, plan M8.0-S1; ADR docs/adr/import-contract.md §4).
 *
 * D-291: `rawByteLength` gets no limit of its own, the evidence payload limit
 * of B-8 holds. Every other number here is a PRIJEDLOG until the review of the
 * contract records it; the DOCX read limits are the configured, unmeasured
 * defaults of spike M8.1-P03 with the input held to the B-8 limit.
 */
import { Type, type Static } from "@sinclair/typebox";

/**
 * The B-8 payload limit, 2 097 152 bytes. Equal to `MAX_EVIDENCE_SEGMENT_BYTES`
 * of server/domain/forensics; contracts import nothing, so the number is
 * repeated here and a test pins it to the segment v4 limit table.
 */
export const MAX_IMPORT_RAW_BYTES = 2 * 1024 * 1024;

/** How long a prepared import waits for the student's review confirmation. */
export const IMPORT_PENDING_LIFETIME_MS = 60 * 60 * 1000;

/** Bounds a reader of an imported file must hold; the keys are a closed set. */
export const ImportReadLimitsV1 = Type.Object(
  {
    /** Bytes of the received file; never above {@link MAX_IMPORT_RAW_BYTES}. */
    maxInputBytes: Type.Integer({ minimum: 1 }),
    /** ZIP: number of central directory entries. */
    maxEntries: Type.Integer({ minimum: 1 }),
    /** ZIP: inflated bytes of one part. */
    maxPartBytes: Type.Integer({ minimum: 1 }),
    /** ZIP: inflated bytes of all parts together. */
    maxTotalBytes: Type.Integer({ minimum: 1 }),
    /** ZIP: inflated over compressed bytes, per part (zip bomb). */
    maxRatio: Type.Integer({ minimum: 1 }),
    /** XML: element nesting depth of any part read. */
    maxXmlDepth: Type.Integer({ minimum: 1 }),
    /** XML: attributes on one element. */
    maxXmlAttributes: Type.Integer({ minimum: 1 }),
    /** PDF: pages read (M8.3). */
    maxPdfPages: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ImportReadLimitsV1 = Static<typeof ImportReadLimitsV1>;

/**
 * The ceiling of every import read. The ZIP and XML depth numbers are the
 * M8.1 defaults (`DEFAULT_DOCX_LIMITS`); attributes and PDF pages are new
 * proposals of this contract and unmeasured.
 */
export const IMPORT_READ_LIMITS: Readonly<ImportReadLimitsV1> = Object.freeze({
  maxInputBytes: MAX_IMPORT_RAW_BYTES,
  maxEntries: 2000,
  maxPartBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 200,
  maxXmlDepth: 128,
  maxXmlAttributes: 2000,
  maxPdfPages: 500,
});

const LIMIT_KEYS = Object.keys(IMPORT_READ_LIMITS) as (keyof ImportReadLimitsV1)[];

/**
 * Resolves a caller's limits: each key may only tighten the ceiling (L3).
 * `null` for an unknown key or a value that is not a positive safe integer,
 * so a malformed request never widens or silently drops a bound.
 */
export function resolveImportReadLimits(requested: unknown = {}): ImportReadLimitsV1 | null {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return null;
  const prototype = Object.getPrototypeOf(requested);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const input = requested as Record<string, unknown>;
  if (!Object.keys(input).every((key) => (LIMIT_KEYS as string[]).includes(key))) return null;
  const resolved = { ...IMPORT_READ_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (!Number.isSafeInteger(value) || (value as number) < 1) return null;
    resolved[key] = Math.min(value as number, IMPORT_READ_LIMITS[key]);
  }
  return resolved;
}

/** `rawByteLength` of a manifest: a safe integer from 1 to the B-8 limit (L1). */
export function isImportRawByteLength(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_IMPORT_RAW_BYTES
  );
}
