// F4-PM2-R18 step 3: the ODT reader against ADR docs/adr/import-manifest-v2.md
// (§2, §2a, §4 t. 3) and the attack classes Z, X and K of the import
// contract. Every package is built here in memory from invented text
// (people and places end in .invalid); no binary file and no real document.
import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, resolveImportReadLimits } from "../../contracts/index.ts";
import { fixtureZip } from "../../../test-support/docx-zip/index.ts";

import { importFormatOf } from "../index.ts";
import { hasOdtSignature, ODT_MIMETYPE, readOdt } from "./index.ts";

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink"';
const MANIFEST_NS = 'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';
const STYLES =
  "<office:automatic-styles>" +
  '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>' +
  '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Quotations"/>' +
  "</office:automatic-styles>";

const content = (body: string, before = "") =>
  `${HEAD}<office:document-content ${NS} office:version="1.3">${before}${STYLES}` +
  `<office:body><office:text>${body}</office:text></office:body></office:document-content>`;
const manifest = (inner = "") =>
  `${HEAD}<manifest:manifest ${MANIFEST_NS} manifest:version="1.3">` +
  `<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODT_MIMETYPE}"/>` +
  `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${inner}</manifest:file-entry>` +
  "</manifest:manifest>";
const META =
  `${HEAD}<office:document-meta ${NS}><office:meta><dc:creator>Iva Primjer (iva@primjer.invalid)</dc:creator>` +
  "<dc:date>2026-11-01T10:00:00</dc:date></office:meta></office:document-meta>";

type Options = {
  readonly mimetype?: string;
  readonly contentXml?: string;
  readonly manifestXml?: string | null;
  readonly extra?: Zippable;
  readonly contentLevel?: 0 | 6;
};

function odt(body: string, options: Options = {}): Uint8Array {
  const files: Zippable = {
    mimetype: [strToU8(options.mimetype ?? ODT_MIMETYPE), { level: 0 }],
    "content.xml": [
      strToU8(options.contentXml ?? content(body)),
      { level: options.contentLevel ?? 6 },
    ],
    "meta.xml": strToU8(META),
    ...options.extra,
  };
  if (options.manifestXml !== null) {
    files["META-INF/manifest.xml"] = strToU8(options.manifestXml ?? manifest());
  }
  return zipSync(files, { level: 6 });
}

const limits = IMPORT_READ_LIMITS;
const tighter = (requested: Record<string, number>) => resolveImportReadLimits(requested)!;
const codeOf = (bytes: Uint8Array, readLimits = limits) => {
  const read = readOdt(bytes, readLimits);
  return read.ok ? "ok" : read.code;
};
let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};
const read = (bytes: Uint8Array) => {
  const result = readOdt(bytes, limits, uuid);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
};
const shape = (bytes: Uint8Array) =>
  read(bytes).content.nodes.map((node) => {
    const rest: Record<string, unknown> = { ...node };
    delete rest.id;
    return rest;
  });

