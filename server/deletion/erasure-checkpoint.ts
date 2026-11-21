// The signed checkpoint of the erasure record (SRV-1302; plan M10.0-S1,
// D-272 MQ07). A checkpoint commits to a run of tombstones of one
// institution (evidence.erasure, SRV-1301) by a SHA-256 chain over them in
// the given order, and is signed with Ed25519 by the signing port. A restore
// drill (M10.Z1) checks the tombstones of a restored database against it
// before the restore is opened.
//
// Pure apart from node:crypto: no I/O, no clock. The same records give the
// same bytes, and Ed25519 is deterministic, so the signed checkpoint is the
// same bytes too. Every answer is a closed code; no input value is ever put
// into one.
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicalizeJcs,
  decodeStrictUtf8,
  ed25519KeyFromSpki,
  isCanonicalEd25519Signature,
  isPlainObject,
  isSoundEd25519Point,
  type PublicVerificationKey,
  type SignatureEnvelope,
} from "../domain/index.ts";

export const ERASURE_CHECKPOINT_FORMAT = "ductura.erasure-checkpoint.v1";
const ERASURE_CHAIN = "ductura.erasure-chain.v1";
// Bytes put in front of the JCS text of the payload before it is signed, so
// the signature of a checkpoint is never valid for any other signed object.
const SIGNING_CONTEXT = `${ERASURE_CHECKPOINT_FORMAT}\u0000`;
/** The head of the chain over no records. */
export const ERASURE_CHAIN_GENESIS = "0".repeat(64);
/** Upper bound of records in one checkpoint, asked before anything is hashed. */
export const MAX_ERASURE_CHECKPOINT_RECORDS = 100_000;
/** Upper bound of the stored checkpoint, asked before it is decoded. */
export const MAX_ERASURE_CHECKPOINT_BYTES = 4096;

// The closed lists of evidence.erasure (20261125100000_erasure_tombstone.sql);
// a later step (M10.2) widens them together with the migration that does.
export const ERASURE_DATA_CLASSES = ["access_log"] as const;
export const ERASURE_REASONS = ["retention_expired", "erasure_request"] as const;
export type ErasureDataClass = (typeof ERASURE_DATA_CLASSES)[number];
export type ErasureReason = (typeof ERASURE_REASONS)[number];

/**
 * One tombstone as the database adapter gives it: the columns of
 * evidence.erasure in camelCase, `erasedAt` in UTC with six fraction digits
 * (the precision of timestamptz), so one instant has one spelling.
 */
export type ErasureTombstone = {
  id: string;
  institutionId: string;
  dataClass: ErasureDataClass;
  subjectId: string;
  contentSha256: string;
  reason: ErasureReason;
  jobId: string | null;
  erasedAt: string;
};

export type ErasureCheckpointPayload = {
  format: typeof ERASURE_CHECKPOINT_FORMAT;
  institutionId: string;
  recordCount: number;
  chainHead: string;
  lastRecordId: string | null;
  lastErasedAt: string | null;
};

export type SignedErasureCheckpoint = {
  payload: ErasureCheckpointPayload;
  signature: SignatureEnvelope;
};

/** What `verifyErasureCheckpoint` can say. Never carries an input value. */
export type ErasureCheckpointProblem =
  | "checkpoint_malformed"
  | "records_malformed"
  | "key_invalid"
  | "key_mismatch"
  | "signature_invalid"
  | "institution_mismatch"
  | "count_mismatch"
  | "chain_mismatch"
  | "verification_unavailable";

export type ErasureCheckpointVerification =
  { ok: true } | { ok: false; problem: ErasureCheckpointProblem };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UTC_MICROS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Control characters, as `[[:cntrl:]]` in the CHECK of subject_id.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const RECORD_KEYS = [
  "id",
  "institutionId",
  "dataClass",
  "subjectId",
  "contentSha256",
  "reason",
  "jobId",
  "erasedAt",
];
const PAYLOAD_KEYS = [
  "format",
  "institutionId",
  "recordCount",
  "chainHead",
  "lastRecordId",
  "lastErasedAt",
];
const SIGNATURE_KEYS = [
  "algorithm",
  "keyId",
  "keyVersion",
  "signatureEncoding",
  "signatureBase64Url",
];
const KEY_KEYS = ["algorithm", "keyId", "keyVersion", "encoding", "keyBase64Url"];

