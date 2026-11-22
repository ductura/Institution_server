// OSN-B2: ZIP reader edge cases of the Ductus test zip-hardening.test.ts
// (DAN-242, F-262, F-263, F-264; rows H1-H9) against openZip of this
// repository. The Ductus reader names ZIP_UNSUPPORTED where this one has
// only ZIP_INVALID; the row keeps its Ductus code and is compared after
// folding it into the closed code set. Every input is invented.
import { constants, crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS } from "../../contracts/index.ts";

import { openZip } from "./zip.ts";
import {
  concat,
  descriptorFor,
  extraRecord,
  type FixtureEntry,
  fixtureZip,
} from "../../../test-support/docx-zip/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const TEXT = "<w:p>izmisljeni odlomak, izmisljeni odlomak, izmisljeni odlomak</w:p>";
const deflated = new Uint8Array(deflateRawSync(enc(TEXT)));
const ok: FixtureEntry[] = [
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "word/document.xml", data: TEXT, method: 8 },
];

/** A ZIP64 end of central directory locator: signature, disk, offset, disk count. */
const locator = (() => {
  const v = new DataView(new ArrayBuffer(20));
  v.setUint32(0, 0x07064b50, true);
  v.setUint32(16, 1, true);
  return new Uint8Array(v.buffer);
})();
const zip64Info = extraRecord(0x0001, new Uint8Array(16));

/** A deflated entry with the data descriptor flag and a matching signed descriptor. */
const described = (over: Partial<FixtureEntry> = {}): FixtureEntry => ({
  name: "word/document.xml",
  data: TEXT,
  method: 8,
  flags: 0x8,
  after: descriptorFor(TEXT, true, undefined, true),
  ...over,
});

type Row = [cls: string, what: string, entries: FixtureEntry[], code: string];
const rows: Row[] = [
  // F-262: one end record only, no ZIP64 and no per-entry text other readers show.
  [
    "H1",
    "ZIP64 locator signature at eocd-20, in the last entry comment",
    [...ok, { name: "a.xml", data: "<a/>", comment: locator }],
    "ZIP_UNSUPPORTED",
  ],
  [
    "H2",
    "ZIP64 locator signature at eocd-20, in the last entry extra field",
    [
      ...ok,
      {
        name: "a.xml",
        data: "<a/>",
        extra: extraRecord(0x9999, locator),
        localExtra: new Uint8Array(),
      },
    ],
    "ZIP_UNSUPPORTED",
  ],
  [
    "H2",
    "locator-like bytes that do not end 20 bytes before the end record",
    [
      ...ok,
      {
        name: "a.xml",
        data: "<a/>",
        extra: extraRecord(0x9999, concat([locator, new Uint8Array(1)])),
      },
    ],
    "OK",
  ],
  [
    "H3",
    "non-empty central directory entry comment",
    [{ name: "a.xml", data: "<a/>", comment: enc("x") }, ...ok],
    "ZIP_UNSUPPORTED",
  ],
  [
    "H4",
    "ZIP64 extended information extra field in the directory",
    [{ name: "a.xml", data: "<a/>", extra: zip64Info, localExtra: new Uint8Array() }, ...ok],
    "ZIP_UNSUPPORTED",
  ],
  [
    "H4",
    "ZIP64 extended information extra field in the local header",
    [{ name: "a.xml", data: "<a/>", localExtra: zip64Info }, ...ok],
    "ZIP_UNSUPPORTED",
  ],
  // F-263: the deflate stream ends exactly where the compressed data ends.
  [
    "H5",
    "bytes after the end of the deflate stream",
    [
      {
        name: "a.xml",
        data: TEXT,
        method: 8,
        raw: concat([deflated, new Uint8Array([0, 0, 0, 0])]),
      },
      ...ok,
    ],
    "ZIP_INVALID",
  ],
  [
    "H5",
    "a second deflate stream after the first",
    [
      {
        name: "a.xml",
        data: TEXT,
        method: 8,
        raw: concat([deflated, new Uint8Array(deflateRawSync(new Uint8Array()))]),
      },
      ...ok,
    ],
    "ZIP_INVALID",
  ],
  [
    "H6",
    "truncated deflate stream",
    [
      { name: "a.xml", data: TEXT, method: 8, raw: deflated.subarray(0, deflated.length - 1) },
      ...ok,
    ],
    "ZIP_INVALID",
  ],
  [
    "H6",
    "deflate stream without a final block although all output is there",
    [
      {
        name: "a.xml",
        data: TEXT,
        method: 8,
        raw: new Uint8Array(deflateRawSync(enc(TEXT), { finishFlush: constants.Z_SYNC_FLUSH })),
      },
      ...ok,
    ],
    "ZIP_INVALID",
  ],
  [
    "H5",
    "deflate stream that ends exactly at the compressed size",
    [{ name: "a.xml", data: TEXT, method: 8 }, ...ok],
    "OK",
  ],
  // F-264: with a data descriptor the local header is zero or agrees with the directory.
  [
    "H7",
    "data descriptor, local compressed size neither zero nor the directory's",
    [described({ localCsize: 1 }), ok[0]!],
    "ZIP_INVALID",
  ],
  [
    "H7",
    "data descriptor, local uncompressed size neither zero nor the directory's",
    [described({ localUsize: TEXT.length + 1 }), ok[0]!],
    "ZIP_INVALID",
  ],
  [
    "H8",
    "data descriptor, local CRC neither zero nor the directory's",
    [described({ localCrc: (crc32(TEXT) ^ 1) >>> 0 }), ok[0]!],
    "ZIP_INVALID",
  ],
  [
    "H7",
    "data descriptor, local CRC and sizes all zero",
    [described({ localCrc: 0, localCsize: 0, localUsize: 0 }), ok[0]!],
    "OK",
  ],
  [
    "H7",
    "data descriptor, local CRC zero and sizes equal to the directory's",
    [described({ localCrc: 0 }), ok[0]!],
    "OK",
  ],
  [
    "H7",
    "data descriptor, local CRC and sizes equal to the directory's",
    [described(), ok[0]!],
    "OK",
  ],
  [
    "H9",
    "stored entry with the data descriptor flag",
    [{ name: "a.xml", data: "<a/>", flags: 0x8, after: descriptorFor("<a/>", true) }, ...ok],
    "ZIP_UNSUPPORTED",
  ],
  [
    "H9",
    "stored entry with the data descriptor flag and zero local fields",
    [
      {
        name: "a.xml",
        data: "<a/>",
        flags: 0x8,
        localCrc: 0,
        localCsize: 0,
        localUsize: 0,
        after: descriptorFor("<a/>", false),
      },
      ...ok,
    ],
    "ZIP_UNSUPPORTED",
  ],
];

