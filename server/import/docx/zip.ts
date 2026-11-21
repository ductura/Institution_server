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
import { Inflate } from "fflate";

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
  if (/[\\:\p{Cc}]/u.test(name)) return false;
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  return -1;
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
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return fail("ZIP_INVALID");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // No multi-disk archive and no ZIP64 (its markers are the all-ones values).
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count) return fail("ZIP_INVALID");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    return fail("ZIP_INVALID");
  if (count > limits.maxEntries) return fail("ZIP_TOO_MANY_ENTRIES");
  if (centralOffset + centralSize > eocd) return fail("ZIP_INVALID");

  const entries = new Map<string, ZipEntry>();
  const ranges: [number, number][] = [];
  let total = 0;
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_SIZE > centralOffset + centralSize) return fail("ZIP_INVALID");
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return fail("ZIP_INVALID");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) return fail("ZIP_INVALID");
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) return fail("ZIP_ENCRYPTED");
    if (method !== 0 && method !== 8) return fail("ZIP_INVALID");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      return fail("ZIP_INVALID");
    const name = decodeStrictUtf8(
      bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength),
    );
    if (name === null || !isPartPath(name)) return fail("ZIP_PATH_INVALID");
    // OPC part names compare without case: two spellings are one part.
    const key = name.toLowerCase();
    if (entries.has(key)) return fail("ZIP_DUPLICATE_ENTRY");
    if (uncompressedSize > limits.maxPartBytes) return fail("ZIP_PART_TOO_LARGE");
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) return fail("ZIP_TOTAL_TOO_LARGE");
    if (uncompressedSize > compressedSize * limits.maxRatio && uncompressedSize > 0)
      return fail("ZIP_RATIO_EXCEEDED");
    if (method === 0 && compressedSize !== uncompressedSize) return fail("ZIP_INVALID");

    // The local header must agree with the central directory (Z3).
    if (localOffset + LOCAL_SIZE > centralOffset) return fail("ZIP_INVALID");
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return fail("ZIP_INVALID");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) return fail("ZIP_ENCRYPTED");
    if (localMethod !== method || localNameLength !== nameLength) return fail("ZIP_INVALID");
    const deferred = (localFlags & 0x0008) !== 0;
    if (!deferred && (localCompressed !== compressedSize || localUncompressed !== uncompressedSize))
      return fail("ZIP_INVALID");
    const localName = bytes.subarray(
      localOffset + LOCAL_SIZE,
      localOffset + LOCAL_SIZE + nameLength,
    );
    const centralName = bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    if (!localName.every((byte, i) => byte === centralName[i])) return fail("ZIP_INVALID");
    const dataStart = localOffset + LOCAL_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) return fail("ZIP_INVALID");
    ranges.push([localOffset, dataEnd]);

    if (!name.endsWith("/")) {
      entries.set(key, {
        name,
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        dataStart,
      });
    } else if (uncompressedSize !== 0) {
      return fail("ZIP_INVALID");
    }
    at = next;
  }
  // Entries never share bytes: an overlapping archive is a known zip bomb.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i]![0] < ranges[i - 1]![1]) return fail("ZIP_INVALID");
  }

  const read = (name: string): ZipRead => {
    const entry = entries.get(name.toLowerCase());
    if (entry === undefined) return { ok: false, code: "PACKAGE_INVALID" };
    const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    const inflated =
      entry.method === 0 ? data.slice() : inflateBounded(data, entry.uncompressedSize);
    if (inflated === null || inflated.length !== entry.uncompressedSize)
      return { ok: false, code: "ZIP_INVALID" };
    if (crc32(inflated) !== entry.crc32) return { ok: false, code: "ZIP_INVALID" };
    return { ok: true, bytes: inflated };
  };
  return { ok: true, archive: { entries, read } };
}