describe("readOdt: text", () => {
  it("reads paragraphs, headings, list items, quotes, marks and table cells", () => {
    const body =
      '<text:h text:outline-level="1">Uvod u temu</text:h>' +
      '<text:h text:outline-level="5">Duboki naslov</text:h>' +
      '<text:p>Prvi <text:span text:style-name="T1">podebljani</text:span> i ' +
      '<text:span text:style-name="T2">kurzivni</text:span> dio.</text:p>' +
      '<text:p>\n    Razmaci   se\n sažimaju,<text:s text:c="2"/>a pisani<text:tab/>ostaju.</text:p>' +
      '<text:list><text:list-item><text:p>Stavka <text:a xlink:href="https://primjer.invalid/x">poveznica</text:a></text:p></text:list-item></text:list>' +
      '<text:p text:style-name="P1">Citirani odlomak.</text:p>' +
      "<table:table><table:table-row><table:table-cell><text:p>Ćelija</text:p></table:table-cell></table:table-row></table:table>" +
      "<text:p/>";
    expect(shape(odt(body))).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Uvod u temu", marks: [] }] },
      { type: "heading", level: 3, children: [{ type: "text", text: "Duboki naslov", marks: [] }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Prvi ", marks: [] },
          { type: "text", text: "podebljani", marks: ["bold"] },
          { type: "text", text: " i ", marks: [] },
          { type: "text", text: "kurzivni", marks: ["italic"] },
          { type: "text", text: " dio.", marks: [] },
        ],
      },
      {
        type: "paragraph",
        children: [{ type: "text", text: "Razmaci se sažimaju,  a pisani ostaju.", marks: [] }],
      },
      { type: "bulletItem", children: [{ type: "text", text: "Stavka poveznica", marks: [] }] },
      { type: "quote", children: [{ type: "text", text: "Citirani odlomak.", marks: [] }] },
      { type: "paragraph", children: [{ type: "text", text: "Ćelija", marks: [] }] },
      { type: "paragraph", children: [] },
    ]);
    const canonical = read(odt(body)).contentCanonical;
    expect(canonical).not.toContain("primjer.invalid");
  });

  it("an empty document is one empty paragraph and no traces", () => {
    const result = read(odt(""));
    expect(result.content.nodes).toEqual([
      { type: "paragraph", id: expect.any(String), children: [] },
    ]);
    expect(result.traces).toEqual([]);
    expect(codeOf(new Uint8Array())).toBe("FILE_EMPTY");
  });

  it("never reads meta.xml, notes or the fields that show a person", () => {
    const body =
      "<text:p>Tekst<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Bilješka</text:p></text:note-body></text:note>" +
      " <text:author-name>Iva Primjer</text:author-name><text:initial-creator>Ana Primjer</text:initial-creator>" +
      "<text:sender-email>iva@primjer.invalid</text:sender-email>kraj</text:p>";
    const { contentCanonical } = read(odt(body));
    expect(contentCanonical).toContain("Tekst kraj");
    for (const hidden of ["Bilješka", "Primjer", "primjer.invalid", "2026-11-01"]) {
      expect(contentCanonical).not.toContain(hidden);
    }
  });

  it("refuses text past one segment while reading it (L2)", () => {
    const spaces = '<text:s text:c="999999999"/>'.repeat(2100);
    expect(codeOf(odt(`<text:p>a${spaces}b</text:p>`, { contentLevel: 0 }))).toBe(
      "CONTENT_TOO_LARGE",
    );
  });
});

describe("readOdt: traces (ADR §2)", () => {
  it("counts annotations and changed regions, without their text", () => {
    const tracked =
      "<text:tracked-changes>" +
      '<text:changed-region text:id="c1"><text:deletion><office:change-info><dc:creator>Iva Primjer</dc:creator></office:change-info><text:p>Obrisani tekst</text:p></text:deletion></text:changed-region>' +
      '<text:changed-region text:id="c2"><text:insertion><office:change-info><dc:creator>Iva Primjer</dc:creator></office:change-info></text:insertion></text:changed-region>' +
      '<text:changed-region text:id="c3"><text:insertion/></text:changed-region>' +
      '<text:changed-region text:id="c4"><text:format-change/></text:changed-region>' +
      "</text:tracked-changes>";
    const body =
      tracked +
      '<text:p>Prije<text:change text:change-id="c1"/> <text:change-start text:change-id="c2"/>umetnuto<text:change-end text:change-id="c2"/>' +
      '<office:annotation office:name="a1"><dc:creator>Iva Primjer</dc:creator><text:p>Komentar jedan</text:p></office:annotation>' +
      ' poslije<office:annotation-end office:name="a1"/></text:p>' +
      "<table:table><table:table-row><table:table-cell><office:annotation><text:p>Komentar dva</text:p></office:annotation><text:p>Ćelija</text:p></table:table-cell></table:table-row></table:table>";
    const result = read(odt(body));
    expect(result.traces).toEqual([
      { traceKind: "comment", count: 2 },
      { traceKind: "deletion", count: 1 },
      { traceKind: "insertion", count: 2 },
    ]);
    expect(result.contentCanonical).toContain("Prije umetnuto poslije");
    for (const hidden of ["Obrisani", "Komentar", "Primjer"]) {
      expect(result.contentCanonical).not.toContain(hidden);
    }
  });
});

