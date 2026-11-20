import type { WorkAttachmentMediaType } from "../../database/index.ts";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_END = Buffer.from("0000000049454e44ae426082", "hex");
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

function pngDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 57 || !bytes.subarray(-12).equals(PNG_END)) return;
  let hasData = false;
  const end = bytes.length - PNG_END.length;
  for (let offset = 8; offset < end;) {
    if (end - offset < 12) return;
    const crcOffset = offset + 8 + bytes.readUInt32BE(offset);
    if (crcOffset + 4 > end) return;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") return;
    if (type === "IDAT" && crcOffset > offset + 8) hasData = true;
    offset = crcOffset + 4;
  }
  if (hasData) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  let dimensions: [number, number] | undefined;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    if (offset + 3 > bytes.length) return;
    const marker = bytes[offset++]!;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return;
    if (JPEG_FRAMES.has(marker) && length >= 11) {
      dimensions = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    if (marker === 0xda && length >= 8 && offset + length < bytes.length - 2) return dimensions;
    if (marker === 0xd9) return;
    offset += length;
  }
}

export function imageDetails(
  bytes: Buffer,
): { mediaType: WorkAttachmentMediaType; pixelWidth: number; pixelHeight: number } | undefined {
  if (bytes.length < 4) return;
  const png = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  const dimensions = png ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dimensions === undefined || dimensions.some((size) => size < 1 || size > 20_000)) return;
  const [pixelWidth, pixelHeight] = dimensions;
  return { mediaType: png ? "image/png" : "image/jpeg", pixelWidth, pixelHeight };
}
