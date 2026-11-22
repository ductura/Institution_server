// The ZIP container of a DOCX (SRV-1803, M8.2; ADR docs/adr/import-contract.md
// §4 and attack class Z). Everything is decided from the central directory
// before a byte is inflated: the number of entries, the declared size of each
// part and of all parts, the ratio of each part, encryption, the path and a
// duplicate name. A part is inflated only when the reader asks for it, never
// beyond its declared size: an entry whose local header or inflated bytes
// disagree with the central directory is ZIP_INVALID (Z3), and the bytes that
// count are the ones really inflated. ZIP64, multi-disk archives, methods
// other than stored and deflate, overlapping entries and a bad CRC-32 are
// refused. A refusal is a code only, never a name or a byte of the input.
// OSN-B2 (Ductus DAN-242 hardening, F-262 to F-264): exactly one end record
// and no signature after it, no ZIP64 locator, no entry comment, extra fields
// read as whole records (Info-ZIP Unicode Path and Comment and ZIP64 refused),
// the entries tile the file with nothing hidden between them, both headers
// agree on flags and version, and a deflate stream ends exactly at the end of
// its data.
// The browser build: plain JS, no worker threads and no createRequire in the bundle.
import { Inflate } from "fflate/browser";

import type { ImportReadLimitsV1, ImportReadRejectCode } from "../../contracts/index.ts";
import { decodeStrictUtf8 } from "../../domain/index.ts";

export type ZipEntry = {
  /** The part name as stored, without a leading slash. */
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataStart: number;
};

export type ZipArchive = {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  /** The inflated bytes of one part by its lowercase name, or a refusal. */
  read(name: string): ZipRead;
};

export type ZipRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: ImportReadRejectCode };
export type ZipOpen =
  | { readonly ok: true; readonly archive: ZipArchive }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** Compressed bytes pushed at once: at most about 1032 times this comes out of one push. */
const INFLATE_STEP = 1024;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_DIRECTORY_ENCRYPTED = 0x2000;
const FLAG_PATCHED = 0x0020;
const FLAG_DESCRIBED = 0x0008;
const FLAG_UTF8 = 0x0800;
const ENCRYPTED = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_DIRECTORY_ENCRYPTED;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UNICODE_PATH = 0x7075;
const UNICODE_COMMENT = 0x6375;
const METHOD_AES = 99;
/** The highest "version needed to extract" (6.3); the high byte of the field names the host. */
const MAX_VERSION = 63;

/** Thrown inside the inflate callback when a part grows past its bound. */
class Overflow extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A part name a package may hold (OPC part names, attack Z5): relative, plain
 * segments separated by "/", none empty, "." or "..", no backslash, colon or
 * control character. A directory entry ends with "/" and has no bytes.
 */
function isPartPath(name: string): boolean {
  if (name === "" || name.length > 1024) return false;
  if (/[\\:\p{Cc}\ufeff]/u.test(name)) return false;
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** OPC part names compare without case and in NFC: two spellings are one part. */
const keyOf = (name: string): string => name.normalize("NFC").toLowerCase();

/**
 * The end record is the one whose comment ends exactly at the end of the file.
 * A second such record (for example inside the comment) makes the file
 * ambiguous: -1. Some readers take the last signature without checking its
 * comment length, so no signature may follow the chosen record either (Z2).
 */
function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  let found = -1;
  for (let at = last; at >= first; at -= 1) {
    if (
      view.getUint32(at, true) === EOCD_SIGNATURE &&
      at + EOCD_SIZE + view.getUint16(at + 20, true) === view.byteLength
    ) {
      if (found !== -1) return -1;
      found = at;
    }
  }
  if (found === -1) return -1;
  for (let at = found + 1; at + 4 <= view.byteLength; at += 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return -1;
  }
  return found;
}

/**
 * An extra field must be whole records (16-bit id, 16-bit length, data), so no
 * record can hide from this walk while another reader still finds it. Info-ZIP
 * Unicode Path renames the entry in readers that honour it, Unicode Comment is
 * the same mechanism, and ZIP64 sizes would replace the directory's: all
 * three are refused (F-262).
 */
function extraFieldOk(
  extra: Uint8Array,
  pathCode: ImportReadRejectCode,
): ImportReadRejectCode | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let at = 0;
  while (at < extra.length) {
    if (at + 4 > extra.length) return "ZIP_INVALID";
    const id = view.getUint16(at, true);
    at += 4 + view.getUint16(at + 2, true);
    if (at > extra.length) return "ZIP_INVALID";
    if (id === UNICODE_PATH) return pathCode;
    if (id === UNICODE_COMMENT || id === ZIP64_EXTRA) return "ZIP_INVALID";
  }
  return null;
}

