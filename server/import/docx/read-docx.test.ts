// SRV-1803 (M8.2): the DOCX reader against the attack plan of the import
// contract (docs/adr/import-contract.md, classes Z, X, K and L2) and the
// conversion into document v2. Every package is built here in memory from
// invented text; no binary file and no real document is used.
import { createHash } from "node:crypto";

import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, resolveImportReadLimits } from "../../contracts/index.ts";
import { canonicalizeJcs } from "../../domain/index.ts";

import { prepareDocxImport, readDocx } from "./index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const esc = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const run = (text: string, rPr = "") =>
  `<w:r w:rsidR="00A1">${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner: string, pPr = "") =>
  `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const rel = (id: string, type: string, target: string, mode = "") =>
  `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"${mode === "" ? "" : ` TargetMode="${mode}"`}/>`;
const rels = (inner: string) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;

type Options = {
  readonly mainType?: string;
  readonly types?: string;
  readonly documentRels?: string;
  readonly extra?: Zippable;
  readonly documentXml?: string;
  readonly level?: 0 | 6;
};

function pack(body: string, options: Options = {}): Uint8Array {
  const types =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${options.mainType ?? MAIN}"/>` +
    `${options.types ?? ""}</Types>`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(types),
      "_rels/.rels": strToU8(rels(rel("rId1", "officeDocument", "word/document.xml"))),
      "word/document.xml": strToU8(
        options.documentXml ??
          `${HEAD}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
      ),
      "word/_rels/document.xml.rels": strToU8(rels(options.documentRels ?? "")),
      ...options.extra,
    },
    { level: options.level ?? 6 },
  );
}

const limits = IMPORT_READ_LIMITS;
const tighter = (requested: Record<string, number>) => resolveImportReadLimits(requested)!;
const codeOf = (bytes: Uint8Array, readLimits = limits) => {
  const read = readDocx(bytes, readLimits);
  return read.ok ? "ok" : read.code;
};
let counter = 0;
/** Deterministic v4 UUIDs for node ids. */
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};

const STYLES =
  `${HEAD}<w:styles ${W}>` +
  '<w:style w:type="paragraph" w:styleId="Naslov1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Moj2"><w:name w:val="Moj podnaslov"/><w:basedOn w:val="Naslov2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Naslov2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Citat"><w:name w:val="Quote"/></w:style>' +
  "</w:styles>";

/** A seminar-like document with every element the converter knows. */
function seminar(): Uint8Array {
  const body =
    para(run("Kompostiranje u Lipovcu"), '<w:pStyle w:val="Naslov1"/>') +
    para(
      run("Prvi ") +
        run("podebljan", "<w:b/>") +
        run(" i ") +
        run("kurziv", "<w:i/>") +
        run(" tekst."),
    ) +
    para(run("Podnaslov preko stila"), '<w:pStyle w:val="Moj2"/>') +
    para(run("Stavka popisa"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>') +
    para(run("Izmišljeni citat."), '<w:pStyle w:val="Citat"/>') +
    para(
      '<w:hyperlink r:id="rId9" xmlns:r="' +
        R_NS +
        '">' +
        run("poveznica") +
        "</w:hyperlink>" +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDETEXT "c:/tajno.docx"</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        run(" rezultat polja") +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ) +
    para(
      run("Prije ") +
        '<w:del w:id="1" w:author="Marko Izmišljeni" w:date="2026-10-05T10:00:00Z"><w:r><w:delText>obrisano </w:delText></w:r></w:del>' +
        '<w:ins w:id="2" w:author="Marko Izmišljeni" w:date="2026-10-05T10:01:00Z">' +
        run("umetnuto") +
        "</w:ins>",
    ) +
    "<w:tbl><w:tr><w:tc>" +
    para(run("Ćelija tablice")) +
    "</w:tc></w:tr></w:tbl>";
  const comments =
    `${HEAD}<w:comments ${W}>` +
    '<w:comment w:id="0" w:author="Iva Izmišljena" w:date="2026-10-06T09:31:00Z"><w:p><w:r><w:t>Komentar.</w:t></w:r></w:p></w:comment>' +
    "</w:comments>";
  return pack(body, {
    documentRels:
      rel("rId9", "hyperlink", "javascript:alert(1)", "External") +
      rel("rId2", "styles", "styles.xml") +
      rel("rId3", "comments", "comments.xml"),
    extra: {
      "word/styles.xml": strToU8(STYLES),
      "word/comments.xml": strToU8(comments),
    },
  });
}

describe("readDocx: conversion into document v2", () => {
  it("reads headings, marks, lists, quotes, links, fields, changes and tables", () => {
    counter = 0;
    const read = readDocx(seminar(), limits, uuid);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const blocks = read.content.nodes.map((node) => ({
      type: node.type,
      ...("level" in node ? { level: node.level } : {}),
      children: node.children,
    }));
    expect(read.content.schemaVersion).toBe(2);
    expect(read.content.sources).toEqual([]);
    expect(blocks).toEqual([
      {
        type: "heading",
        level: 1,
        children: [{ type: "text", text: "Kompostiranje u Lipovcu", marks: [] }],
      },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Prvi ", marks: [] },
          { type: "text", text: "podebljan", marks: ["bold"] },
          { type: "text", text: " i ", marks: [] },
          { type: "text", text: "kurziv", marks: ["italic"] },
          { type: "text", text: " tekst.", marks: [] },
        ],
      },
      {
        type: "heading",
        level: 2,
        children: [{ type: "text", text: "Podnaslov preko stila", marks: [] }],
      },
      { type: "bulletItem", children: [{ type: "text", text: "Stavka popisa", marks: [] }] },
      { type: "quote", children: [{ type: "text", text: "Izmišljeni citat.", marks: [] }] },
      // K6, K7: the link keeps its text only, a field only its stored result.
      {
        type: "paragraph",
        children: [{ type: "text", text: "poveznica rezultat polja", marks: [] }],
      },
      // The deleted text of a change is not current text.
      { type: "paragraph", children: [{ type: "text", text: "Prije umetnuto", marks: [] }] },
      { type: "paragraph", children: [{ type: "text", text: "Ćelija tablice", marks: [] }] },
    ]);
    expect(read.traces).toEqual([
      { traceKind: "comment", count: 1 },
      { traceKind: "deletion", count: 1 },
      { traceKind: "insertion", count: 1 },
    ]);
  });

  it("never carries an author, date, link target, field code or deleted text (K6 to K8)", () => {
    const read = readDocx(seminar(), limits);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = read.contentCanonical;
    for (const leak of [
      "Marko",
      "Iva",
      "2026-10",
      "javascript",
      "INCLUDETEXT",
      "tajno",
      "obrisano",
      "00A1",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(read.contentCanonical).toBe(canonicalizeJcs(read.content));
  });

  it("takes text as document v2 takes it: no control or invisible character, NFC", () => {
    const body = para(run("A\u200Bb\u202Ec\u00ADd") + "<w:r><w:tab/></w:r>" + run("e\u0301"));
    const read = readDocx(pack(body), limits);
    expect(read.ok && read.content.nodes[0]!.children).toEqual([
      { type: "text", text: "Abcd \u00e9", marks: [] },
    ]);
  });

  it("gives one empty paragraph for a document without text", () => {
    const read = readDocx(pack(""), limits);
    expect(read.ok && read.content.nodes.map((n) => [n.type, n.children.length])).toEqual([
      ["paragraph", 0],
    ]);
    expect(read.ok && read.traces).toEqual([]);
  });

  it("refuses a main part that is not a WordprocessingML document (Strict OOXML)", () => {
    const strict = `${HEAD}<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body/></w:document>`;
    expect(codeOf(pack("", { documentXml: strict }))).toBe("PACKAGE_INVALID");
  });
});

describe("readDocx: size and format", () => {
  it("refuses an empty file, a file above the limit and a file that is no ZIP", () => {
    expect(codeOf(new Uint8Array())).toBe("FILE_EMPTY");
    const file = seminar();
    expect(codeOf(file, tighter({ maxInputBytes: file.length - 1 }))).toBe("FILE_TOO_LARGE");
    expect(codeOf(file, tighter({ maxInputBytes: file.length }))).toBe("ok");
    expect(codeOf(strToU8("%PDF-1.7 izmišljeno"))).toBe("FORMAT_NOT_ALLOWED");
    expect(codeOf(new Uint8Array(IMPORT_READ_LIMITS.maxInputBytes + 1).fill(0x50))).toBe(
      "FILE_TOO_LARGE",
    );
  });

  it("refuses content larger than one segment, never cutting it (L2)", () => {
    // Pseudo-random letters, so the file stays under 2 MiB and under the ratio.
    let seed = 7;
    const letter = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return String.fromCharCode(97 + (seed % 26));
    };
    const paragraphs: string[] = [];
    for (let p = 0; p < 1200; p += 1) {
      let text = "";
      for (let i = 0; i < 2000; i += 1) text += letter();
      paragraphs.push(para(run(text)));
    }
    const file = pack(paragraphs.join(""));
    expect(file.length).toBeLessThan(IMPORT_READ_LIMITS.maxInputBytes);
    expect(codeOf(file)).toBe("CONTENT_TOO_LARGE");
  });
});

/** Byte offsets of the central directory entry and local header of one part. */
function locate(bytes: Uint8Array, name: string): { central: number; local: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const target = strToU8(name);
  for (let at = 0; at + 46 < bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const length = view.getUint16(at + 28, true);
    const stored = bytes.subarray(at + 46, at + 46 + length);
    if (length === target.length && stored.every((b, i) => b === target[i])) {
      return { central: at, local: view.getUint32(at + 42, true) };
    }
  }
  throw new Error("part not found");
}

describe("readDocx: ZIP bombs and broken containers (Z)", () => {
  it("Z1: refuses a part whose ratio is above the limit before inflating it", () => {
    const file = pack(para(run("x")), {
      extra: { "word/media/nule.bin": new Uint8Array(4 * 1024 * 1024) },
    });
    expect(file.length).toBeLessThan(64 * 1024);
    expect(codeOf(file)).toBe("ZIP_RATIO_EXCEEDED");
  });

  it("Z2: refuses parts whose sum is above the total limit", () => {
    expect(codeOf(seminar(), tighter({ maxTotalBytes: 1000 }))).toBe("ZIP_TOTAL_TOO_LARGE");
  });

  it("Z3: refuses a local header or inflated size that disagrees with the central directory", () => {
    const file = seminar();
    const { central, local } = locate(file, "word/document.xml");
    const lying = file.slice();
    const view = new DataView(lying.buffer);
    view.setUint32(central + 24, view.getUint32(central + 24, true) - 1, true);
    expect(codeOf(lying)).toBe("ZIP_INVALID");
    // Both headers agree on a size smaller than the real one: inflating stops at it.
    view.setUint32(local + 22, view.getUint32(central + 24, true), true);
    expect(codeOf(lying)).toBe("ZIP_INVALID");
    const badCrc = file.slice();
    const crcView = new DataView(badCrc.buffer);
    crcView.setUint32(central + 16, crcView.getUint32(central + 16, true) ^ 1, true);
    expect(codeOf(badCrc)).toBe("ZIP_INVALID");
  });

  it("Z5: refuses too many entries, a duplicate, a bad path and an encrypted entry", () => {
    expect(codeOf(seminar(), tighter({ maxEntries: 3 }))).toBe("ZIP_TOO_MANY_ENTRIES");
    expect(codeOf(pack("", { extra: { "WORD/document.xml": strToU8("<x/>") } }))).toBe(
      "ZIP_DUPLICATE_ENTRY",
    );
    for (const name of [
      "../izvan.xml",
      "word/../../izvan.xml",
      "/apsolutno.xml",
      "word\\x.xml",
      "c:x.xml",
    ]) {
      expect(codeOf(pack("", { extra: { [name]: strToU8("<x/>") } }))).toBe("ZIP_PATH_INVALID");
    }
    const file = seminar();
    const { central, local } = locate(file, "word/document.xml");
    const view = new DataView(file.buffer);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) | 1, true);
    expect(codeOf(file)).toBe("ZIP_ENCRYPTED");
  });

  it("refuses a truncated archive", () => {
    const file = seminar();
    expect(codeOf(file.subarray(0, file.length - 30))).toBe("ZIP_INVALID");
  });
});

describe("readDocx: hostile XML (X)", () => {
  const withDocument = (xml: string) => pack("", { documentXml: xml });
  it("X1: refuses a DTD, an external entity and billion laughs, expanding nothing", () => {
    const xxe = `${HEAD}<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document ${W}><w:body>${para(run("&x;"))}</w:body></w:document>`;
    expect(codeOf(withDocument(xxe))).toBe("XML_DTD");
    const laughs = `${HEAD}<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><w:document ${W}/>`;
    expect(codeOf(withDocument(laughs))).toBe("XML_DTD");
    const undeclared = `${HEAD}<w:document ${W}><w:body><w:p><w:r><w:t>&nepoznat;</w:t></w:r></w:p></w:body></w:document>`;
    expect(codeOf(withDocument(undeclared))).toBe("XML_INVALID");
  });

  it("X2: refuses nesting deeper than the limit", () => {
    const deep = (depth: number) =>
      `${HEAD}<w:document ${W}><w:body>${"<w:sdt><w:sdtContent>".repeat(depth)}${"</w:sdtContent></w:sdt>".repeat(depth)}</w:body></w:document>`;
    // document, body, then two elements per level: 2 + 2 * 63 = 128 is the limit.
    expect(codeOf(withDocument(deep(63)))).toBe("ok");
    expect(codeOf(withDocument(deep(64)))).toBe("XML_TOO_DEEP");
  });

  it("X3: refuses an element with more attributes than the limit, quickly", () => {
    const attributes = (count: number) =>
      Array.from({ length: count }, (_, i) => ` a${i}="v"`).join("");
    const many = (count: number) =>
      `${HEAD}<w:document ${W}><w:body><w:p${attributes(count)}/></w:body></w:document>`;
    const started = performance.now();
    expect(codeOf(withDocument(many(2001)))).toBe("XML_TOO_MANY_ATTRIBUTES");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(codeOf(withDocument(many(1999)))).toBe("ok");
  });

  it("X4: refuses a part above the part limit before parsing it", () => {
    expect(codeOf(seminar(), tighter({ maxPartBytes: 1000 }))).toBe("ZIP_PART_TOO_LARGE");
  });

  it("X5: refuses a processing instruction, bad UTF-8 and malformed markup", () => {
    expect(codeOf(withDocument(`${HEAD}<?evil x?><w:document ${W}/>`))).toBe("XML_INVALID");
    const bad = new Uint8Array([
      ...strToU8(`<w:document ${W}><w:body><w:p><w:r><w:t>`),
      0xc3,
      0x28,
      ...strToU8("</w:t></w:r></w:p></w:body></w:document>"),
    ]);
    const broken = zipSync({
      "[Content_Types].xml": strToU8(
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${MAIN}"/></Types>`,
      ),
      "_rels/.rels": strToU8(rels(rel("rId1", "officeDocument", "word/document.xml"))),
      "word/document.xml": bad,
    });
    expect(codeOf(broken)).toBe("XML_INVALID");
    for (const xml of [
      `<w:document ${W}><w:body></w:document>`,
      `<w:document ${W}><w:body/></w:document><extra/>`,
      `<w:document ${W}><x:body/></w:document>`,
      `<w:document ${W} a="1" a="2"/>`,
      `<?xml version="1.0" encoding="UTF-16"?><w:document ${W}/>`,
    ]) {
      expect(codeOf(withDocument(xml))).toBe("XML_INVALID");
    }
  });
});