describe("readOdt: format by content", () => {
  it("knows an ODT by its mimetype entry, not by a name", () => {
    expect(hasOdtSignature(odt("<text:p>a</text:p>"))).toBe(true);
    expect(importFormatOf(odt("<text:p>a</text:p>"))).toBe("odt");
    expect(importFormatOf(strToU8("%PDF-1.7\n"))).toBe("pdf");
    expect(importFormatOf(zipSync({ "word/document.xml": strToU8("<x/>") }))).toBe("docx");
  });

  it("refuses a wrong, moved, compressed or padded mimetype", () => {
    const body = "<text:p>a</text:p>";
    expect(codeOf(odt(body, { mimetype: "application/vnd.oasis.opendocument.spreadsheet" }))).toBe(
      "FORMAT_NOT_ALLOWED",
    );
    expect(codeOf(odt(body, { mimetype: `${ODT_MIMETYPE}\n` }))).toBe("FORMAT_NOT_ALLOWED");
    const moved = zipSync({
      "content.xml": strToU8(content(body)),
      mimetype: [strToU8(ODT_MIMETYPE), { level: 0 }],
      "META-INF/manifest.xml": strToU8(manifest()),
    });
    expect(codeOf(moved)).toBe("FORMAT_NOT_ALLOWED");
    const deflated = zipSync({
      mimetype: [strToU8(ODT_MIMETYPE), { level: 9 }],
      "content.xml": strToU8(content(body)),
      "META-INF/manifest.xml": strToU8(manifest()),
    });
    expect(codeOf(deflated)).toBe("FORMAT_NOT_ALLOWED");
    expect(codeOf(strToU8("not a zip at all, only invented text"))).toBe("FORMAT_NOT_ALLOWED");
  });

  it("refuses a package that is not a text document", () => {
    const sheet = `${HEAD}<office:document-content ${NS}><office:body><office:spreadsheet/></office:body></office:document-content>`;
    expect(codeOf(odt("", { contentXml: sheet }))).toBe("PACKAGE_INVALID");
    expect(codeOf(odt("<text:p>a</text:p>", { manifestXml: null }))).toBe("PACKAGE_INVALID");
  });
});

describe("readOdt: ZIP (class Z)", () => {
  const good = odt("<text:p>Izmišljeni odlomak.</text:p>");

  it("refuses a damaged archive", () => {
    expect(codeOf(good.subarray(0, good.length - 10))).toBe("ZIP_INVALID");
    const flipped = Uint8Array.from(good);
    const at = flipped.length - 200;
    flipped[at] = flipped[at]! ^ 0xff;
    expect(codeOf(flipped)).not.toBe("ok");
  });

  it("refuses a zip bomb past the ratio, part, total and entry limits", () => {
    const filler = `<text:p>${"a".repeat(400_000)}</text:p>`;
    expect(codeOf(odt(filler))).toBe("ZIP_RATIO_EXCEEDED");
    expect(codeOf(odt(filler, { contentLevel: 0 }), tighter({ maxPartBytes: 100_000 }))).toBe(
      "ZIP_PART_TOO_LARGE",
    );
    expect(codeOf(odt("<text:p>a</text:p>"), tighter({ maxTotalBytes: 500 }))).toBe(
      "ZIP_TOTAL_TOO_LARGE",
    );
    expect(codeOf(odt("<text:p>a</text:p>"), tighter({ maxEntries: 3 }))).toBe(
      "ZIP_TOO_MANY_ENTRIES",
    );
    expect(codeOf(odt("<text:p>a</text:p>"), tighter({ maxInputBytes: 100 }))).toBe(
      "FILE_TOO_LARGE",
    );
  });

  it.each(["../content.xml", "/content.xml", "a/../../content.xml", "META-INF\\..\\x.xml"])(
    "refuses the entry path %s",
    (name) => {
      const bytes = fixtureZip([
        { name: "mimetype", data: ODT_MIMETYPE },
        { name: "META-INF/manifest.xml", data: manifest(), method: 8 },
        { name, data: content("<text:p>a</text:p>"), method: 8 },
      ]);
      expect(hasOdtSignature(bytes)).toBe(true);
      expect(codeOf(bytes)).toBe("ZIP_PATH_INVALID");
    },
  );
});