/** Bounded raw inflate: null when the stream is broken or grows past `limit`. */
function inflateBounded(data: Uint8Array, limit: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new Overflow();
    chunks.push(chunk);
    if (final) finished = true;
  });
  try {
    if (data.length === 0) inflater.push(data, true);
    for (let at = 0; at < data.length; at += INFLATE_STEP) {
      inflater.push(data.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= data.length);
    }
  } catch {
    return null;
  }
  if (!finished) return null;
  // The stream must end exactly at the end of the data (F-263): the inflater
  // keeps what it did not consume, which after a clean end is nothing, or the
  // one byte that holds the last bits when the final block ends mid-byte.
  // fflate is pinned to one exact version, and the rows H5 and H6 of
  // zip-hardening.test.ts fail if this state ever stops meaning that.
  const left = inflater as unknown as { p: Uint8Array; s: { p: number } };
  if (left.p.length !== (left.s.p === 0 ? 0 : 1)) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Opens a ZIP and checks its whole central directory against the limits.
 * Nothing is inflated here.
 */
export function openZip(bytes: Uint8Array, limits: ImportReadLimitsV1): ZipOpen {
  const fail = (code: ImportReadRejectCode): ZipOpen => ({ ok: false, code });
  if (bytes.length < EOCD_SIZE) return fail("ZIP_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return fail("ZIP_INVALID");
  // A ZIP64 reader looks for its locator right before the end record and then
  // reads a different directory, so those bytes may not carry its signature (F-262).
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) return fail("ZIP_INVALID");
  const disk = u16(eocd + 4);
  const centralDisk = u16(eocd + 6);
  const onDisk = u16(eocd + 8);
  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  // No multi-disk archive and no ZIP64 (its markers are the all-ones values).
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count) return fail("ZIP_INVALID");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    return fail("ZIP_INVALID");
  if (count > limits.maxEntries) return fail("ZIP_TOO_MANY_ENTRIES");
  // The directory ends exactly where the end record starts.
  if (centralOffset + centralSize !== eocd) return fail("ZIP_INVALID");

  type Placed = {
    start: number;
    end: number;
    descriptor: boolean;
    crc: number;
    csize: number;
    usize: number;
  };
  const entries = new Map<string, ZipEntry>();
  const placed: Placed[] = [];
  let total = 0;
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_SIZE > eocd) return fail("ZIP_INVALID");
    if (u32(at) !== CENTRAL_SIGNATURE) return fail("ZIP_INVALID");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const uncompressedSize = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const startDisk = u16(at + 34);
    const localOffset = u32(at + 42);
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > eocd) return fail("ZIP_INVALID");
    const nameBytes = bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    // Without the UTF-8 flag other readers take non-ASCII bytes as CP437 (Z6).
    if ((flags & FLAG_UTF8) === 0 && nameBytes.some((byte) => byte >= 0x80))
      return fail("ZIP_PATH_INVALID");
    const name = decodeStrictUtf8(nameBytes);
    if (name === null || !isPartPath(name)) return fail("ZIP_PATH_INVALID");
    const extraCode = extraFieldOk(
      bytes.subarray(at + CENTRAL_SIZE + nameLength, at + CENTRAL_SIZE + nameLength + extraLength),
      "ZIP_PATH_INVALID",
    );
    if (extraCode !== null) return fail(extraCode);
    if (flags & ENCRYPTED || method === METHOD_AES) return fail("ZIP_ENCRYPTED");
    if (method !== 0 && method !== 8) return fail("ZIP_INVALID");
    // Entry comments are text some readers show and others skip, and a stored
    // part has no end of its own, so a reader that walks local headers cannot
    // find where its data descriptor starts (F-262, F-264).
    if (commentLength !== 0 || (method === 0 && flags & FLAG_DESCRIBED)) return fail("ZIP_INVALID");
    // A start disk other than 0 is a split archive, and the all-ones values point to ZIP64.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk !== 0
    )
      return fail("ZIP_INVALID");
    // Patched data and versions past 6.3 are features other readers refuse.
    if (flags & FLAG_PATCHED || (u16(at + 6) & 0xff) > MAX_VERSION) return fail("ZIP_INVALID");
    // OPC part names compare without case and in NFC: two spellings are one part.
    const key = keyOf(name);
    if (entries.has(key)) return fail("ZIP_DUPLICATE_ENTRY");
    if (uncompressedSize > limits.maxPartBytes) return fail("ZIP_PART_TOO_LARGE");
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) return fail("ZIP_TOTAL_TOO_LARGE");
    if (uncompressedSize > compressedSize * limits.maxRatio && uncompressedSize > 0)
      return fail("ZIP_RATIO_EXCEEDED");
    if (method === 0 && compressedSize !== uncompressedSize) return fail("ZIP_INVALID");
    if (name.endsWith("/") && uncompressedSize !== 0) return fail("ZIP_INVALID");

    // The local header must agree with the central directory (Z3), so that no
    // other ZIP reader can see a different file in the same bytes.
    if (localOffset + LOCAL_SIZE > centralOffset) return fail("ZIP_INVALID");
    if (u32(localOffset) !== LOCAL_SIGNATURE) return fail("ZIP_INVALID");
    const localFlags = u16(localOffset + 6);
    const localMethod = u16(localOffset + 8);
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    if (localFlags & ENCRYPTED) return fail("ZIP_ENCRYPTED");
    if (localFlags & FLAG_PATCHED || (u16(localOffset + 4) & 0xff) > MAX_VERSION)
      return fail("ZIP_INVALID");
    const dataStart = localOffset + LOCAL_SIZE + localNameLength + localExtraLength;
    if (dataStart > centralOffset) return fail("ZIP_INVALID");
    const localExtraCode = extraFieldOk(
      bytes.subarray(localOffset + LOCAL_SIZE + localNameLength, dataStart),
      "ZIP_PATH_INVALID",
    );
    if (localExtraCode !== null) return fail(localExtraCode);
    // With a data descriptor the local CRC and sizes may be left zero, but any
    // other value is what a streaming reader uses, so it must agree (F-264).
    const deferred = (localFlags & FLAG_DESCRIBED) !== 0;
    const agrees = (field: number, value: number): boolean =>
      u32(field) === value || (deferred && u32(field) === 0);
    const sameSizes =
      agrees(localOffset + 14, crc) &&
      agrees(localOffset + 18, compressedSize) &&
      agrees(localOffset + 22, uncompressedSize);
    // The name encoding and the data descriptor flag change how a reader reads
    // the name and finds the end of the data, so both headers carry the same ones.
    const sameFlags = ((localFlags ^ flags) & (FLAG_DESCRIBED | FLAG_UTF8)) === 0;
    const localName = bytes.subarray(
      localOffset + LOCAL_SIZE,
      localOffset + LOCAL_SIZE + localNameLength,
    );
    if (
      localMethod !== method ||
      localNameLength !== nameLength ||
      !sameSizes ||
      !sameFlags ||
      !localName.every((byte, i) => byte === nameBytes[i])
    )
      return fail("ZIP_INVALID");
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) return fail("ZIP_INVALID");
    placed.push({
      start: localOffset,
      end: dataEnd,
      descriptor: deferred,
      crc,
      csize: compressedSize,
      usize: uncompressedSize,
    });

    if (!name.endsWith("/")) {
      entries.set(key, {
        name,
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        dataStart,
      });
    }
    at = next;
  }
  if (at !== eocd) return fail("ZIP_INVALID");

  // Entries tile the file from offset 0 up to the central directory: each is
  // followed by the next, or by its own data descriptor and then the next, so
  // no bytes hide between them for a reader that walks local headers, and no
  // two entries share bytes (an overlapping archive is a known zip bomb).
  placed.sort((a, b) => a.start - b.start);
  let edge = 0;
  for (let i = 0; i < placed.length; i += 1) {
    const entry = placed[i]!;
    if (entry.start !== edge) return fail("ZIP_INVALID");
    edge = entry.end;
    if (!entry.descriptor) continue;
    // A descriptor is 12 bytes, or 16 with its optional signature, and its CRC
    // may equal that signature. Only one length can end where the next entry
    // (or the directory) starts, and its fields must match the directory.
    const following = i + 1 < placed.length ? placed[i + 1]!.start : centralOffset;
    const fits = (length: number): boolean =>
      edge + length === following &&
      (length === 12 || u32(edge) === DESCRIPTOR_SIGNATURE) &&
      u32(following - 12) === entry.crc &&
      u32(following - 8) === entry.csize &&
      u32(following - 4) === entry.usize;
    if (!fits(12) && !fits(16)) return fail("ZIP_INVALID");
    edge = following;
  }
  if (edge !== centralOffset) return fail("ZIP_INVALID");

  const read = (name: string): ZipRead => {
    const entry = entries.get(keyOf(name));
    if (entry === undefined) return { ok: false, code: "PACKAGE_INVALID" };
    const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    const inflated =
      entry.method === 0 ? Uint8Array.from(data) : inflateBounded(data, entry.uncompressedSize);
    if (inflated === null || inflated.length !== entry.uncompressedSize)
      return { ok: false, code: "ZIP_INVALID" };
    if (crc32(inflated) !== entry.crc32) return { ok: false, code: "ZIP_INVALID" };
    return { ok: true, bytes: inflated };
  };
  return { ok: true, archive: { entries, read } };
}