function codeOf(bytes: Uint8Array): string {
  const opened = openZip(bytes, IMPORT_READ_LIMITS);
  if (!opened.ok) return opened.code;
  for (const name of opened.archive.entries.keys()) {
    const part = opened.archive.read(name);
    if (!part.ok) return part.code;
  }
  return "OK";
}
const mapped = (code: string): string => (code === "ZIP_UNSUPPORTED" ? "ZIP_INVALID" : code);

describe("OSN-B2 ZIP reader edge cases (F-262, F-263, F-264)", () => {
  it.each(rows)("%s %s", (_cls, _what, entries, code) => {
    expect(codeOf(fixtureZip(entries))).toBe(mapped(code));
  });

  it("H1 the locator rows put the signature exactly 20 bytes before the end record", () => {
    for (const [, what, entries, code] of rows.filter(([cls]) => cls === "H1" || cls === "H2")) {
      const bytes = fixtureZip(entries);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const eocd = bytes.length - 22;
      expect(view.getUint32(eocd, true), what).toBe(0x06054b50);
      expect(view.getUint32(eocd - 20, true) === 0x07064b50, what).toBe(code !== "OK");
    }
  });

  it.each([
    [0, "OK"],
    [4, "ZIP_INVALID"],
    [19, "ZIP_INVALID"],
    [20, "ZIP_INVALID"],
  ])("H1 an end record at offset %i is checked without reading before the buffer", (at, code) => {
    const before = concat([locator, new Uint8Array(20)]).subarray(0, at);
    const bytes = fixtureZip([], { before });
    expect(bytes.length - 22).toBe(at);
    expect(codeOf(bytes)).toBe(code);
  });

  it("H5 an archive with a single empty entry and the end record near offset 0 is still read", () => {
    expect(codeOf(fixtureZip([{ name: "a.xml", data: "" }]))).toBe("OK");
    expect(codeOf(fixtureZip([]))).toBe("OK");
  });
});
