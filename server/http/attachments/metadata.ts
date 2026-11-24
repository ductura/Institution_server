import type { WorkAttachmentMediaType } from "../../database/index.ts";

// Segments and chunks that can carry location, device, author or time data.
// Everything else is copied byte for byte, so the pixels decode the same.
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe]); // APP1 (Exif, XMP), APP13 (IPTC), COM
const PNG_DROPPED = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_HEADER_BYTES = 8;
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

/**
 * Collects the kept parts of a file. Neighbouring kept parts are merged into one
 * range, so memory grows with the number of gaps, not with the number of segments.
 */
function keptParts(bytes: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (end > start) parts.push(bytes.subarray(start, end));
  };
  return {
    keep(from: number, to: number) {
      if (from !== end) {
        flush();
        start = from;
      }
      end = to;
    },
    insert(extra: Buffer) {
      flush();
      parts.push(extra);
      start = end;
    },
    join() {
      flush();
      return Buffer.concat(parts);
    },
  };
}

const isExif = (payload: Buffer) => payload.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER);

/** Orientation 2-8 from an Exif TIFF block; undefined for 1, a missing tag or a broken block. */
function exifOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return;
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return;
  const read16 = (at: number) => (order === "II" ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const read32 = (at: number) => (order === "II" ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (read16(2) !== 42) return;
  const ifd = read32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return;
  const count = read16(ifd);
  if (ifd + 2 + count * 12 > tiff.length) return;
  for (let entry = ifd + 2; entry < ifd + 2 + count * 12; entry += 12) {
    if (read16(entry) !== ORIENTATION_TAG) continue;
    if (read16(entry + 2) !== TIFF_SHORT || read32(entry + 4) !== 1) return;
    const value = read16(entry + 8);
    return value >= 2 && value <= 8 ? value : undefined;
  }
}

/** APP1 with a big-endian TIFF block whose only IFD0 entry is Orientation. */
function orientationSegment(value: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM\0*", 0, "latin1");
  tiff.writeUInt32BE(8, 4); // IFD0 right after the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(TIFF_SHORT, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(value, 18); // next IFD offset (bytes 22-25) stays 0
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(2 + EXIF_HEADER.length + tiff.length, 2);
  return Buffer.concat([header, EXIF_HEADER, tiff]);
}

function jpegWithoutMetadata(bytes: Buffer): Buffer | undefined {
  const kept = keptParts(bytes);
  kept.keep(0, 2);
  let exifSeen = false;
  let scanSeen = false;
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return;
    if (marker === 0xd9) {
      // Data after the first EOI (for example a second embedded picture) is dropped.
      kept.keep(start, offset);
      return kept.join();
    }
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    const payload = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xda) {
      scanSeen = true;
      offset = entropyEnd(bytes, offset);
    }
    if (!JPEG_DROPPED.has(marker)) {
      kept.keep(start, offset);
    } else if (marker === 0xe1 && !exifSeen && !scanSeen && isExif(payload)) {
      // Only the first Exif block before the scan counts, as viewers read it.
      exifSeen = true;
      const orientation = exifOrientation(payload.subarray(EXIF_HEADER.length));
      if (orientation !== undefined) kept.insert(orientationSegment(orientation));
    }
  }
}

// Scan data ends at the first marker that is not byte stuffing or a restart marker.
// Fill bytes before that marker belong to the next segment.
function entropyEnd(bytes: Buffer, offset: number): number {
  for (let position = offset; position < bytes.length; position++) {
    if (bytes[position] !== 0xff) continue;
    let next = position + 1;
    while (bytes[next] === 0xff) next++;
    const marker = bytes[next];
    if (marker !== 0x00 && (marker === undefined || marker < 0xd0 || marker > 0xd7)) {
      return position;
    }
    position = next;
  }
  return bytes.length;
}

function pngWithoutMetadata(bytes: Buffer): Buffer | undefined {
  const kept = keptParts(bytes);
  kept.keep(0, PNG_HEADER_BYTES);
  for (let offset = PNG_HEADER_BYTES; offset < bytes.length;) {
    if (bytes.length - offset < 12) return;
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return;
    if (!PNG_DROPPED.has(bytes.toString("latin1", offset + 4, offset + 8))) {
      kept.keep(offset, end);
    }
    offset = end;
  }
  return kept.join();
}

/**
 * Returns the image without metadata segments, or undefined when its structure is
 * broken. A JPEG keeps only its Exif Orientation 2-8, in a new minimal APP1.
 */
export function withoutMetadata(
  bytes: Buffer,
  mediaType: WorkAttachmentMediaType,
): Buffer | undefined {
  return mediaType === "image/png" ? pngWithoutMetadata(bytes) : jpegWithoutMetadata(bytes);
}