describe("readDocx: macros, embedded objects and external resources (K)", () => {
  it("K1: refuses a macro project in any folder and a macro-enabled main part", () => {
    expect(codeOf(pack("", { extra: { "word/vbaProject.bin": new Uint8Array([1, 2, 3]) } }))).toBe(
      "MACRO_PRESENT",
    );
    expect(codeOf(pack("", { extra: { "drugo/vbaproject.bin": new Uint8Array([1]) } }))).toBe(
      "MACRO_PRESENT",
    );
    const docm = "application/vnd.ms-word.document.macroEnabled.main+xml";
    expect(codeOf(pack("", { mainType: docm }))).toBe("MACRO_PRESENT");
    expect(codeOf(pack("", { documentRels: rel("rId5", "vbaProject", "nema.bin") }))).toBe(
      "MACRO_PRESENT",
    );
  });

  it("K2: refuses a template as the main part", () => {
    const template =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
    expect(codeOf(pack("", { mainType: template }))).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("K3, Z4: refuses OLE, altChunk, ActiveX, a subdocument and an embedded package", () => {
    for (const type of ["oleObject", "aFChunk", "control", "subDocument"]) {
      expect(codeOf(pack("", { documentRels: rel("rId5", type, "x.bin") }))).toBe(
        "EMBEDDED_CONTENT",
      );
    }
    expect(
      codeOf(pack("", { extra: { "word/embeddings/ugradjeno.docx": new Uint8Array([1]) } })),
    ).toBe("EMBEDDED_CONTENT");
  });

  it("K4: refuses an external image or template and fetches nothing", () => {
    expect(
      codeOf(
        pack("", {
          documentRels: rel("rId5", "image", "http://primjer.invalid/a.png", "External"),
        }),
      ),
    ).toBe("EXTERNAL_RESOURCE");
    expect(
      codeOf(
        pack("", {
          extra: {
            "word/_rels/settings.xml.rels": strToU8(
              rels(rel("rId1", "attachedTemplate", "file:///c:/predlozak.dotm", "External")),
            ),
          },
        }),
      ),
    ).toBe("EXTERNAL_RESOURCE");
  });

  it("K5: refuses an unknown target mode and an empty type", () => {
    expect(codeOf(pack("", { documentRels: rel("rId5", "image", "a.png", "Daljinski") }))).toBe(
      "PACKAGE_INVALID",
    );
    expect(
      codeOf(pack("", { documentRels: '<Relationship Id="rId5" Type="" Target="a.png"/>' })),
    ).toBe("PACKAGE_INVALID");
  });

  it("refuses a package without content types, main document or with a target outside it", () => {
    const noMain = zipSync({
      "[Content_Types].xml": strToU8(
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      ),
    });
    expect(codeOf(noMain)).toBe("PACKAGE_INVALID");
    expect(codeOf(pack("", { documentRels: rel("rId2", "styles", "../../styles.xml") }))).toBe(
      "PACKAGE_INVALID",
    );
  });
});

describe("prepareDocxImport: the manifest and its three hashes", () => {
  const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const IMPORT_ID = "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c";

  it("builds the canonical manifest from the received bytes, the name outside it (D-292)", () => {
    const bytes = seminar();
    const prepared = prepareDocxImport({
      bytes,
      documentId: "dokument-izmisljeni-uvoz",
      fileName: "C:\\Users\\x\\Seminar \u202Egnp.docx",
      limits,
      importId: IMPORT_ID,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { preview } = prepared;
    expect(preview.manifest).toEqual({
      manifestSchema: "ductus-import-manifest-v1",
      importId: IMPORT_ID,
      documentId: "dokument-izmisljeni-uvoz",
      importKind: "file-upload",
      fileFormat: "docx",
      rawSha256: sha(bytes),
      rawByteLength: bytes.length,
      contentSha256: sha(canonicalizeJcs(preview.content)),
      traces: [
        { traceKind: "comment", count: 1 },
        { traceKind: "deletion", count: 1 },
        { traceKind: "insertion", count: 1 },
      ],
    });
    expect(preview.manifestText).toBe(canonicalizeJcs(preview.manifest));
    expect(preview.manifestSha256).toBe(sha(preview.manifestText));
    expect(preview.fileName).toBe("Seminar gnp.docx");
    expect(preview.manifestText).not.toContain("Seminar");
  });

  it("mints a fresh UUID v4 import id and refuses a document id the manifest refuses", () => {
    const first = prepareDocxImport({ bytes: seminar(), documentId: "d", fileName: null, limits });
    expect(first.ok && /^[0-9a-f-]{36}$/.test(first.preview.importId)).toBe(true);
    expect(first.ok && first.preview.fileName).toBe(null);
    const tooLong = prepareDocxImport({
      bytes: seminar(),
      documentId: "d".repeat(257),
      fileName: null,
      limits,
    });
    expect(tooLong).toEqual({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("passes a read refusal through as its code only", () => {
    expect(
      prepareDocxImport({ bytes: strToU8("nije docx"), documentId: "d", fileName: "a", limits }),
    ).toEqual({ ok: false, code: "FORMAT_NOT_ALLOWED" });
  });
});