class CryptoUnavailable extends Error {}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** A real UTC instant in the one spelling `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
function isUtcMicros(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 27) return false;
  const parts = UTC_MICROS.exec(value);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

/**
 * Reads each field of a record once into a new plain object, so a getter or
 * a proxy cannot answer the check and the hash differently. `null` for
 * anything that is not a tombstone as evidence.erasure would hold it.
 */
export function readErasureTombstone(value: unknown): ErasureTombstone | null {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) return null;
  const record = {
    id: value.id,
    institutionId: value.institutionId,
    dataClass: value.dataClass,
    subjectId: value.subjectId,
    contentSha256: value.contentSha256,
    reason: value.reason,
    jobId: value.jobId,
    erasedAt: value.erasedAt,
  };
  const subjectOk =
    isBoundedText(record.subjectId, 256) &&
    record.subjectId === record.subjectId.trim() &&
    !CONTROL.test(record.subjectId);
  if (
    !isUuid(record.id) ||
    !isUuid(record.institutionId) ||
    !(ERASURE_DATA_CLASSES as readonly unknown[]).includes(record.dataClass) ||
    !subjectOk ||
    typeof record.contentSha256 !== "string" ||
    !SHA256_HEX.test(record.contentSha256) ||
    !(ERASURE_REASONS as readonly unknown[]).includes(record.reason) ||
    !(record.jobId === null || isUuid(record.jobId)) ||
    !isUtcMicros(record.erasedAt)
  ) {
    return null;
  }
  return record as ErasureTombstone;
}

/** The records in order, each read once, or `null` for any bad one or a repeated id. */
export function readErasureTombstones(value: unknown): ErasureTombstone[] | null {
  if (!Array.isArray(value) || value.length > MAX_ERASURE_CHECKPOINT_RECORDS) return null;
  const records: ErasureTombstone[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const record = readErasureTombstone(value[index]);
    if (record === null || ids.has(record.id)) return null;
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

/** SHA-256 of the UTF-8 of `text`, as 64 lowercase hex digits. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The head of the chain over `records` in this order: each link hashes the
 * previous head together with the whole record, so a changed, removed, added
 * or moved record changes every head after it.
 */
export async function erasureChainHead(records: readonly ErasureTombstone[]): Promise<string> {
  let head = ERASURE_CHAIN_GENESIS;
  for (const record of records) {
    head = sha256Hex(canonicalizeJcs({ chain: ERASURE_CHAIN, previous: head, record }));
  }
  return head;
}

/** The payload a checkpoint signs for these records (already read). */
export async function erasureCheckpointPayload(
  institutionId: string,
  records: readonly ErasureTombstone[],
): Promise<ErasureCheckpointPayload> {
  const last = records.at(-1);
  return {
    format: ERASURE_CHECKPOINT_FORMAT,
    institutionId,
    recordCount: records.length,
    chainHead: await erasureChainHead(records),
    lastRecordId: last?.id ?? null,
    lastErasedAt: last?.erasedAt ?? null,
  };
}

/** The bytes the signing port signs: a fixed context, then the JCS of the payload. */
export function erasureCheckpointSigningInput(
  payload: ErasureCheckpointPayload,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(SIGNING_CONTEXT + canonicalizeJcs(payload));
}

/** The stored form: the JCS text of the signed checkpoint as UTF-8. */
export function encodeErasureCheckpoint(
  checkpoint: SignedErasureCheckpoint,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalizeJcs(checkpoint));
}

function readPayload(value: unknown): ErasureCheckpointPayload | null {
  if (!isPlainObject(value) || !hasExactKeys(value, PAYLOAD_KEYS)) return null;
  const payload = {
    format: value.format,
    institutionId: value.institutionId,
    recordCount: value.recordCount,
    chainHead: value.chainHead,
    lastRecordId: value.lastRecordId,
    lastErasedAt: value.lastErasedAt,
  };
  const empty = payload.recordCount === 0;
  if (
    payload.format !== ERASURE_CHECKPOINT_FORMAT ||
    !isUuid(payload.institutionId) ||
    !Number.isSafeInteger(payload.recordCount) ||
    (payload.recordCount as number) < 0 ||
    (payload.recordCount as number) > MAX_ERASURE_CHECKPOINT_RECORDS ||
    typeof payload.chainHead !== "string" ||
    !SHA256_HEX.test(payload.chainHead) ||
    (empty ? payload.lastRecordId !== null : !isUuid(payload.lastRecordId)) ||
    (empty ? payload.lastErasedAt !== null : !isUtcMicros(payload.lastErasedAt))
  ) {
    return null;
  }
  return payload as ErasureCheckpointPayload;
}

function readSignature(value: unknown): SignatureEnvelope | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNATURE_KEYS)) return null;
  const signature = {
    algorithm: value.algorithm,
    keyId: value.keyId,
    keyVersion: value.keyVersion,
    signatureEncoding: value.signatureEncoding,
    signatureBase64Url: value.signatureBase64Url,
  };
  if (
    signature.algorithm !== "Ed25519" ||
    signature.signatureEncoding !== "raw" ||
    !isBoundedText(signature.keyId, 2048) ||
    !isBoundedText(signature.keyVersion, 256) ||
    typeof signature.signatureBase64Url !== "string" ||
    signature.signatureBase64Url.length !== 86 ||
    !BASE64URL.test(signature.signatureBase64Url)
  ) {
    return null;
  }
  return signature as SignatureEnvelope;
}

function readPublicKey(value: unknown): PublicVerificationKey | null {
  if (!isPlainObject(value) || !hasExactKeys(value, KEY_KEYS)) return null;
  const key = {
    algorithm: value.algorithm,
    keyId: value.keyId,
    keyVersion: value.keyVersion,
    encoding: value.encoding,
    keyBase64Url: value.keyBase64Url,
  };
  if (
    key.algorithm !== "Ed25519" ||
    key.encoding !== "spki-der" ||
    !isBoundedText(key.keyId, 2048) ||
    !isBoundedText(key.keyVersion, 256) ||
    typeof key.keyBase64Url !== "string" ||
    key.keyBase64Url.length !== 59 ||
    !BASE64URL.test(key.keyBase64Url)
  ) {
    return null;
  }
  return key as PublicVerificationKey;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Unpadded base64url of exactly `length` bytes in its one spelling, or null:
 * the bits left over after the last byte must be zero, so no two texts give
 * the same bytes. Decoded by arithmetic, as server code builds no text.
 */
function decodeBase64Url(text: string, length: number): Uint8Array<ArrayBuffer> | null {
  if (text.length !== Math.ceil((length * 4) / 3)) return null;
  const bytes = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const char of text) {
    const digit = BASE64URL_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    buffer = ((buffer << 6) | digit) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }
  return written === length && (buffer & ((1 << bits) - 1)) === 0 ? bytes : null;
}

/** The signed checkpoint from its stored bytes, only if they are its exact JCS form. */
function decodeStored(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ERASURE_CHECKPOINT_BYTES) return null;
  const copy = new Uint8Array(bytes);
  // Strict UTF-8; a kept byte order mark is a character, so it fails to parse.
  const text = decodeStrictUtf8(copy);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const again = new TextEncoder().encode(canonicalizeJcs(parsed));
  return again.byteLength === copy.byteLength && again.every((byte, index) => byte === copy[index])
    ? parsed
    : null;
}

function readCheckpoint(value: unknown): SignedErasureCheckpoint | null {
  const source = value instanceof Uint8Array ? decodeStored(value) : value;
  if (!isPlainObject(source) || !hasExactKeys(source, ["payload", "signature"])) return null;
  const payload = readPayload(source.payload);
  const signature = readSignature(source.signature);
  return payload === null || signature === null ? null : { payload, signature };
}

async function signatureVerifies(
  checkpoint: SignedErasureCheckpoint,
  key: PublicVerificationKey,
): Promise<ErasureCheckpointProblem | null> {
  // An Ed25519 key in SPKI DER is 44 bytes (RFC 8410). A point of small or
  // mixed order is judged here, not by the runtime, as for receipts.
  const spki = decodeBase64Url(key.keyBase64Url, 44);
  const point = spki === null ? null : ed25519KeyFromSpki(spki);
  if (point === null || !isSoundEd25519Point(point)) return "key_invalid";
  if (
    key.keyId !== checkpoint.signature.keyId ||
    key.keyVersion !== checkpoint.signature.keyVersion
  ) {
    return "key_mismatch";
  }
  const signature = decodeBase64Url(checkpoint.signature.signatureBase64Url, 64);
  if (signature === null || !isCanonicalEd25519Signature(signature)) return "signature_invalid";
  // The 12 bytes of the SPKI prefix are 16 base64url characters exactly, so
  // the rest of the text is the base64url of the 32-byte point (JWK `x`).
  let valid: boolean;
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.keyBase64Url.slice(16) },
      format: "jwk",
    });
    valid = verify(null, erasureCheckpointSigningInput(checkpoint.payload), publicKey, signature);
  } catch {
    throw new CryptoUnavailable();
  }
  return valid ? null : "signature_invalid";
}

/**
 * Whether `checkpoint` (its stored bytes or the signed object) is signed by
 * `publicKey` and commits to exactly `records`, in this order. The signature
 * is checked first, so nothing a checkpoint says is trusted before it.
 */
export async function verifyErasureCheckpoint(
  checkpoint: unknown,
  records: unknown,
  publicKey: unknown,
): Promise<ErasureCheckpointVerification> {
  const refuse = (problem: ErasureCheckpointProblem): ErasureCheckpointVerification => ({
    ok: false,
    problem,
  });
  try {
    const signed = readCheckpoint(checkpoint);
    if (signed === null) return refuse("checkpoint_malformed");
    const key = readPublicKey(publicKey);
    if (key === null) return refuse("key_invalid");
    const signatureProblem = await signatureVerifies(signed, key);
    if (signatureProblem !== null) return refuse(signatureProblem);

    const read = readErasureTombstones(records);
    if (read === null) return refuse("records_malformed");
    if (read.some((record) => record.institutionId !== signed.payload.institutionId)) {
      return refuse("institution_mismatch");
    }
    if (read.length !== signed.payload.recordCount) return refuse("count_mismatch");
    const expected = await erasureCheckpointPayload(signed.payload.institutionId, read);
    return canonicalizeJcs(expected) === canonicalizeJcs(signed.payload)
      ? { ok: true }
      : refuse("chain_mismatch");
  } catch (error) {
    if (error instanceof CryptoUnavailable) return refuse("verification_unavailable");
    return refuse("checkpoint_malformed");
  }
}
