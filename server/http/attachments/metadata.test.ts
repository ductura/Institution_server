import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { expect, it } from "vitest";

import { imageDetails } from "./image.ts";
import {
  CLEAN_JPEG,
  CLEAN_PNG,
  GPS_LATITUDE,
  JPEG_BROKEN_AFTER_SCAN,
  JPEG_ORIENTATION_6_STORED,
  JPEG_ORIENTATION_6_WITH_GPS,
  JPEG_WITH_GPS,
  jpegScanHash,
  jpegWithExif,
  METADATA_TEXT,
  ORIENTATION_6_APP1,
  phoneTiff,
  PNG_WITH_TEXT,
} from "./metadata.fixture.ts";
import { withoutMetadata } from "./metadata.ts";

/** Hash of the inflated PNG image data, i.e. the filtered scanlines. */
function pngPixelHash(bytes: Buffer): string {
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
    if (bytes.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      data.push(bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32BE(offset)));
    }
  }
  return createHash("sha256")
    .update(inflateSync(Buffer.concat(data)))
    .digest("hex");
}

const chunkTypes = (png: Buffer) => {
  const types: string[] = [];
  for (let offset = 8; offset < png.length; offset += png.readUInt32BE(offset) + 12) {
    types.push(png.toString("latin1", offset + 4, offset + 8));
  }
  return types;
};

it("removes Exif GPS, XMP, IPTC and comments from a JPEG and keeps every other byte", () => {
  const details = imageDetails(JPEG_WITH_GPS);
  expect(details?.mediaType).toBe("image/jpeg");
  const stored = withoutMetadata(JPEG_WITH_GPS, "image/jpeg")!;
  expect(stored.equals(CLEAN_JPEG)).toBe(true);
  expect(stored.includes(GPS_LATITUDE)).toBe(false);
  for (const text of METADATA_TEXT) expect(stored.includes(text)).toBe(false);
  for (const marker of [0xe1, 0xed, 0xfe]) {
    expect(stored.includes(Buffer.from([0xff, marker]))).toBe(false);
  }
  expect(imageDetails(stored)).toEqual(details);
  expect(jpegScanHash(stored)).toBe(jpegScanHash(JPEG_WITH_GPS));
});

it("removes eXIf, tEXt, zTXt, iTXt and tIME from a PNG and keeps the other chunks", () => {
  const details = imageDetails(PNG_WITH_TEXT);
  expect(details?.mediaType).toBe("image/png");
  expect(chunkTypes(PNG_WITH_TEXT)).toEqual(
    expect.arrayContaining(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]),
  );
  const stored = withoutMetadata(PNG_WITH_TEXT, "image/png")!;
  expect(stored.equals(CLEAN_PNG)).toBe(true);
  expect(chunkTypes(stored)).toEqual(["IHDR", "sRGB", "gAMA", "pHYs", "IDAT", "IEND"]);
  expect(stored.includes(GPS_LATITUDE)).toBe(false);
  for (const text of METADATA_TEXT) expect(stored.includes(text)).toBe(false);
  expect(imageDetails(stored)).toEqual(details);
  expect(pngPixelHash(stored)).toBe(pngPixelHash(PNG_WITH_TEXT));
});

it("leaves images without metadata unchanged", () => {
  expect(withoutMetadata(CLEAN_JPEG, "image/jpeg")!.equals(CLEAN_JPEG)).toBe(true);
  expect(withoutMetadata(CLEAN_PNG, "image/png")!.equals(CLEAN_PNG)).toBe(true);
});

it("drops data after the first end of image", () => {
  const trailing = Buffer.concat([CLEAN_JPEG, Buffer.from("Exif izmisljen dodatak"), CLEAN_JPEG]);
  expect(withoutMetadata(trailing, "image/jpeg")!.equals(CLEAN_JPEG)).toBe(true);
});

it("refuses a JPEG whose structure breaks after the scan", () => {
  expect(imageDetails(JPEG_BROKEN_AFTER_SCAN)?.mediaType).toBe("image/jpeg");
  expect(withoutMetadata(JPEG_BROKEN_AFTER_SCAN, "image/jpeg")).toBeUndefined();
  expect(withoutMetadata(CLEAN_JPEG.subarray(0, 40), "image/jpeg")).toBeUndefined();
  expect(withoutMetadata(Buffer.from([0xff, 0xd8, 0x00]), "image/jpeg")).toBeUndefined();
  expect(withoutMetadata(CLEAN_PNG.subarray(0, -1), "image/png")).toBeUndefined();
});

/** IFD0 tags of each APP1 in a JPEG; an APP1 that is not big-endian Exif gives []. */
function exifTags(jpeg: Buffer): number[][] {
  const blocks: number[][] = [];
  for (let at = jpeg.indexOf("\xff\xe1", 0, "latin1"); at >= 0;) {
    const tiff = jpeg.subarray(at + 10);
    if (jpeg.toString("latin1", at + 4, at + 12) !== "Exif\0\0MM") {
      blocks.push([]);
    } else {
      const ifd = tiff.readUInt32BE(4);
      const count = tiff.readUInt16BE(ifd);
      blocks.push(Array.from({ length: count }, (_, i) => tiff.readUInt16BE(ifd + 2 + i * 12)));
    }
    at = jpeg.indexOf("\xff\xe1", at + 2, "latin1");
  }
  return blocks;
}

