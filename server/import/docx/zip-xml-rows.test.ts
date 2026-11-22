// OSN-B2: the Ductus tests of the bounded ZIP and XML reader for DOCX traces
// (src/domain/provenance/docx/docx-reader.test.ts, zip-hardening.test.ts,
// DAN-242, classes Z1-Z13, H1-H9, X1-X8) carried over to the import reader of
// this repository (openZip, readXml). The rows are the Ductus rows; only the
// vocabulary of codes differs, see CODE below. Every input is invented and
// built here, no binary file is committed.
import { constants, crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, type ImportReadLimitsV1 } from "../../contracts/index.ts";

import { readXml } from "./xml.ts";
import { openZip } from "./zip.ts";
import {
  concat,
  descriptorFor,
  extraRecord,
  type FixtureEntry,
  fixtureZip,
} from "../../../test-support/docx-zip/index.ts";

/**
 * Ductus code to the code of this repository. The Ductus reader names a few
 * more reasons than ImportReadRejectCode does; every one of them is a refusal
 * here too, folded into the closed code set of the contract.
 */
const CODE = new Map<string, string>([
  ["ZIP_UNSUPPORTED", "ZIP_INVALID"],
  ["ZIP_METHOD", "ZIP_INVALID"],
  ["ZIP_SIZE_MISMATCH", "ZIP_INVALID"],
  ["ZIP_CRC", "ZIP_INVALID"],
  ["ZIP_DUPLICATE", "ZIP_DUPLICATE_ENTRY"],
  ["ZIP_RATIO", "ZIP_RATIO_EXCEEDED"],
  ["ZIP_PATH", "ZIP_PATH_INVALID"],
  ["XML_ENCODING", "XML_INVALID"],
  ["XML_DOCTYPE", "XML_DTD"],
  ["XML_ENTITY", "XML_INVALID"],
  ["XML_PI", "XML_INVALID"],
  ["XML_NAMESPACE", "XML_INVALID"],
  ["XML_DEPTH", "XML_TOO_DEEP"],
]);
const mapped = (code: string): string => CODE.get(code) ?? code;

type Limits = Partial<ImportReadLimitsV1>;
const enc = (s: string) => new TextEncoder().encode(s);
const DOC =
  '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:w"><w:body/></w:document>';
const ok: FixtureEntry[] = [
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "word/document.xml", data: DOC },
];

/** Opens the archive and inflates every part: "OK" or the refusal code. */
function zipCode(bytes: Uint8Array, limits: Limits = {}): string {
  const opened = openZip(bytes, { ...IMPORT_READ_LIMITS, ...limits });
  if (!opened.ok) return opened.code;
  for (const name of opened.archive.entries.keys()) {
    const part = opened.archive.read(name);
    if (!part.ok) return part.code;
  }
  return "OK";
}
const codeOf = (bytes: unknown, limits?: Limits): string => zipCode(bytes as Uint8Array, limits);

type Row = [cls: string, what: string, bytes: unknown, code: string, limits?: Limits];
const big = "a".repeat(100_000);
// About 2:1 under raw deflate, so both sides of the boundary are below the default limit.
const noisy = Array.from(
  { length: 20_000 },
  (_, i) => "abcdefghijklmnop"[((i * 7919) ^ (i >> 3)) % 16],
).join("");
const valid = fixtureZip(ok);
const timestamp = extraRecord(0x5455, new Uint8Array([1, 0, 0, 0, 0]));
const unicodePath = extraRecord(
  0x7075,
  concat([new Uint8Array([1, 0x9c, 0x70, 0x28, 0xec]), enc("word/document.xml")]),
);
const unicodeComment = extraRecord(
  0x6375,
  concat([new Uint8Array([1, 0, 0, 0, 0]), enc("komentar")]),
);
const sigCrc = concat([enc("<a>izmisljeno</a>"), new Uint8Array([192, 46, 189, 27])]);
const sigCrcEntry = (signed: boolean, after = new Uint8Array()): FixtureEntry => ({
  name: "a.bin",
  data: sigCrc,
  method: 8,
  flags: 0x8,
  after: concat([descriptorFor(sigCrc, signed, undefined, true), after]),
});
const described = (signed: boolean, crc?: number): FixtureEntry => ({
  name: "a.xml",
  data: "<a/>",
  method: 8,
  flags: 0x8,
  after: descriptorFor("<a/>", signed, crc, true),
});
const emptyEnd = fixtureZip([]);

