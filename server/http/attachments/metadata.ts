import type { WorkAttachmentMediaType } from "../../database/index.ts";

// Segments and chunks that can carry location, device, author or time data.
// Everything else is copied byte for byte, so the pixels decode the same.
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe]); // APP1 (Exif, XMP), APP13 (IPTC), COM
const PNG_DROPPED = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_HEADER_BYTES = 8;

function jpegWithoutMetadata(bytes: Buffer): Buffer | undefined {
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return;
    if (marker === 0xd9) {
      // Data after the first EOI (for example a second embedded picture) is dropped.
      kept.push(bytes.subarray(start, offset));
      return Buffer.concat(kept);
    }
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    offset += length;
    if (marker === 0xda) offset = entropyEnd(bytes, offset);
    if (!JPEG_DROPPED.has(marker)) kept.push(bytes.subarray(start, offset));
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
  const kept: Buffer[] = [bytes.subarray(0, PNG_HEADER_BYTES)];
  for (let offset = PNG_HEADER_BYTES; offset < bytes.length;) {
    if (bytes.length - offset < 12) return;
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return;
    if (!PNG_DROPPED.has(bytes.toString("latin1", offset + 4, offset + 8))) {
      kept.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return Buffer.concat(kept);
}

/** Returns the image without metadata segments, or undefined when its structure is broken. */
export function withoutMetadata(
  bytes: Buffer,
  mediaType: WorkAttachmentMediaType,
): Buffer | undefined {
  return mediaType === "image/png" ? pngWithoutMetadata(bytes) : jpegWithoutMetadata(bytes);
}
