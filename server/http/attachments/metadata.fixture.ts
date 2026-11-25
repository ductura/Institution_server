/**
 * Invented images for the attachment metadata tests (DAN-1121). The location,
 * comment, author and dates below are made up; no photo or person is real.
 */
import { createHash } from "node:crypto";

// PNG chunk CRC (ISO 3309), so the fixture needs no compression module.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes: Buffer) =>
  (bytes.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8), 0xffffffff) ^
    0xffffffff) >>>
  0;
/** "Izmisljen autor" compressed with zlib deflate. */
const DEFLATED_AUTHOR = Buffer.from("789cf3accacd2ccec94acd53482c2dc92f02002fa90601", "hex");

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** 1 x 1 PNG with sRGB, gAMA and pHYs chunks and no metadata. */
export const CLEAN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2BgYGAAAAAFAAGKM+MAAAAAAElFTkSuQmCC",
  "base64",
);
/** 1 x 1 baseline JPEG with a JFIF APP0 segment and no metadata. */
export const CLEAN_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==",
  "base64",
);

/** Invented latitude 12° 34' 56" N, kept recognisable so a test can look for it. */
export const GPS_LATITUDE = Buffer.concat([12, 1, 34, 1, 56, 1].map(u32));
/** TIFF (Exif) block whose IFD0 points to a GPS IFD with the invented latitude. */
const TIFF = Buffer.concat([
  Buffer.from("MM\0*", "latin1"),
  u32(8),
  u16(1),
  Buffer.concat([u16(0x8825), u16(4), u32(1), u32(26)]),
  u32(0),
  u16(2),
  Buffer.concat([u16(1), u16(2), u32(2), Buffer.from("N\0\0\0", "latin1")]),
  Buffer.concat([u16(2), u16(5), u32(3), u32(56)]),
  u32(0),
  GPS_LATITUDE,
]);
const XMP = "<x:xmpmeta><exif:GPSLatitude>12,34.9N</exif:GPSLatitude></x:xmpmeta>";
export const METADATA_TEXT = [
  "Exif",
  "xmpmeta",
  "GPSLatitude",
  "Izmisljen",
  "Photoshop",
  "Comment",
  "Author",
];

const segment = (marker: number, payload: Buffer | string) => {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
  return Buffer.concat([Buffer.from([0xff, marker]), u16(bytes.length + 2), bytes]);
};
const JFIF_END = 20;

/** CLEAN_JPEG with Exif GPS, XMP, IPTC and two comments, one of them after the scan. */
export const JPEG_WITH_GPS = Buffer.concat([
  CLEAN_JPEG.subarray(0, JFIF_END),
  segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), TIFF])),
  segment(0xe1, `http://ns.adobe.com/xap/1.0/\0${XMP}`),
  segment(0xed, "Photoshop 3.0\u00008BIM\u0004\u0004Izmisljen autor"),
  segment(0xfe, "Izmisljen komentar"),
  CLEAN_JPEG.subarray(JFIF_END, -2),
  Buffer.from([0xff, 0xff]),
  segment(0xfe, "Izmisljen komentar iza slike"),
  CLEAN_JPEG.subarray(-2),
]);

const exifSegment = (tiff: Buffer) =>
  segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
/** CLEAN_JPEG with an APP1 Exif block that holds `tiff`, right after JFIF. */
export const jpegWithExif = (tiff: Buffer) =>
  Buffer.concat([
    CLEAN_JPEG.subarray(0, JFIF_END),
    exifSegment(tiff),
    CLEAN_JPEG.subarray(JFIF_END),
  ]);

/**
 * Phone-style big-endian Exif: IFD0 with an invented Make, Orientation and a GPS
 * pointer, then the GPS IFD with the invented latitude (offsets 8, 50 and 80).
 */
