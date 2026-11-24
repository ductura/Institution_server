import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { expect, it } from "vitest";

import { imageDetails } from "./image.ts";
import {
  CLEAN_JPEG,
  CLEAN_PNG,
  GPS_LATITUDE,
  JPEG_BROKEN_AFTER_SCAN,
  JPEG_WITH_GPS,
  jpegScanHash,
  METADATA_TEXT,
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
