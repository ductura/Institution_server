// The signed daily root of the evidence log (SRV-1311; plan M3.9, B5; D-72
// decided in D-209). Once a day the worker computes the Merkle root over the
// evidence log entries of one UTC day with the tree of D-93
// (evidence-log-merkle: RFC 9162 leaves and nodes, leaf order by acceptedAt,
// then the UTF-8 bytes of receiptId), signs it with Ed25519 through the key
// port and stores the record { day, root, count, keyId, signature }.
//
// Pure apart from node:crypto: no I/O, no clock. The same entries give the
// same root in any input order, and Ed25519 is deterministic, so the same
// day signed by the same key is the same bytes. The check answers ok or a
// closed code; no input value is ever put into one. The CLI
// scripts/evidence-verify runs the same check with no network and no database.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  canonicalizeJcs,
  canonicalInstant,
  decodeStrictUtf8,
  ed25519KeyFromSpki,
  evidenceLogLeafHash,
  evidenceLogRoot,
  isCanonicalEd25519Signature,
  isPlainObject,
  isSoundEd25519Point,
  orderEvidenceLogEntries,
} from "../../domain/index.ts";

export const DAILY_ROOT_FORMAT = "ductura.evidence-daily-root.v1";
// Bytes put in front of the JCS text of the signed fields, so the signature of
// a daily root is never valid for any other signed object (D-92 uses
// "ductus-evidence-receipt-v2" ‖ LF in the same way).
const SIGNING_CONTEXT = `${DAILY_ROOT_FORMAT}\n`;
/** Upper bound of entries in one day, asked before anything is hashed. */
export const MAX_DAILY_ROOT_ENTRIES = 1_000_000;
/** Upper bound of the stored record, asked before it is decoded. */
export const MAX_DAILY_ROOT_RECORD_BYTES = 4096;
/** One UTC day in milliseconds. */
export const DAY_MS = 86_400_000;
/** The longest key id a record carries (as SignatureEnvelope.keyId). */
export const MAX_KEY_ID_LENGTH = 2048;

/**
 * One entry of the evidence log as the reader port gives it and as one line
 * of the CLI's NDJSON file holds it: the receipt id, its canonical UTC
 * acceptance time and D, the 32-byte receipt digest of its schema (D-92,
 * D-93), as 64 lowercase hex digits.
 */
export type DailyRootEntry = {
  receiptId: string;
  acceptedAt: string;
  digest: string;
};

/** The signed record of one day. `root` is hex, `signature` raw Ed25519 in unpadded base64url. */
export type DailyRootRecord = {
  day: string;
  root: string;
  count: number;
  keyId: string;
  signature: string;
};

/** The fields the signature covers: the record without its signature. */
export type DailyRootPayload = Omit<DailyRootRecord, "signature">;

/** What `verifyDailyRoot` can say. Never carries an input value. */
export type DailyRootProblem =
  | "record_malformed"
  | "entries_malformed"
  | "key_invalid"
  | "signature_invalid"
  | "entry_outside_day"
  | "count_mismatch"
  | "root_mismatch"
  | "verification_unavailable";

export type DailyRootVerification = { ok: true } | { ok: false; problem: DailyRootProblem };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const RECORD_KEYS = ["day", "root", "count", "keyId", "signature"];
const ENTRY_KEYS = ["receiptId", "acceptedAt", "digest"];
/** The longest receipt id an entry carries (as evidence.receipt ids, with room). */
const MAX_RECEIPT_ID_LENGTH = 256;

class CryptoUnavailable extends Error {}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The start of `day` (`YYYY-MM-DD`, a real calendar day) in UTC, or null. */
export function dayStart(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const parts = DAY.exec(day);
  if (parts === null) return null;
  const [year, month, date] = parts.slice(1).map(Number) as [number, number, number];
  const start = Date.UTC(year, month - 1, date);
  const back = new Date(start);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === date &&
    year >= 1970
    ? start
    : null;
}

/** The UTC day (`YYYY-MM-DD`) an instant falls on. */
export function dayOf(time: number): string {
  return new Date(Math.floor(time / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One entry read once into a new plain object, or null. */
export function readDailyRootEntry(value: unknown): DailyRootEntry | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_KEYS)) return null;
  const entry = {
    receiptId: value.receiptId,
    acceptedAt: value.acceptedAt,
    digest: value.digest,
  };
  if (
    typeof entry.receiptId !== "string" ||
    entry.receiptId.length === 0 ||
    entry.receiptId.length > MAX_RECEIPT_ID_LENGTH ||
    CONTROL.test(entry.receiptId) ||
    !canonicalInstant(entry.acceptedAt) ||
    typeof entry.digest !== "string" ||
    !SHA256_HEX.test(entry.digest)
  ) {
    return null;
  }
  return entry as DailyRootEntry;
}

/**
 * The entries in leaf order, each read once, or null for a bad entry, a
 * repeated receipt id or more than MAX_DAILY_ROOT_ENTRIES.
 */
export function readDailyRootEntries(value: unknown): DailyRootEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_DAILY_ROOT_ENTRIES) return null;
  const entries: DailyRootEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = readDailyRootEntry(value[index]);
    if (entry === null) return null;
    entries.push(entry);
  }
  try {
    // Throws on a repeated receipt id or a malformed one.
    return orderEvidenceLogEntries(entries);
  } catch {
    return null;
  }
}

/** Whether every entry was accepted on `day` (UTC). */
export function entriesOnDay(entries: readonly DailyRootEntry[], day: string): boolean {
  const start = dayStart(day);
  if (start === null) return false;
  return entries.every((entry) => {
    const time = Date.parse(entry.acceptedAt);
    return time >= start && time < start + DAY_MS;
  });
}

