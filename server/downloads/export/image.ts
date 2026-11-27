// Image attachments for the export: the bytes come from the caller, which has already
// checked that the attachment belongs to the work (C-23). Here the bytes are only used
// when their SHA-256 is the one the document carries and they are a PNG or a JPEG
// (contract v4 §5.2): anything else is printed as unavailable, never other bytes.
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

export type ExportImageFile = { readonly bytes: Uint8Array };
/** Attachment id to its stored bytes; the caller supplies only the attachments of this work. */
export type ExportImages = ReadonlyMap<string, ExportImageFile>;

export type VerifiedImage = {
  readonly bytes: Uint8Array;
  readonly type: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG is whole when it is IHDR, then chunks with correct CRCs, at least one IDAT, and IEND last. */
function pngIsWhole(bytes: Uint8Array, view: DataView): boolean {
  let at = 8;
  let first = true;
  let data = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (first && (type !== "IHDR" || length !== 13)) return false;
    first = false;
    if (crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) return false;
    if (type === "IDAT") data = true;
    if (type === "IEND") return data && end === bytes.length;
    at = end;
  }
  return false;
}

/** Pixel size of a PNG or JPEG, or null when the bytes are neither (or too short to tell). */
function sizeOf(bytes: Uint8Array): Pick<VerifiedImage, "type" | "width" | "height"> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 && pngIsWhole(bytes, view)
      ? { type: "png", width, height }
      : null;
  }
  // A JPEG must also end with its end-of-image marker, so a cut file is not embedded.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        const height = view.getUint16(at + 5);
        const width = view.getUint16(at + 7);
        return width > 0 && height > 0 ? { type: "jpeg", width, height } : null;
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}

export function verifyImage(
  images: ExportImages | undefined,
  attachmentId: string | undefined,
  attachmentSha256: string | undefined,
): VerifiedImage | null {
  if (attachmentId === undefined || attachmentSha256 === undefined) return null;
  const file = images?.get(attachmentId);
  if (file === undefined) return null;
  if (createHash("sha256").update(file.bytes).digest("hex") !== attachmentSha256) return null;
  const size = sizeOf(file.bytes);
  return size === null ? null : { bytes: file.bytes, ...size };
}