export const phoneTiff = (orientation: number, type = 3) =>
  Buffer.concat([
    Buffer.from("MM\0*", "latin1"),
    u32(8),
    u16(3),
    Buffer.concat([u16(0x010f), u16(2), u32(4), Buffer.from("Izm\0", "latin1")]),
    Buffer.concat([u16(0x0112), u16(type), u32(1), u16(orientation), u16(0)]),
    Buffer.concat([u16(0x8825), u16(4), u32(1), u32(50)]),
    u32(0),
    u16(2),
    Buffer.concat([u16(1), u16(2), u32(2), Buffer.from("N\0\0\0", "latin1")]),
    Buffer.concat([u16(2), u16(5), u32(3), u32(80)]),
    u32(0),
    GPS_LATITUDE,
  ]);

/** Orientation 6 (rotate 90°) with GPS, after an XMP block, as a phone might save it. */
export const JPEG_ORIENTATION_6_WITH_GPS = Buffer.concat([
  CLEAN_JPEG.subarray(0, JFIF_END),
  segment(0xe1, `http://ns.adobe.com/xap/1.0/\0${XMP}`),
  exifSegment(phoneTiff(6)),
  segment(0xfe, "Izmisljen komentar"),
  CLEAN_JPEG.subarray(JFIF_END),
]);

/** The only APP1 a stored JPEG may have: Exif, big-endian TIFF, IFD0 = { Orientation: 6 }. */
export const ORIENTATION_6_APP1 = Buffer.from(
  "ffe10022" +
    "457869660000" +
    "4d4d002a00000008" +
    "0001" +
    "011200030000000100060000" +
    "00000000",
  "hex",
);
export const JPEG_ORIENTATION_6_STORED = Buffer.concat([
  CLEAN_JPEG.subarray(0, JFIF_END),
  ORIENTATION_6_APP1,
  CLEAN_JPEG.subarray(JFIF_END),
]);

/** Passes the type check before the scan, but a segment after the scan overruns the file. */
export const JPEG_BROKEN_AFTER_SCAN = Buffer.concat([
  CLEAN_JPEG.subarray(0, -2),
  Buffer.from([0xff, 0xfe, 0x7f, 0xff]),
  CLEAN_JPEG.subarray(-2),
]);

/** Exif segment whose declared length runs past the end of the file. */
export const JPEG_TRUNCATED_EXIF = Buffer.concat([
  CLEAN_JPEG.subarray(0, JFIF_END),
  Buffer.from([0xff, 0xe1, 0x40, 0x00]),
  Buffer.from("Exif\0\0", "latin1"),
  CLEAN_JPEG.subarray(-2),
]);

const chunk = (type: string, data: Buffer | string) => {
  const body = Buffer.concat([
    Buffer.from(type, "latin1"),
    Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1"),
  ]);
  return Buffer.concat([u32(body.length - 4), body, u32(crc32(body))]);
};
const IHDR_END = 33;

/** CLEAN_PNG with eXIf, tEXt, zTXt, iTXt and tIME chunks. */
export const PNG_WITH_TEXT = Buffer.concat([
  CLEAN_PNG.subarray(0, IHDR_END),
  chunk("eXIf", TIFF),
  chunk("tEXt", "Comment\0Izmisljen komentar"),
  chunk("zTXt", Buffer.concat([Buffer.from("Author\0\0", "latin1"), DEFLATED_AUTHOR])),
  chunk("iTXt", `XML:com.adobe.xmp\0\0\0\0\0${XMP}`),
  chunk("tIME", Buffer.from([0x07, 0xea, 11, 24, 10, 0, 0])),
  CLEAN_PNG.subarray(IHDR_END),
]);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Hash of the JPEG scan: the SOS header and the entropy-coded data up to the next marker. */
export function jpegScanHash(bytes: Buffer): string {
  const start = bytes.indexOf(Buffer.from([0xff, 0xda]));
  let end = start + 2 + bytes.readUInt16BE(start + 2);
  while (!(bytes[end] === 0xff && bytes[end + 1] !== 0x00 && (bytes[end + 1]! & 0xf8) !== 0xd0)) {
    end++;
  }
  return sha256(bytes.subarray(start, end));
}