/** The Merkle root (hex) over entries already read and ordered. The empty day is SHA-256 of no bytes. */
export async function dailyRootOf(entries: readonly DailyRootEntry[]): Promise<string> {
  const leaves: Uint8Array[] = [];
  for (const entry of entries) leaves.push(await evidenceLogLeafHash(hexBytes(entry.digest)));
  return toHex(await evidenceLogRoot(leaves));
}

/** The payload the key signs for `day` over entries already read and ordered. */
export async function dailyRootPayload(
  day: string,
  entries: readonly DailyRootEntry[],
  keyId: string,
): Promise<DailyRootPayload> {
  return { day, root: await dailyRootOf(entries), count: entries.length, keyId };
}

/** The bytes the signing port signs: a fixed context line, then the JCS of the payload. */
export function dailyRootSigningInput(payload: DailyRootPayload): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    SIGNING_CONTEXT +
      canonicalizeJcs({
        day: payload.day,
        root: payload.root,
        count: payload.count,
        keyId: payload.keyId,
      }),
  );
}

/** The stored form: the JCS text of the record as UTF-8. */
export function encodeDailyRoot(record: DailyRootRecord): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalizeJcs(record));
}

/** SHA-256 of the UTF-8 of `text`, as 64 lowercase hex digits. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The record read once into a new plain object, or null. */
export function readDailyRootRecord(value: unknown): DailyRootRecord | null {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) return null;
  const record = {
    day: value.day,
    root: value.root,
    count: value.count,
    keyId: value.keyId,
    signature: value.signature,
  };
  if (
    dayStart(record.day) === null ||
    typeof record.root !== "string" ||
    !SHA256_HEX.test(record.root) ||
    !Number.isSafeInteger(record.count) ||
    (record.count as number) < 0 ||
    (record.count as number) > MAX_DAILY_ROOT_ENTRIES ||
    typeof record.keyId !== "string" ||
    record.keyId.length === 0 ||
    record.keyId.length > MAX_KEY_ID_LENGTH ||
    CONTROL.test(record.keyId) ||
    typeof record.signature !== "string" ||
    !BASE64URL.test(record.signature)
  ) {
    return null;
  }
  return record as DailyRootRecord;
}

/** The record from its stored bytes or as parsed JSON, or null. */
function decodeRecord(value: unknown): DailyRootRecord | null {
  if (!(value instanceof Uint8Array)) return readDailyRootRecord(value);
  if (value.byteLength === 0 || value.byteLength > MAX_DAILY_ROOT_RECORD_BYTES) return null;
  // Strict UTF-8; a kept byte order mark is a character, so it fails to parse.
  const text = decodeStrictUtf8(new Uint8Array(value));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return readDailyRootRecord(parsed);
}

/** Unpadded base64url of exactly `length` bytes in its one spelling, or null. */
function decodeBase64Url(text: string, length: number): Uint8Array | null {
  const bytes = Buffer.from(text, "base64url");
  if (bytes.byteLength !== length || bytes.toString("base64url") !== text) return null;
  return new Uint8Array(bytes);
}

/**
 * An Ed25519 public key from PEM (SPKI) text or SPKI DER bytes, or null. A
 * point of small or mixed order is refused here, not left to the runtime.
 */
export function dailyRootPublicKey(source: string | Uint8Array): KeyObject | null {
  let key: KeyObject;
  try {
    key =
      typeof source === "string"
        ? createPublicKey({ key: source, format: "pem" })
        : createPublicKey({ key: Buffer.from(source), format: "der", type: "spki" });
  } catch {
    return null;
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
  const spki = new Uint8Array(key.export({ format: "der", type: "spki" }));
  const point = ed25519KeyFromSpki(spki);
  return point !== null && isSoundEd25519Point(point) ? key : null;
}

function signatureVerifies(record: DailyRootRecord, key: KeyObject): boolean {
  const signature = decodeBase64Url(record.signature, 64);
  if (signature === null || !isCanonicalEd25519Signature(signature)) return false;
  try {
    return verify(null, dailyRootSigningInput(record), key, signature);
  } catch {
    throw new CryptoUnavailable();
  }
}

/**
 * Whether `record` (its stored bytes or the parsed object) is signed by
 * `publicKey` and commits to exactly `entries` (any order) of its day. The
 * signature is checked first, so nothing the record says is trusted before
 * it. A changed, removed or added entry and a wrong key each fail.
 */
export async function verifyDailyRoot(
  record: unknown,
  entries: unknown,
  publicKey: KeyObject | null,
): Promise<DailyRootVerification> {
  const refuse = (problem: DailyRootProblem): DailyRootVerification => ({ ok: false, problem });
  try {
    const signed = decodeRecord(record);
    if (signed === null) return refuse("record_malformed");
    if (publicKey === null || publicKey.asymmetricKeyType !== "ed25519")
      return refuse("key_invalid");
    if (!signatureVerifies(signed, publicKey)) return refuse("signature_invalid");

    const read = readDailyRootEntries(entries);
    if (read === null) return refuse("entries_malformed");
    if (!entriesOnDay(read, signed.day)) return refuse("entry_outside_day");
    if (read.length !== signed.count) return refuse("count_mismatch");
    return (await dailyRootOf(read)) === signed.root ? { ok: true } : refuse("root_mismatch");
  } catch (error) {
    if (error instanceof CryptoUnavailable) return refuse("verification_unavailable");
    return refuse("record_malformed");
  }
}
