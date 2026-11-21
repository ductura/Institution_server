/**
 * Import manifest `ductus-import-manifest-v1` and its three hashes (SRV-1801,
 * plan M8.0-S1, D-290; ADR docs/adr/import-contract.md §2). The shape is fixed
 * by the segment v4 contract (Ductus docs/contracts/evidence-segment-v4.md);
 * this file pins the read rules.
 *
 * The server builds the manifest from the bytes it received and stores
 * `manifestSha256` beside it, never in it. An `import` event of segment v4
 * carries that hash as `importManifestSha256`. The manifest has no author,
 * date, revision id, e-mail or file name (D-198 t. 5, D-292).
 */
import { Type, type Static } from "@sinclair/typebox";

import { isImportRawByteLength, MAX_IMPORT_RAW_BYTES } from "./limits.ts";

export const IMPORT_MANIFEST_SCHEMA_V1 = "ductus-import-manifest-v1";
export const IMPORT_KINDS_V1 = Object.freeze(["file-upload", "cloud-version"] as const);
export const IMPORT_FILE_FORMATS_V1 = Object.freeze(["docx", "pdf"] as const);
/** Trace kinds in the one order a manifest lists them (code unit order, as JCS). */
export const IMPORT_TRACE_KINDS_V1 = Object.freeze(["comment", "deletion", "insertion"] as const);

export type ImportKindV1 = (typeof IMPORT_KINDS_V1)[number];
export type ImportFileFormatV1 = (typeof IMPORT_FILE_FORMATS_V1)[number];
export type ImportTraceKindV1 = (typeof IMPORT_TRACE_KINDS_V1)[number];

/** Canonical UUID v4 in lowercase; the nil UUID fails the version nibble. */
export const UUID_V4_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const SHA256_HEX_PATTERN = "^[0-9a-f]{64}$";
const WHOLE_MINUTE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$";
/** Same bound as a segment's `documentId` (MAX_ID_LENGTH of segment v2 to v4). */
export const MAX_IMPORT_DOCUMENT_ID_LENGTH = 256;

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

