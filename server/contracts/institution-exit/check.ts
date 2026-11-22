import {
  EXIT_FILE_PATH_PATTERN,
  INSTITUTION_EXIT_ACTOR_V1,
  INSTITUTION_EXIT_CLASS_COUNT,
  INSTITUTION_EXIT_SCHEMA_V1,
  MAX_EXIT_FILES,
  MAX_WRITTEN_REQUEST_REF_LENGTH,
  SHA256_PATTERN,
  UUID_PATTERN,
  type InstitutionExitManifestV1,
  type InstitutionExitRejectCodeV1,
} from "./package.ts";

/** Codes only: a rejection never carries content of the package. */
export type InstitutionExitCheckV1 =
  | { ok: true; manifest: InstitutionExitManifestV1 }
  | { ok: false; code: InstitutionExitRejectCodeV1 };

const UUID = new RegExp(UUID_PATTERN, "u");
const SHA256 = new RegExp(SHA256_PATTERN, "u");
const PATH = new RegExp(EXIT_FILE_PATH_PATTERN, "u");
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MANIFEST_KEYS = [
  "manifestSchema",
  "exitId",
  "institutionId",
  "writtenRequestRef",
  "recipientLabel",
  "startedBy",
  "generatedAt",
  "deletesNothing",
  "files",
];
const FILE_KEYS = ["path", "dataClass", "rowCount", "byteLength", "sha256"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;
const isCount = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const matches = (value: unknown, pattern: RegExp): boolean =>
  typeof value === "string" && pattern.test(value);

function isFile(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, FILE_KEYS) &&
    matches(value.path, PATH) &&
    isCount(value.dataClass, 1, INSTITUTION_EXIT_CLASS_COUNT) &&
    isCount(value.rowCount, 0, Number.MAX_SAFE_INTEGER) &&
    isCount(value.byteLength, 0, Number.MAX_SAFE_INTEGER) &&
    matches(value.sha256, SHA256)
  );
}

function isManifestShape(value: unknown): value is InstitutionExitManifestV1 {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, MANIFEST_KEYS) &&
    value.manifestSchema === INSTITUTION_EXIT_SCHEMA_V1 &&
    matches(value.exitId, UUID) &&
    matches(value.institutionId, UUID) &&
    isText(value.writtenRequestRef, MAX_WRITTEN_REQUEST_REF_LENGTH) &&
    isText(value.recipientLabel, 120) &&
    value.startedBy === INSTITUTION_EXIT_ACTOR_V1 &&
    matches(value.generatedAt, INSTANT) &&
    value.deletesNothing === true &&
    Array.isArray(value.files) &&
    value.files.length <= MAX_EXIT_FILES &&
    value.files.every(isFile)
  );
}

/**
 * Reads a manifest: the shape (closed), the files in code unit order of the
 * path, no path twice, and every one of the 30 data classes with at least one
 * file (an empty class is a file with `rowCount` 0, so the recipient can tell
 * "nothing there" from an omitted class).
 */
export function checkInstitutionExitManifestV1(value: unknown): InstitutionExitCheckV1 {
  if (!isManifestShape(value)) return { ok: false, code: "MANIFEST_INVALID" };
  const paths = value.files.map((file) => file.path);
  for (let i = 1; i < paths.length; i += 1) {
    const previous = paths[i - 1] as string;
    const current = paths[i] as string;
    if (current === previous) return { ok: false, code: "FILE_PATH_DUPLICATE" };
    if (current < previous) return { ok: false, code: "FILES_NOT_SORTED" };
  }
  const classes = new Set(value.files.map((file) => file.dataClass));
  for (let n = 1; n <= INSTITUTION_EXIT_CLASS_COUNT; n += 1) {
    if (!classes.has(n)) return { ok: false, code: "DATA_CLASS_MISSING" };
  }
  return { ok: true, manifest: value };
}
