// Unit tests without Docker: `node --test spikes/pdf-a/pdf-a.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";

import {
  buildCorpus,
  buildDocx,
  corpusWordCount,
  declarePdfA2u,
  DOCUMENT_FONT,
  isolatedRunArgs,
  isPinnedByDigest,
  LIBREOFFICE_IMAGE,
  parseMetrics,
  parseVeraPdfXml,
  VERAPDF_IMAGE,
} from "./index.ts";

function unzip(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const crc = bytes.readUInt32LE(offset + 16);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = inflateRawSync(bytes.subarray(dataStart, dataStart + size));
    assert.equal(crc32(data), crc, `${name} CRC`);
    entries.set(name, data);
    offset += 46 + nameLength;
  }
  return entries;
}

test("the corpus has exactly 15,000 invented words and is deterministic", () => {
  const corpus = buildCorpus(15_000);
  assert.equal(corpus.wordCount, 15_000);
  assert.equal(corpusWordCount(corpus), 15_000);
  assert.deepEqual(buildCorpus(15_000), corpus);
  assert.notDeepEqual(buildCorpus(15_000, 7), corpus);
  assert.throws(() => buildCorpus(10), RangeError);
});

test("the DOCX is a valid package that asks only for the OFL font", () => {
  const corpus = buildCorpus(15_000);
  const { bytes, footnotes } = buildDocx(corpus);
  assert.deepEqual(buildDocx(corpus).bytes, bytes, "same input, same bytes");
  const parts = unzip(bytes);
  for (const name of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/footnotes.xml",
    "word/footer1.xml",
  ]) {
    assert.ok(parts.has(name), name);
  }
  const document = parts.get("word/document.xml")?.toString("utf8") ?? "";
  const styles = parts.get("word/styles.xml")?.toString("utf8") ?? "";
  assert.ok(footnotes > 0);
  assert.equal(document.match(/<w:footnoteReference /gu)?.length, footnotes);
  assert.match(document, /<w:tbl>/u);
  assert.match(styles, /<w:lang w:val="hr-HR"/u);
  const rFonts = [...`${document}${styles}`.matchAll(/<w:rFonts\b[^>]*>/gu)]
    .map((match) => match[0])
    .join("");
  const fonts = new Set(
    [...rFonts.matchAll(/w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/gu)].map((match) => match[1]),
  );
  assert.deepEqual([...fonts], [DOCUMENT_FONT]);
  for (const paragraph of corpus.sections[0]?.subsections[0]?.paragraphs ?? []) {
    assert.ok(document.includes(paragraph.replaceAll("&", "&amp;").replaceAll('"', "&quot;")));
  }
});

test("the LibreOffice container has no network, no host mount and a pinned image", () => {
  const args = isolatedRunArgs("true");
  assert.ok(args.includes("--network=none"));
  assert.equal(args.filter((arg) => arg.startsWith("--network") || arg === "--net").length, 1);
  for (const arg of args) {
    assert.doesNotMatch(
      arg,
      /^(?:-v|--volume|--mount|--privileged|--cap-add|--add-host|--dns|--publish|-p)(?:=|$)/u,
    );
  }
  for (const flag of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pull=never",
    "--rm",
  ]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("-c") - 1], LIBREOFFICE_IMAGE);
  assert.ok(isPinnedByDigest(LIBREOFFICE_IMAGE));
  assert.ok(isPinnedByDigest(VERAPDF_IMAGE));
  assert.equal(isPinnedByDigest("gotenberg/gotenberg:8"), false);
  assert.equal(isPinnedByDigest("gotenberg/gotenberg:8@sha256:abc"), false);
  assert.equal(isPinnedByDigest(`gotenberg/gotenberg@sha256:${"0".repeat(63)}`), false);
});

const XMP = (letter: string) =>
  `<pdfaid:part>2</pdfaid:part><pdfaid:conformance>${letter}</pdfaid:conformance>`;

test("only the conformance letter changes, byte for byte", () => {
  const before = Buffer.from(`%PDF-1.7\n<x:xmpmeta>${XMP("B")}</x:xmpmeta>\n%%EOF`, "latin1");
  const after = declarePdfA2u(before);
  assert.equal(after.length, before.length);
  assert.equal(after.toString("latin1"), before.toString("latin1").replace(">B<", ">U<"));
  assert.throws(() => declarePdfA2u(after), /conformance B/u);
  assert.throws(
    () => declarePdfA2u(Buffer.from(`%PDF-1.7 ${XMP("B")}${XMP("B")}`)),
    /exactly once/u,
  );
  assert.throws(
    () => declarePdfA2u(Buffer.from("%PDF-1.7 <pdfaid:conformance>B</pdfaid:conformance>")),
    /part 2/u,
  );
});

test("the veraPDF report decides compliance", () => {
  const report = (compliant: boolean, rules: string) =>
    `<report><jobs><job><validationReport jobEndStatus="normal" profileName="PDF/A-2u validation profile" statement="x" isCompliant="${compliant}">` +
    `<details passedRules="145" failedRules="${compliant ? 0 : 1}" passedChecks="1" failedChecks="1">${rules}</details></validationReport></job></jobs></report>`;
  assert.deepEqual(parseVeraPdfXml(report(true, "")), {
    compliant: true,
    profile: "PDF/A-2u validation profile",
    failedRules: 0,
    failedClauses: [],
  });
  const failed = parseVeraPdfXml(
    report(
      false,
      '<rule specification="ISO 19005-2:2011" clause="6.6.4" testNumber="3" status="failed" failedChecks="1">',
    ),
  );
  assert.equal(failed.compliant, false);
  assert.deepEqual(failed.failedClauses, ["6.6.4 t3"]);
  assert.throws(() => parseVeraPdfXml("<report/>"), /one validationReport/u);
  assert.throws(
    () => parseVeraPdfXml(report(true, "") + report(true, "")),
    /one validationReport/u,
  );
});

test("metrics come only from the container's own line", () => {
  const stderr =
    'convert /tmp/w/rad.docx\nSPIKE_METRICS {"convertNs":900000000,"cpuNs":950000000,"memPeakBytes":110100480}\n';
  assert.deepEqual(parseMetrics(stderr, 1200), {
    wallMs: 1200,
    convertMs: 900,
    cpuMs: 950,
    memPeakMiB: 105,
  });
  assert.throws(() => parseMetrics("convert only", 1), /no metrics/u);
  assert.throws(
    () => parseMetrics('SPIKE_METRICS {"convertNs":-1,"cpuNs":1,"memPeakBytes":1}', 1),
    /convertNs/u,
  );
});