describe("readOdt: XML (class X)", () => {
  it("never resolves an external entity: a DTD is refused", () => {
    const xxe =
      `${HEAD}<!DOCTYPE office:document-content [<!ENTITY xxe SYSTEM "file:///etc/hostname">]>` +
      content("<text:p>&xxe;</text:p>").slice(HEAD.length);
    expect(codeOf(odt("", { contentXml: xxe }))).toBe("XML_DTD");
    expect(codeOf(odt("<text:p>&xxe;</text:p>"))).toBe("XML_INVALID");
    const manifestXxe = `${HEAD}<!DOCTYPE m [<!ENTITY e SYSTEM "http://primjer.invalid/e">]>${manifest().slice(HEAD.length)}`;
    expect(codeOf(odt("<text:p>a</text:p>", { manifestXml: manifestXxe }))).toBe("XML_DTD");
  });

  it("holds the depth and attribute limits", () => {
    const deep = `${"<text:span>".repeat(200)}a${"</text:span>".repeat(200)}`;
    expect(codeOf(odt(`<text:p>${deep}</text:p>`))).toBe("XML_TOO_DEEP");
    const attributes = Array.from({ length: 30 }, (_, i) => `a${i}="x"`).join(" ");
    expect(codeOf(odt(`<text:p ${attributes}>a</text:p>`), tighter({ maxXmlAttributes: 20 }))).toBe(
      "XML_TOO_MANY_ATTRIBUTES",
    );
  });
});

describe("readOdt: encrypted and active content (class K)", () => {
  const body = "<text:p>a</text:p>";

  it("refuses an encrypted package", () => {
    const encrypted = manifest(
      '<manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="AAAA"/>',
    );
    expect(codeOf(odt(body, { manifestXml: encrypted }))).toBe("ZIP_ENCRYPTED");
  });

  it("refuses macros, scripts and event listeners", () => {
    expect(codeOf(odt(body, { extra: { "Basic/Standard/Module1.xml": strToU8("<x/>") } }))).toBe(
      "MACRO_PRESENT",
    );
    const scripts = '<office:scripts><office:script script:language="ooo:Basic"/></office:scripts>';
    expect(codeOf(odt("", { contentXml: content(body, scripts) }))).toBe("MACRO_PRESENT");
    const listener =
      '<text:p><text:a xlink:href="#x"><office:event-listeners><script:event-listener script:event-name="dom:click"/></office:event-listeners>a</text:a></text:p>';
    expect(codeOf(odt(listener))).toBe("MACRO_PRESENT");
    // An empty office:scripts is what an office suite writes for every document.
    expect(codeOf(odt("", { contentXml: content(body, "<office:scripts/>") }))).toBe("ok");
  });

  it("refuses embedded objects", () => {
    expect(codeOf(odt(body, { extra: { "Object 1/content.xml": strToU8("<x/>") } }))).toBe(
      "EMBEDDED_CONTENT",
    );
    const frame =
      '<text:p><draw:frame><draw:object xlink:href="./Object 1"/></draw:frame></text:p>';
    expect(codeOf(odt(frame))).toBe("EMBEDDED_CONTENT");
  });
});