it("keeps only Exif Orientation 6 from a phone JPEG, in a new minimal APP1", () => {
  expect(exifTags(JPEG_ORIENTATION_6_WITH_GPS)).toEqual([[], [0x010f, 0x0112, 0x8825]]);
  const stored = withoutMetadata(JPEG_ORIENTATION_6_WITH_GPS, "image/jpeg")!;
  expect(stored.equals(JPEG_ORIENTATION_6_STORED)).toBe(true);
  expect(exifTags(stored)).toEqual([[0x0112]]);
  expect(ORIENTATION_6_APP1.length).toBe(36);
  expect(stored.includes(GPS_LATITUDE)).toBe(false);
  for (const text of METADATA_TEXT.filter((text) => text !== "Exif")) {
    expect(stored.includes(text)).toBe(false);
  }
  expect(stored.includes("Izm")).toBe(false);
  expect(imageDetails(stored)).toEqual(imageDetails(JPEG_ORIENTATION_6_WITH_GPS));
  expect(jpegScanHash(stored)).toBe(jpegScanHash(JPEG_ORIENTATION_6_WITH_GPS));
  // Storing the stored file again gives the same bytes.
  expect(withoutMetadata(stored, "image/jpeg")!.equals(stored)).toBe(true);
});

it.each([2, 3, 4, 5, 7, 8])("keeps Exif Orientation %i", (orientation) => {
  const stored = withoutMetadata(jpegWithExif(phoneTiff(orientation)), "image/jpeg")!;
  const app1 = Buffer.from(ORIENTATION_6_APP1);
  app1.writeUInt16BE(orientation, 28);
  const expected = Buffer.concat([CLEAN_JPEG.subarray(0, 20), app1, CLEAN_JPEG.subarray(20)]);
  expect(stored.equals(expected)).toBe(true);
});

it("reads Orientation from a little-endian Exif block", () => {
  const tiff = Buffer.from("49492a00080000000100120103000100000003000000" + "00000000", "hex");
  const stored = withoutMetadata(jpegWithExif(tiff), "image/jpeg")!;
  expect(exifTags(stored)).toEqual([[0x0112]]);
  expect(stored.readUInt16BE(stored.indexOf("MM\0*", 0, "latin1") + 18)).toBe(3);
});

it.each([
  ["Orientation 1", phoneTiff(1)],
  ["Orientation 0", phoneTiff(0)],
  ["Orientation 9", phoneTiff(9)],
  ["Orientation stored as LONG", phoneTiff(6, 4)],
  ["an unknown byte order", Buffer.concat([Buffer.from("XX"), phoneTiff(6).subarray(2)])],
  ["a wrong TIFF magic number", Buffer.concat([Buffer.from("MM\0+"), phoneTiff(6).subarray(4)])],
  ["a short TIFF header", Buffer.from("MM\0*", "latin1")],
  ["IFD0 past the end", Buffer.from("4d4d002a0000ffff", "hex")],
  ["an entry count past the end", Buffer.from("4d4d002a00000008" + "00ff", "hex")],
  ["no Orientation tag", Buffer.from("4d4d002a00000008" + "0000" + "00000000", "hex")],
])("stores a JPEG without APP1 for %s", (_case, tiff) => {
  const stored = withoutMetadata(jpegWithExif(tiff), "image/jpeg")!;
  expect(stored.equals(CLEAN_JPEG)).toBe(true);
});

it("ignores Orientation in a second Exif block and leaves PNG eXIf out", () => {
  const second = Buffer.concat([
    jpegWithExif(phoneTiff(1)).subarray(0, -(CLEAN_JPEG.length - 20)),
    jpegWithExif(phoneTiff(6)).subarray(20),
  ]);
  expect(withoutMetadata(second, "image/jpeg")!.equals(CLEAN_JPEG)).toBe(true);
  expect(withoutMetadata(PNG_WITH_TEXT, "image/png")!.equals(CLEAN_PNG)).toBe(true);
});

it("copies a JPEG and a PNG made of many small segments", () => {
  const app2 = (index: number) => Buffer.from([0xff, 0xe2, 0, 4, index >> 8, index & 0xff]);
  const comment = Buffer.from([0xff, 0xfe, 0, 3, 0x78]);
  const indexes = Array.from({ length: 20_000 }, (_, index) => index);
  const jpeg = (parts: Buffer[]) =>
    Buffer.concat([CLEAN_JPEG.subarray(0, 20), ...parts, CLEAN_JPEG.subarray(20)]);
  const kept = jpeg(indexes.map(app2));
  expect(withoutMetadata(kept, "image/jpeg")!.equals(kept)).toBe(true);
  const mixed = jpeg(indexes.flatMap((index) => [app2(index), comment]));
  expect(withoutMetadata(mixed, "image/jpeg")!.equals(kept)).toBe(true);

  const chunk = (type: string, index: number) =>
    Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      Buffer.from(type),
      Buffer.from([index & 0xff, 0, 0, 0, 0]),
    ]);
  const png = (parts: Buffer[]) =>
    Buffer.concat([CLEAN_PNG.subarray(0, 33), ...parts, CLEAN_PNG.subarray(33)]);
  const keptPng = png(indexes.map((index) => chunk("prVt", index)));
  const mixedPng = png(indexes.flatMap((index) => [chunk("prVt", index), chunk("tEXt", index)]));
  expect(withoutMetadata(keptPng, "image/png")!.equals(keptPng)).toBe(true);
  expect(withoutMetadata(mixedPng, "image/png")!.equals(keptPng)).toBe(true);
});