export const ImportTraceV1 = Type.Object(
  {
    traceKind: literals(IMPORT_TRACE_KINDS_V1),
    count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type ImportTraceV1 = Static<typeof ImportTraceV1>;

const common = {
  manifestSchema: Type.Literal(IMPORT_MANIFEST_SCHEMA_V1),
  importId: Type.String({ pattern: UUID_V4_PATTERN }),
  documentId: Type.String({ minLength: 1, maxLength: MAX_IMPORT_DOCUMENT_ID_LENGTH }),
  rawSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
  rawByteLength: Type.Integer({ minimum: 1, maximum: MAX_IMPORT_RAW_BYTES }),
  contentSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
};
const traces = Type.Array(ImportTraceV1, { maxItems: IMPORT_TRACE_KINDS_V1.length });

/**
 * The closed manifest as three shapes: a DOCX upload, a DOCX cloud version
 * (the only one with `savedAt`) and a PDF upload (never `traces`, not even
 * empty). Rules a schema cannot say (trace order, a real minute, no lone
 * surrogate) are in {@link parseImportManifestV1}.
 */
export const ImportManifestV1 = Type.Union([
  Type.Object(
    {
      ...common,
      importKind: Type.Literal("file-upload"),
      fileFormat: Type.Literal("docx"),
      traces,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      importKind: Type.Literal("cloud-version"),
      fileFormat: Type.Literal("docx"),
      traces,
      savedAt: Type.Optional(Type.String({ pattern: WHOLE_MINUTE_PATTERN })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...common, importKind: Type.Literal("file-upload"), fileFormat: Type.Literal("pdf") },
    { additionalProperties: false },
  ),
]);
export type ImportManifestV1 = Readonly<Static<typeof ImportManifestV1>>;

/** What the server recomputed from the received file and content (B3). */
export type ImportRecomputedV1 = Readonly<{
  rawSha256: string;
  rawByteLength: number;
  contentSha256: string;
  traces?: readonly ImportTraceV1[];
}>;

/** Codes only: a rejection never carries input content (D-198 t. 5). */
export const IMPORT_MANIFEST_REJECT_CODES = Object.freeze([
  "MANIFEST_INVALID",
  "MANIFEST_NOT_CANONICAL",
  "RAW_SHA256_MISMATCH",
  "RAW_BYTE_LENGTH_MISMATCH",
  "CONTENT_SHA256_MISMATCH",
  "TRACES_MISMATCH",
] as const);
export type ImportManifestRejectCode = (typeof IMPORT_MANIFEST_REJECT_CODES)[number];

export type ImportManifestResult =
  { ok: true; manifest: ImportManifestV1 } | { ok: false; code: ImportManifestRejectCode };

const INVALID: ImportManifestResult = { ok: false, code: "MANIFEST_INVALID" };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const KEY_ORDER = [
  "manifestSchema",
  "importId",
  "documentId",
  "importKind",
  "fileFormat",
  "rawSha256",
  "rawByteLength",
  "contentSha256",
  "traces",
  "savedAt",
] as const;

function isPlain(value: unknown, array: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) !== array) return false;
  const prototype = Object.getPrototypeOf(value);
  return array
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

const UUID_V4 = new RegExp(UUID_V4_PATTERN, "u");
const SHA256_HEX = new RegExp(SHA256_HEX_PATTERN, "u");
const WHOLE_MINUTE = new RegExp(WHOLE_MINUTE_PATTERN, "u");
const REQUIRED_KEYS = KEY_ORDER.slice(0, 8);
const TRACE_KEYS = ["traceKind", "count"];

const isString = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** A real instant at a whole UTC minute, in the one D-24 spelling. */
function isWholeMinute(value: unknown): boolean {
  if (!isString(value, WHOLE_MINUTE)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isDocumentId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_IMPORT_DOCUMENT_ID_LENGTH &&
    !LONE_SURROGATE.test(value)
  );
}

/** Zero to three traces, each a closed plain object, each kind once, in {@link IMPORT_TRACE_KINDS_V1} order. */
function isTraceList(value: unknown): boolean {
  if (!isPlain(value, true) || (value as unknown[]).length > IMPORT_TRACE_KINDS_V1.length)
    return false;
  let last = -1;
  for (const trace of value as Record<string, unknown>[]) {
    if (!isPlain(trace, false)) return false;
    const keys = Object.keys(trace);
    if (keys.length !== 2 || !keys.every((key) => TRACE_KEYS.includes(key))) return false;
    const rank = (IMPORT_TRACE_KINDS_V1 as readonly unknown[]).indexOf(trace.traceKind);
    if (rank <= last || !Number.isSafeInteger(trace.count) || (trace.count as number) < 1)
      return false;
    last = rank;
  }
  return true;
}

/**
 * The checks of {@link ImportManifestV1} plus what a schema cannot say. Done
 * by hand because contracts import only `@sinclair/typebox`, not its value
 * checker; a test holds the schema and this function to the same answers.
 */
function isManifest(v: Record<string, unknown>): boolean {
  const keys = Object.keys(v);
  if (!keys.every((key) => (KEY_ORDER as readonly string[]).includes(key))) return false;
  if (!REQUIRED_KEYS.every((key) => Object.hasOwn(v, key))) return false;
  if (
    v.manifestSchema !== IMPORT_MANIFEST_SCHEMA_V1 ||
    !isString(v.importId, UUID_V4) ||
    !isDocumentId(v.documentId) ||
    !isString(v.rawSha256, SHA256_HEX) ||
    !isImportRawByteLength(v.rawByteLength) ||
    !isString(v.contentSha256, SHA256_HEX)
  )
    return false;
  const docx = v.fileFormat === "docx";
  if (!docx && v.fileFormat !== "pdf") return false;
  // cloud-version is docx only; every other kind is a file upload.
  if (v.importKind === "cloud-version" ? !docx : v.importKind !== "file-upload") return false;
  // docx: traces required, even when empty; pdf: no traces key at all.
  if (docx ? !isTraceList(v.traces) : Object.hasOwn(v, "traces")) return false;
  if (
    Object.hasOwn(v, "savedAt") &&
    (v.importKind !== "cloud-version" || !isWholeMinute(v.savedAt))
  )
    return false;
  return true;
}

/** Reads one parsed value with the closed format and returns a clean, frozen copy. */
export function parseImportManifestV1(value: unknown): ImportManifestResult {
  if (!isPlain(value, false) || !isManifest(value as Record<string, unknown>)) return INVALID;
  const v = value as Record<string, unknown>;

  const copy: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (!Object.hasOwn(v, key)) continue;
    copy[key] =
      key === "traces"
        ? Object.freeze(
            (v.traces as ImportTraceV1[]).map((t) =>
              Object.freeze({ traceKind: t.traceKind, count: t.count }),
            ),
          )
        : v[key];
  }
  return { ok: true, manifest: Object.freeze(copy) as ImportManifestV1 };
}

/**
 * RFC 8785 (JCS) for the values a manifest can hold: plain objects, arrays,
 * strings and safe integers. Keys sort by UTF-16 code units; strings use the
 * ECMAScript serialisation, which is what JCS prescribes.
 */
function jcs(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("import manifest: value outside the manifest shape");
}

/** The canonical text whose SHA-256 is `manifestSha256`. */
export function canonicalImportManifestV1(manifest: ImportManifestV1): string {
  return jcs(manifest);
}

/**
 * Reads manifest text: valid by {@link parseImportManifestV1} and exactly the
 * JCS text of that value. A duplicate key, another key order, whitespace or
 * another spelling of a number is refused, never rewritten (B-8).
 *
 * The caller decodes the stored bytes first with strict UTF-8 that keeps a
 * BOM (`decodeStrictUtf8` of server/domain/forensics): that decoding is
 * lossless, so equal text here means equal bytes, and a BOM or an invalid
 * sequence never reaches this function as canonical text. `manifestSha256`
 * is SHA-256 over the UTF-8 bytes of {@link canonicalImportManifestV1};
 * contracts hash nothing, the service of SRV-1803 does.
 */
export function parseImportManifestV1Text(text: string): ImportManifestResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return INVALID;
  }
  const parsed = parseImportManifestV1(value);
  if (!parsed.ok) return parsed;
  return canonicalImportManifestV1(parsed.manifest) === text
    ? parsed
    : { ok: false, code: "MANIFEST_NOT_CANONICAL" };
}

/**
 * B3: the server recomputes both hashes, the length and the traces from the
 * bytes it received; any difference rejects the whole import. The first
 * difference, in a fixed order, names the code.
 */
export function checkImportManifestV1(
  manifest: ImportManifestV1,
  recomputed: ImportRecomputedV1,
): ImportManifestResult {
  if (manifest.rawSha256 !== recomputed.rawSha256)
    return { ok: false, code: "RAW_SHA256_MISMATCH" };
  if (manifest.rawByteLength !== recomputed.rawByteLength)
    return { ok: false, code: "RAW_BYTE_LENGTH_MISMATCH" };
  if (manifest.contentSha256 !== recomputed.contentSha256)
    return { ok: false, code: "CONTENT_SHA256_MISMATCH" };
  const declared = "traces" in manifest ? jcs(manifest.traces) : null;
  const actual = recomputed.traces === undefined ? null : jcs(recomputed.traces);
  if (declared !== actual) return { ok: false, code: "TRACES_MISMATCH" };
  return { ok: true, manifest };
}