const zipRows: Row[] = [
  ["Z1", "empty input", new Uint8Array(), "ZIP_INVALID"],
  ["Z2", "no end record", enc("Izmišljen sadržaj koji nije ZIP."), "ZIP_INVALID"],
  ["Z2", "truncated by one byte", valid.subarray(0, valid.length - 1), "ZIP_INVALID"],
  [
    "Z2",
    "data after the comment",
    fixtureZip(ok, { comment: enc("k"), trailing: enc("xyz") }),
    "ZIP_INVALID",
  ],
  ["Z2", "data after the end record", fixtureZip(ok, { trailing: enc("x") }), "ZIP_INVALID"],
  [
    "Z2",
    "a second end record hidden in the comment",
    fixtureZip(ok, { comment: fixtureZip([]) }),
    "ZIP_INVALID",
  ],
  // Readers such as Python's zipfile take the last end record signature without
  // checking its comment length, so any signature after the chosen record is refused (#1851).
  [
    "Z2",
    "a second end record in the comment whose comment stops short of the end",
    fixtureZip(ok, { comment: concat([emptyEnd, new Uint8Array([0])]) }),
    "ZIP_INVALID",
  ],
  [
    "Z2",
    "a second end record in the comment whose comment runs past the end",
    fixtureZip(ok, { comment: fixtureZip([], { comment: enc("abcde") }).subarray(0, 22) }),
    "ZIP_INVALID",
  ],
  [
    "Z2",
    "an end record signature in the last 21 bytes of the comment",
    fixtureZip(ok, { comment: enc("PK\u0005\u0006") }),
    "ZIP_INVALID",
  ],
  // A comment of 0x4b50 bytes that starts with 05 06 puts the signature at the comment length field.
  [
    "Z2",
    "an end record signature that starts in the comment length field",
    fixtureZip(ok, { comment: concat([new Uint8Array([5, 6]), new Uint8Array(0x4b50 - 2)]) }),
    "ZIP_INVALID",
  ],
  ["Z2", "bytes before the first entry", fixtureZip(ok, { before: enc("prefiks") }), "ZIP_INVALID"],
  [
    "Z2",
    "comment that ends at the end",
    fixtureZip(ok, { comment: enc("izmišljeni komentar") }),
    "OK",
  ],
  // The shadow check covers only bytes after the chosen end record, never entry data.
  [
    "Z2",
    "end record bytes inside the data of a stored entry",
    fixtureZip([
      ...ok,
      { name: "word/media/a.bin", data: concat([enc("PK\u0005\u0006"), emptyEnd]) },
    ]),
    "OK",
  ],
  ["Z3", "disk number 1", fixtureZip(ok, { diskNumber: 1 }), "ZIP_UNSUPPORTED"],
  ["Z3", "directory on disk 1", fixtureZip(ok, { cdDisk: 1 }), "ZIP_UNSUPPORTED"],
  [
    "Z3",
    "ZIP64 entry count",
    fixtureZip(ok, { countOnDisk: 0xffff, countTotal: 0xffff }),
    "ZIP_UNSUPPORTED",
  ],
  ["Z3", "ZIP64 directory offset", fixtureZip(ok, { cdOffset: 0xffffffff }), "ZIP_UNSUPPORTED"],
  [
    "Z3",
    "entry starts on disk 1",
    fixtureZip([{ name: "a.xml", data: "<a/>", diskStart: 1 }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "ZIP64 entry start disk",
    fixtureZip([{ name: "a.xml", data: "<a/>", diskStart: 0xffff }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "ZIP64 entry size",
    fixtureZip([{ name: "a.xml", data: "<a/>", usize: 0xffffffff }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "patched data flag",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0x20 }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "patched data flag only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", localFlags: 0x20 }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "version needed above 6.3",
    fixtureZip([{ name: "a.xml", data: "<a/>", version: 64 }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "version needed above 6.3 only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", localVersion: 64 }]),
    "ZIP_UNSUPPORTED",
  ],
  ["Z3", "version needed 6.3", fixtureZip([{ name: "a.xml", data: "<a/>", version: 63 }]), "OK"],
  [
    "Z3",
    "high byte of version needed names the host, not the version",
    fixtureZip([{ name: "a.xml", data: "<a/>", version: 0x0314 }]),
    "OK",
  ],
  ["Z4", "counts disagree", fixtureZip(ok, { countOnDisk: 1 }), "ZIP_INVALID"],
  [
    "Z4",
    "count larger than the directory",
    fixtureZip(ok, { countOnDisk: 3, countTotal: 3 }),
    "ZIP_INVALID",
  ],
  [
    "Z4",
    "count smaller than the directory",
    fixtureZip(ok, { countOnDisk: 1, countTotal: 1 }),
    "ZIP_INVALID",
  ],
  [
    "Z4",
    "directory size off by one",
    fixtureZip(ok, { cdSize: 46 * 2 + 19 + 17 + 1 }),
    "ZIP_INVALID",
  ],
  ["Z4", "directory offset past the end", fixtureZip(ok, { cdOffset: 1_000_000 }), "ZIP_INVALID"],
  ["Z5", "more entries than maxEntries", valid, "ZIP_TOO_MANY_ENTRIES", { maxEntries: 1 }],
  ["Z5", "exactly maxEntries", valid, "OK", { maxEntries: 2 }],
  [
    "Z5",
    "huge declared count, checked before the directory",
    fixtureZip([], { countOnDisk: 60_000, countTotal: 60_000 }),
    "ZIP_TOO_MANY_ENTRIES",
  ],
  ["Z7", "same name twice", fixtureZip([...ok, ok[1]!]), "ZIP_DUPLICATE"],
  [
    "Z7",
    "names that differ only in case",
    fixtureZip([...ok, { name: "WORD/Document.XML", data: DOC }]),
    "ZIP_DUPLICATE",
  ],
  [
    "Z7",
    "NFC and NFD of one name",
    fixtureZip([{ name: "word/\u00e9.xml" }, { name: "word/e\u0301.xml" }]),
    "ZIP_DUPLICATE",
  ],
  [
    "Z8",
    "traditional encryption flag",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0x1 }]),
    "ZIP_ENCRYPTED",
  ],
  [
    "Z8",
    "strong encryption flag",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0x40 }]),
    "ZIP_ENCRYPTED",
  ],
  [
    "Z8",
    "encrypted directory flag",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0x2000 }]),
    "ZIP_ENCRYPTED",
  ],
  [
    "Z8",
    "AES method 99",
    fixtureZip([{ name: "a.xml", data: "<a/>", method: 99 }]),
    "ZIP_ENCRYPTED",
  ],
  [
    "Z8",
    "encryption flag only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", localFlags: 0x1 }]),
    "ZIP_ENCRYPTED",
  ],
  ["Z8", "bzip2 method", fixtureZip([{ name: "a.xml", data: "<a/>", method: 12 }]), "ZIP_METHOD"],
  [
    "Z8",
    "deflate64 method",
    fixtureZip([{ name: "a.xml", data: "<a/>", method: 9 }]),
    "ZIP_METHOD",
  ],
  [
    "Z9",
    "part one byte over maxPartBytes",
    fixtureZip([{ name: "a.xml", data: "x".repeat(11) }]),
    "ZIP_PART_TOO_LARGE",
    { maxPartBytes: 10 },
  ],
  [
    "Z9",
    "part exactly maxPartBytes",
    fixtureZip([{ name: "a.xml", data: "x".repeat(10) }]),
    "OK",
    { maxPartBytes: 10 },
  ],
  [
    "Z9",
    "declared total one byte over",
    fixtureZip([
      { name: "a", data: "123456" },
      { name: "b", data: "123456" },
    ]),
    "ZIP_TOTAL_TOO_LARGE",
    { maxTotalBytes: 11 },
  ],
  [
    "Z9",
    "declared total exactly at the limit",
    fixtureZip([
      { name: "a", data: "123456" },
      { name: "b", data: "123456" },
    ]),
    "OK",
    { maxTotalBytes: 12 },
  ],
  [
    "Z10",
    "compression ratio above maxRatio",
    fixtureZip([{ name: "a.xml", data: big, method: 8 }]),
    "ZIP_RATIO",
  ],
  [
    "Z11",
    "directory points into an entry",
    fixtureZip([{ name: "a.xml", data: "<a/>", offset: 5 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "local name differs from the directory",
    fixtureZip([{ name: "a.xml", data: "<a/>", localName: "b.xml" }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "local method differs",
    fixtureZip([{ name: "a.xml", data: "<a/>", localMethod: 8 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "local CRC differs without a data descriptor",
    fixtureZip([{ name: "a.xml", data: "<a/>", localCrc: 1 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "local header past the directory",
    fixtureZip([{ name: "a.xml", data: "<a/>", offset: 900 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "entry data runs into the next entry",
    fixtureZip([
      { name: "a.xml", data: big.slice(0, 900), method: 8, csize: 40 },
      { name: "b.xml", data: "<b/>" },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z12",
    "stored sizes disagree",
    fixtureZip([{ name: "a.xml", data: "<a/>", usize: 5 }]),
    "ZIP_SIZE_MISMATCH",
  ],
  [
    "Z12",
    "stored CRC wrong",
    fixtureZip([{ name: "a.xml", data: "<a/>", crc: 1, localCrc: 1 }]),
    "ZIP_CRC",
  ],
  [
    "Z12",
    "deflate bomb that declares a small size",
    fixtureZip([{ name: "a.xml", data: "a".repeat(2_000_000), method: 8, usize: 1000 }]),
    "ZIP_SIZE_MISMATCH",
  ],
  [
    "Z12",
    "deflate shorter than declared",
    fixtureZip([{ name: "a.xml", data: "<a>izmišljeno</a>", method: 8, usize: 40 }]),
    "ZIP_SIZE_MISMATCH",
  ],
  [
    "Z12",
    "deflate CRC wrong",
    fixtureZip([{ name: "a.xml", data: "<a/>", method: 8, crc: 1, localCrc: 1 }]),
    "ZIP_CRC",
  ],
  [
    "Z12",
    "corrupt deflate stream",
    fixtureZip([
      { name: "a.xml", raw: new Uint8Array([0xff, 0xff, 0xff, 0xff]), method: 8, usize: 4 },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z12",
    "truncated deflate stream",
    fixtureZip([
      {
        name: "a.xml",
        raw: deflated("<a>izmišljeno, izmišljeno</a>").subarray(0, 6),
        method: 8,
        usize: 31,
      },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z12",
    "bytes after the end of the deflate stream",
    fixtureZip([{ name: "a.xml", raw: withTail(deflated("<a/>")), method: 8, usize: 4 }]),
    "ZIP_INVALID",
  ],
  ["Z13", "empty archive", fixtureZip([]), "OK"],
  ["Z13", "deflated parts", fixtureZip(ok.map((e) => ({ ...e, method: 8 }))), "OK"],
  ["Z13", "directory entry", fixtureZip([{ name: "word/" }, ...ok]), "OK"],
  ["Z13", "data descriptor with signature", fixtureZip([described(true), ...ok]), "OK"],
  ["Z13", "data descriptor without signature", fixtureZip([described(false)]), "OK"],
  [
    "Z11",
    "data descriptor flag without a descriptor",
    fixtureZip([{ name: "a.xml", data: "<a/>", method: 8, flags: 0x8 }, ...ok]),
    "ZIP_INVALID",
  ],
  // A descriptor is 12 bytes, or 16 with its optional signature; a CRC equal to that
  // signature must not be read as one (#1851).
  [
    "Z13",
    "unsigned descriptor whose CRC equals the signature, then another entry",
    fixtureZip([sigCrcEntry(false), ...ok]),
    "OK",
  ],
  [
    "Z13",
    "unsigned descriptor whose CRC equals the signature, last entry",
    fixtureZip([...ok, sigCrcEntry(false)]),
    "OK",
  ],
  [
    "Z13",
    "signed descriptor whose CRC equals the signature, then another entry",
    fixtureZip([sigCrcEntry(true), ...ok]),
    "OK",
  ],
  [
    "Z11",
    "unsigned descriptor whose CRC equals the signature, then hidden bytes",
    fixtureZip([sigCrcEntry(false, new Uint8Array(4)), ...ok]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "data descriptor that disagrees with the directory",
    fixtureZip([described(true, 1)]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "bytes hidden between two entries",
    fixtureZip([{ name: "a.xml", data: "<a/>", after: enc("PK\u0003\u0004xx") }, ...ok]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "bytes hidden before the central directory",
    fixtureZip([...ok, { name: "b.xml", data: "<b/>", after: new Uint8Array(4) }]),
    "ZIP_INVALID",
  ],
  [
    "Z13",
    "UTF-8 name flag and Croatian name",
    fixtureZip([{ name: "word/čćžšđ.xml", data: "<a/>", flags: 0x800 }]),
    "OK",
  ],
  [
    "Z6",
    "non-ASCII name without the UTF-8 flag",
    fixtureZip([{ name: "word/č.xml", data: "<a/>", flags: 0 }]),
    "ZIP_PATH",
  ],
  [
    "Z11",
    "UTF-8 name flag only in the directory",
    fixtureZip([{ name: "word/č.xml", data: "<a/>", flags: 0x800, localFlags: 0 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "UTF-8 name flag only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0, localFlags: 0x800 }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "data descriptor flag only in the directory",
    fixtureZip([{ name: "a.xml", data: "<a/>", method: 8, flags: 0x8, localFlags: 0 }, ...ok]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "data descriptor flag only in the local header",
    fixtureZip([
      {
        name: "a.xml",
        data: "<a/>",
        method: 8,
        localFlags: 0x8,
        after: descriptorFor("<a/>", true, undefined, true),
      },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z6",
    "UTF-8 name with a leading byte order mark",
    fixtureZip([{ name: "\ufeffword/document.xml", data: "<a/>", flags: 0x800 }]),
    "ZIP_PATH",
  ],
  [
    "Z6",
    "UTF-8 name with a byte order mark inside",
    fixtureZip([{ name: "word/a\ufeff.xml", data: "<a/>", flags: 0x800 }]),
    "ZIP_PATH",
  ],
  [
    "Z13",
    "UTF-8 name flag on an ASCII name",
    fixtureZip([{ name: "a.xml", data: "<a/>", flags: 0x800 }]),
    "OK",
  ],
  ["Z6", "directory entry with data", fixtureZip([{ name: "word/", data: "x" }]), "ZIP_INVALID"],
  // Info-ZIP Unicode Path (0x7075) renames the entry in readers that honour it,
  // and Unicode Comment (0x6375) is the same mechanism; the extra field is read
  // as whole records so that neither can hide behind a malformed one (#1851).
  [
    "Z6",
    "Unicode Path extra in the directory",
    fixtureZip([{ name: "a.xml", data: "<a/>", extra: unicodePath, localExtra: new Uint8Array() }]),
    "ZIP_PATH",
  ],
  [
    "Z6",
    "Unicode Path extra only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", localExtra: unicodePath }]),
    "ZIP_PATH",
  ],
  [
    "Z6",
    "Unicode Path extra after a harmless record",
    fixtureZip([{ name: "a.xml", data: "<a/>", extra: concat([timestamp, unicodePath]) }]),
    "ZIP_PATH",
  ],
  [
    "Z3",
    "Unicode Comment extra in the directory",
    fixtureZip([
      { name: "a.xml", data: "<a/>", extra: unicodeComment, localExtra: new Uint8Array() },
    ]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z3",
    "Unicode Comment extra only in the local header",
    fixtureZip([{ name: "a.xml", data: "<a/>", localExtra: unicodeComment }]),
    "ZIP_UNSUPPORTED",
  ],
  [
    "Z11",
    "extra record longer than the extra field",
    fixtureZip([{ name: "a.xml", data: "<a/>", extra: extraRecord(0x5455, "\u0001abcd", 9) }]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "local extra record longer than the extra field",
    fixtureZip([
      { name: "a.xml", data: "<a/>", localExtra: concat([timestamp, extraRecord(0x7075, "", 40)]) },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z11",
    "extra field ends in a partial record header",
    fixtureZip([
      { name: "a.xml", data: "<a/>", extra: concat([timestamp, new Uint8Array([0x75, 0x70, 0])]) },
    ]),
    "ZIP_INVALID",
  ],
  [
    "Z13",
    "extended timestamp extra in both headers",
    fixtureZip([{ name: "a.xml", data: "<a/>", extra: timestamp }, ...ok]),
    "OK",
  ],
  [
    "Z13",
    "Unicode Path ID only inside another record's data",
    fixtureZip([
      {
        name: "a.xml",
        data: "<a/>",
        extra: extraRecord(0x5455, new Uint8Array([1, 0x75, 0x70, 5, 0])),
      },
    ]),
    "OK",
  ],
];

function deflated(s: string): Uint8Array {
  // Same deflate the fixture builder uses, read back out of a one-entry archive.
  const z = fixtureZip([{ name: "a", data: s, method: 8 }]);
  const csize = new DataView(z.buffer).getUint32(18, true);
  return z.subarray(31, 31 + csize);
}
function withTail(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length + 3);
  out.set(b);
  out.set([1, 2, 3], b.length);
  return out;
}

const unsafeNames: (string | Uint8Array)[] = [
  "../izmisljeno.xml",
  "word/../../izmisljeno.xml",
  "word/..",
  "/word/document.xml",
  "word\\document.xml",
  "C:/word/document.xml",
  "word/a:b.xml",
  "word//document.xml",
  "./word/document.xml",
  "word/./document.xml",
  "",
  "/",
  "word/a\u0000.xml",
  "word/a\u0001.xml",
  "word/a\u007f.xml",
  "word/a\n.xml",
  new Uint8Array([0x77, 0xff, 0xfe]),
];

describe("OSN-B2 ZIP reader: input classes Z1-Z13", () => {
  it.each(zipRows)("%s %s", (_cls, _what, bytes, code, limits) => {
    expect(codeOf(bytes, limits)).toBe(mapped(code));
  });

  it.each(unsafeNames.map((n) => [n]))(
    "Z6 unsafe name %j is rejected before any part is read",
    (name) => {
      const opened = openZip(fixtureZip([{ name, data: "<a/>" }]), IMPORT_READ_LIMITS);
      expect(opened.ok ? "OK" : opened.code).toBe("ZIP_PATH_INVALID");
    },
  );

  it("Z13 the descriptor collision rows use a part whose CRC-32 is the descriptor signature", () => {
    expect(crc32(sigCrc)).toBe(0x08074b50);
  });

  it("Z10 ratio is checked on the declared sizes, with the limit inclusive", () => {
    const bytes = fixtureZip([{ name: "a.xml", data: noisy, method: 8 }]);
    const csize = new DataView(bytes.buffer).getUint32(18, true);
    const at = noisy.length / csize;
    expect(at % 1).not.toBe(0);
    expect(codeOf(bytes, { maxRatio: Math.ceil(at) })).toBe("OK");
    expect(codeOf(bytes, { maxRatio: Math.floor(at) })).toBe("ZIP_RATIO_EXCEEDED");
  });

  it("Z13 reads back exactly what was written, stored and deflated, by case-insensitive name", () => {
    const opened = openZip(
      fixtureZip([
        { name: "word/document.xml", data: DOC, method: 8 },
        { name: "b.xml", data: "<b>č</b>" },
      ]),
      IMPORT_READ_LIMITS,
    );
    if (!opened.ok) throw new Error(opened.code);
    const text = (name: string) => {
      const part = opened.archive.read(name);
      return part.ok ? new TextDecoder().decode(part.bytes) : part.code;
    };
    expect(text("word/document.xml")).toBe(DOC);
    expect(text("WORD/DOCUMENT.XML")).toBe(DOC);
    expect(text("b.xml")).toBe("<b>č</b>");
    expect(text("word/missing.xml")).toBe("PACKAGE_INVALID");
    const withDirectory = openZip(fixtureZip([{ name: "word/" }, ...ok]), IMPORT_READ_LIMITS);
    expect(
      withDirectory.ok && [...withDirectory.archive.entries.values()].map((e) => e.name),
    ).toEqual(["[Content_Types].xml", "word/document.xml"]);
  });

  it("Z13 a stored part is a copy, also when the archive is a Node Buffer", () => {
    const archive = Buffer.from(fixtureZip([{ name: "a.xml", data: "<a/>" }]));
    const before = Uint8Array.from(archive);
    const opened = openZip(archive, IMPORT_READ_LIMITS);
    if (!opened.ok) throw new Error(opened.code);
    const first = opened.archive.read("a.xml");
    if (!first.ok) throw new Error(first.code);
    first.bytes[1] = 98;
    expect(Uint8Array.from(archive)).toEqual(before);
    const second = opened.archive.read("a.xml");
    expect(second.ok && new TextDecoder().decode(second.bytes)).toBe("<a/>");
  });
});

const xmlRows: [
  cls: string,
  xml: string | Uint8Array,
  code: string,
  limits?: { maxDepth?: number },
][] = [
  ["X1", new Uint8Array([0x3c, 0x61, 0xff, 0x2f, 0x3e]), "XML_ENCODING"],
  [
    "X1",
    new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00]),
    "XML_ENCODING",
  ],
  ["X1", '<?xml version="1.0" encoding="ISO-8859-1"?><a/>', "XML_ENCODING"],
  ["X1", '<?xml version="1.0" encoding="UTF-16"?><a/>', "XML_ENCODING"],
  ["X1", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]), "OK"],
  ["X1", '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<a/>', "OK"],
  ["X1", '<?xml version="1.0" encoding="UTF-8" ?><a/>', "OK"],
  ["X1", "<a>\u0001</a>", "XML_INVALID"],
  ["X1", '<?xml version="1.0" encoding="UTF-8"<a/>', "XML_INVALID"],
  ["X2", '<!DOCTYPE a [<!ENTITY e "izmišljeno">]><a>&e;</a>', "XML_DOCTYPE"],
  ["X2", '<!DOCTYPE a SYSTEM "http://example.invalid/a.dtd"><a/>', "XML_DOCTYPE"],
  [
    "X2",
    '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY a "a"><!ENTITY b "&a;&a;&a;&a;">]><a>&b;</a>',
    "XML_DOCTYPE",
  ],
  ["X2", '<a><!ENTITY e "x"></a>', "XML_DOCTYPE"],
  ["X2", "<a/><!DOCTYPE a>", "XML_DOCTYPE"],
  ["X3", "<a>&e;</a>", "XML_ENTITY"],
  ["X3", "<a>&amp</a>", "XML_ENTITY"],
  ["X3", "<a>a & b</a>", "XML_ENTITY"],
  ["X3", "<a>&#0;</a>", "XML_ENTITY"],
  ["X3", "<a>&#xD800;</a>", "XML_ENTITY"],
  ["X3", "<a>&#x110000;</a>", "XML_ENTITY"],
  ["X3", "<a>&#xFFFE;</a>", "XML_ENTITY"],
  ["X3", "<a>&#x;</a>", "XML_ENTITY"],
  ["X3", "<a>&#12a;</a>", "XML_ENTITY"],
  ["X3", '<a b="&e;"/>', "XML_ENTITY"],
  ["X3", '<a b="&lt;&#x41;&#65;&#x10FFFF;">&amp;&quot;&apos;&gt;&#9;</a>', "OK"],
  ["X4", "<a><?izmisljeno x?></a>", "XML_PI"],
  ["X4", '<?xml-stylesheet href="a.xsl"?><a/>', "XML_PI"],
  ["X4", ' <?xml version="1.0"?><a/>', "XML_PI"],
  ["X4", '<?xml version="1.0"?><?xml version="1.0"?><a/>', "XML_PI"],
  ["X5", "<a><a><a></a></a></a>", "OK", { maxDepth: 3 }],
  ["X5", "<a><a><a><a/></a></a></a>", "XML_DEPTH", { maxDepth: 3 }],
  [
    "X5",
    `${"<a>".repeat(IMPORT_READ_LIMITS.maxXmlDepth + 1)}${"</a>".repeat(IMPORT_READ_LIMITS.maxXmlDepth + 1)}`,
    "XML_DEPTH",
  ],
  ["X6", "", "XML_INVALID"],
  ["X6", "<a>", "XML_INVALID"],
  ["X6", "<a></b>", "XML_INVALID"],
  ["X6", "</a>", "XML_INVALID"],
  ["X6", '<a b="1" b="2"/>', "XML_INVALID"],
  ["X6", "<a/><b/>", "XML_INVALID"],
  ["X6", "x<a/>", "XML_INVALID"],
  ["X6", "<a/>x", "XML_INVALID"],
  ["X6", '<a b="<"/>', "XML_INVALID"],
  ["X6", "<a b=1/>", "XML_INVALID"],
  ["X6", '<a b="1"c="2"/>', "XML_INVALID"],
  ["X6", "<a><!-- x -- y --></a>", "XML_INVALID"],
  ["X6", "<a><!-- x </a>", "XML_INVALID"],
  ["X6", "<a><!----></a>", "OK"],
  ["X6", "<!----><a/><!---->", "OK"],
  ["X6", "<a><!---></a>", "XML_INVALID"],
  ["X6", "<a><!-----></a>", "XML_INVALID"],
  ["X6", "<a><!--x---></a>", "XML_INVALID"],
  ["X6", "<a>]]></a>", "XML_INVALID"],
  ["X6", "<a><![CDATA[x</a>", "XML_INVALID"],
  ["X6", "<![CDATA[x]]><a/>", "XML_INVALID"],
  ["X6", "<1a/>", "XML_INVALID"],
  ["X6", "<a:b:c/>", "XML_INVALID"],
  ["X6", "<a", "XML_INVALID"],
  ["X6", '<a\u00a0b="1"/>', "XML_INVALID"],
  ["X6", '<a b\u2003="1"/>', "XML_INVALID"],
  ["X6", '<a b="1"\u00a0/>', "XML_INVALID"],
  ["X6", "<a></a\u00a0>", "XML_INVALID"],
  ["X6", "\u00a0<a/>", "XML_INVALID"],
  ["X6", "<a/>\u3000", "XML_INVALID"],
  ["X6", "<a/>\ufeff", "XML_INVALID"],
  ["X4", '<?xml\u00a0version="1.0"?><a/>', "XML_PI"],
  ["X6", '<?xml version="1.0"\u00a0?><a/>', "XML_INVALID"],
  ["X6", "<a\tb='1'\r\n c=\"2\"\n/>\r\n", "OK"],
  ["X6", "<a>\u00a0</a\t>", "OK"],
  ["X7", "<p:a/>", "XML_NAMESPACE"],
  ["X7", '<a p:b="1"/>', "XML_NAMESPACE"],
  ["X7", '<a xmlns:p=""/>', "XML_NAMESPACE"],
  ["X7", '<a xmlns:xmlns="urn:x"/>', "XML_NAMESPACE"],
  ["X7", '<a xmlns:xml="urn:x"/>', "XML_NAMESPACE"],
  ["X7", '<r><a xmlns:x="urn:x"/><x:b/></r>', "XML_NAMESPACE"],
  ["X7", '<a xmlns:p="urn:x" xmlns:q="urn:x" p:b="1" q:b="2"/>', "XML_INVALID"],
  ["X7", '<a xmlns:p="urn:x" xmlns:p="urn:y"/>', "XML_INVALID"],
  ["X7", '<a xmlns="urn:x" xmlns="urn:x"/>', "XML_INVALID"],
  ["X7", '<a b="1" b="1"/>', "XML_INVALID"],
  ["X7", '<a xmlns:p="urn:x y" xmlns:q="urn:x\ty" p:b="1" q:b="2"/>', "XML_INVALID"],
  ["X7", '<a xmlns:p="urn:x y" xmlns:q="urn:x\r\ny" p:b="1" q:b="2"/>', "XML_INVALID"],
  ["X7", '<a xmlns:p="urn:x\ry" xmlns:q="urn:x\ny" p:b="1" q:b="2"/>', "XML_INVALID"],
  ["X7", '<a xmlns:p="urn:x  y" xmlns:q="urn:x\r\ny" p:b="1" q:b="2"/>', "OK"],
  ["X7", '<a xmlns:p="urn:x\ty" xmlns:q="urn:x&#9;y" p:b="1" q:b="2"/>', "OK"],
  ["X8", "<!-- k --><a><![CDATA[<b>&e;]]><!-- d --></a><!-- e -->\n", "OK"],
];

const xmlCode = (bytes: Uint8Array, limits: { maxDepth?: number } = {}): string => {
  const result = readXml(bytes, {
    maxDepth: IMPORT_READ_LIMITS.maxXmlDepth,
    maxAttributes: IMPORT_READ_LIMITS.maxXmlAttributes,
    ...limits,
  });
  return result.ok ? "OK" : result.code;
};

describe("OSN-B2 XML reader: input classes X1-X8", () => {
  it.each(xmlRows)("%s %j", (_cls, xml, code, limits) => {
    const bytes = typeof xml === "string" ? enc(xml) : xml;
    expect(xmlCode(bytes, limits)).toBe(mapped(code));
  });

  it("X7 checks duplicate attributes in time linear in the input, whatever the namespace URI length", () => {
    const uri = `urn:${"u".repeat(200_000)}`;
    const attrs = Array.from({ length: 1990 }, (_, k) => ` ${k % 2 ? "p" : "q"}:a${k}="1"`).join(
      "",
    );
    const started = performance.now();
    expect(xmlCode(enc(`<r xmlns:p="${uri}" xmlns:q="${uri}"${attrs}/>`))).toBe("OK");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(xmlCode(enc(`<r xmlns:p="${uri}" xmlns:q="${uri}"${attrs} q:a1="2"/>`))).toBe(
      "XML_INVALID",
    );
  });

  it("X7 resolves prefixes in scope, rebinding and the default namespace", () => {
    const result = readXml(
      enc(
        '<x:a xmlns:x="urn:1" xmlns="urn:d" b="1" x:c="2" xml:space="preserve"><x:b xmlns:x="urn:2"><d xmlns=""/></x:b><x:e/></x:a>',
      ),
      { maxDepth: 128, maxAttributes: 2000 },
    );
    if (!result.ok) throw new Error(result.code);
    const show = (n: { ns: string; local: string }) => `${n.ns}|${n.local}`;
    const seen: string[] = [];
    const walk = (el: typeof result.root): void => {
      seen.push(`<${show(el)} ${el.attributes.map(show).join(",")}`);
      for (const child of el.children) if (typeof child !== "string") walk(child);
      seen.push(`/${show(el)}`);
    };
    walk(result.root);
    expect(seen).toEqual([
      "<urn:1|a |b,urn:1|c,http://www.w3.org/XML/1998/namespace|space",
      "<urn:2|b ",
      "<|d ",
      "/|d",
      "/urn:2|b",
      "<urn:1|e ",
      "/urn:1|e",
      "/urn:1|a",
    ]);
  });

  it("errors carry only the code, never the input", () => {
    const canary = "kanarinac7Qx9";
    const refusals = [
      readXml(enc(`<a>&${canary};</a>`), { maxDepth: 128, maxAttributes: 2000 }),
      readXml(enc(`<${canary}></b>`), { maxDepth: 128, maxAttributes: 2000 }),
      openZip(fixtureZip([{ name: `../${canary}`, data: canary }]), IMPORT_READ_LIMITS),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(canary);
    }
  });
});
