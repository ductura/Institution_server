// SRV-1804 (M8.3): the PDF reader against the attack plan of the import
// contract (docs/adr/import-contract.md, class D and L2) and the preview with
// its manifest. Every PDF is built here in memory from invented text, with
// pdf-lib or by hand; no binary file and no real document is used.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFName,
  PDFObject,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFDict,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, resolveImportReadLimits } from "../../contracts/index.ts";
import { canonicalizeJcs } from "../../domain/index.ts";

import { preparePdfImport, readPdf } from "./index.ts";

const limits = IMPORT_READ_LIMITS;

/** A font with Croatian letters, the one PDF.js ships for its standard fonts. */
const CROATIAN_FONT = readFileSync(
  createRequire(import.meta.url).resolve("pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf"),
);
const counter = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

/** Lines per page; an empty string is a blank line, which ends a paragraph. */
async function textPdf(pages: readonly (readonly string[])[], croatian = false) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = croatian
    ? await pdf.embedFont(CROATIAN_FONT, { subset: true })
    : await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    let y = 780;
    for (const line of lines) {
      if (line !== "") page.drawText(line, { x: 60, y, size: 12, font });
      y -= 15;
    }
  }
  return pdf;
}

const save = async (pdf: PDFDocument, useObjectStreams = true) => pdf.save({ useObjectStreams });

/** A PDF written by hand: numbered objects, a correct xref and a trailer. */
function handPdf(objects: readonly string[], trailerExtra = ""): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const PAGE_TREE = [
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
];

type Literal = Parameters<PDFContext["obj"]>[0] | PDFObject;

/** A PDF dictionary from key and value pairs; PDF keys are not camelCase. */
function pdfDict(pdf: PDFDocument, entries: readonly (readonly [string, Literal])[]): PDFDict {
  const dict = pdf.context.obj({});
  for (const [key, value] of entries) {
    dict.set(PDFName.of(key), value instanceof PDFObject ? value : pdf.context.obj(value));
  }
  return dict;
}

const texts = (result: Awaited<ReturnType<typeof readPdf>>) =>
  result.ok
    ? result.content.nodes.map((node) =>
        node.type === "paragraph"
          ? node.children.map((c) => ("text" in c ? c.text : "")).join("")
          : "",
      )
    : result.code;

describe("readPdf: the text layer as document v2", () => {
  it("lines close together are one paragraph; a blank line or a page starts a new one", async () => {
    const pdf = await textPdf([
      ["Prvi odlomak teksta", "nastavlja se ovdje.", "", "Drugi odlomak."],
      ["Treca stranica."],
    ]);
    const result = await readPdf(await save(pdf), limits, counter());
    expect(texts(result)).toEqual([
      "Prvi odlomak teksta nastavlja se ovdje.",
      "Drugi odlomak.",
      "Treca stranica.",
    ]);
    expect(result.ok && result.content.nodes[0]).toMatchObject({
      type: "paragraph",
      id: expect.any(String),
    });
  });

  it("Croatian letters from an embedded font arrive as NFC text", async () => {
    const pdf = await textPdf([["Čađa i ćup, žućkasta šuma."]], true);
    const result = await readPdf(await save(pdf), limits, counter());
    expect(texts(result)).toEqual(["Čađa i ćup, žućkasta šuma."]);
  });

  it("the same bytes give the same content, and the caller's bytes stay whole", async () => {
    const bytes = await save(await textPdf([["Isti tekst."]]));
    const copy = bytes.slice();
    const a = await readPdf(bytes, limits, counter());
    const b = await readPdf(bytes, limits, counter());
    expect(a.ok && b.ok && a.contentCanonical === b.contentCanonical).toBe(true);
    expect(bytes).toEqual(copy);
  });
});

describe("readPdf: refusals (ADR class D)", () => {
  it("size and format come first", async () => {
    expect(await readPdf(new Uint8Array(), limits)).toEqual({ ok: false, code: "FILE_EMPTY" });
    const small = resolveImportReadLimits({ maxInputBytes: 10 })!;
    expect(await readPdf(new Uint8Array(11).fill(0x25), small)).toEqual({
      ok: false,
      code: "FILE_TOO_LARGE",
    });
    expect(await readPdf(new TextEncoder().encode("PK\u0003\u0004 not a pdf"), limits)).toEqual({
      ok: false,
      code: "FORMAT_NOT_ALLOWED",
    });
  });

  it("D4: a broken file is PDF_INVALID and nothing of the library's message leaks", async () => {
    const result = await readPdf(new TextEncoder().encode("%PDF-1.7\nnothing here\n"), limits);
    expect(result).toEqual({ ok: false, code: "PDF_INVALID" });
  });

  it("D5: pages without text are a scan: PDF_NO_TEXT_LAYER", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    expect(await readPdf(await save(pdf), limits)).toEqual({
      ok: false,
      code: "PDF_NO_TEXT_LAYER",
    });
  });

  it("D1: more pages than the limit is refused before any text is read", async () => {
    const bytes = await save(await textPdf([["Jedan."], ["Dva."], ["Tri."]]));
    const two = resolveImportReadLimits({ maxPdfPages: 2 })!;
    expect(await readPdf(bytes, two)).toEqual({ ok: false, code: "PDF_TOO_MANY_PAGES" });
    expect((await readPdf(bytes, resolveImportReadLimits({ maxPdfPages: 3 })!)).ok).toBe(true);
  });

  it("D2: an /Encrypt in the trailer is an encrypted file", async () => {
    const bytes = handPdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        ...PAGE_TREE,
        "<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>",
      ],
      "/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] ",
    );
    expect(await readPdf(bytes, limits)).toEqual({ ok: false, code: "PDF_ENCRYPTED" });
  });

  it("D3: a document script is refused, also inside an object stream", async () => {
    for (const useObjectStreams of [false, true]) {
      const pdf = await textPdf([["Tekst sa skriptom."]]);
      const action = pdfDict(pdf, [
        ["S", "JavaScript"],
        ["JS", PDFString.of("app.alert(1)")],
      ]);
      pdf.catalog.set(PDFName.of("OpenAction"), pdf.context.register(action));
      expect(await readPdf(await save(pdf, useObjectStreams), limits)).toEqual({
        ok: false,
        code: "PDF_ACTIVE_CONTENT",
      });
    }
  });

  it("D3: a name written with #xx escapes is read as the name it spells", async () => {
    // /#4A#53 is /JS, /Java#53cript is /JavaScript.
    const bytes = handPdf([
      "<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>",
      ...PAGE_TREE,
      "<< /S /Java#53cript /#4A#53 (app.alert(1)) >>",
    ]);
    expect(await readPdf(bytes, limits)).toEqual({ ok: false, code: "PDF_ACTIVE_CONTENT" });
  });

  it("D3: a launch action, a page trigger and an attachment are refused", async () => {
    const launch = handPdf([
      "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Launch /F (calc.exe) >> >>",
      ...PAGE_TREE,
    ]);
    const trigger = handPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /AA << /O 4 0 R >> >>",
      "<< /S /SubmitForm /F (https://primjer.invalid/) >>",
    ]);
    const attached = await textPdf([["Tekst s privitkom."]]);
    await attached.attach(new TextEncoder().encode("izmisljeno"), "privitak.txt", {
      mimeType: "text/plain",
    });
    for (const bytes of [launch, trigger, await save(attached)]) {
      expect(await readPdf(bytes, limits)).toEqual({ ok: false, code: "PDF_ACTIVE_CONTENT" });
    }
  });

  it("D3: a GoTo open action and a URI link are allowed", async () => {
    const pdf = await textPdf([["Tekst s poveznicom."]]);
    const page = pdf.getPage(0);
    pdf.catalog.set(PDFName.of("OpenAction"), pdf.context.obj([page.ref, "Fit"]));
    const goTo = pdfDict(pdf, [
      ["S", "GoTo"],
      ["D", [page.ref, "Fit"]],
    ]);
    pdf.catalog.set(PDFName.of("Outlines"), pdfDict(pdf, [["A", goTo]]));
    const uri = pdfDict(pdf, [
      ["S", "URI"],
      ["URI", PDFString.of("https://primjer.invalid/")],
    ]);
    const link = pdfDict(pdf, [
      ["Type", "Annot"],
      ["Subtype", "Link"],
      ["Rect", [0, 0, 10, 10]],
      ["A", uri],
    ]);
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(link)]));
    expect(texts(await readPdf(await save(pdf), limits))).toEqual(["Tekst s poveznicom."]);
  });

  it("L2: more text than one segment is refused, never cut", async () => {
    // About 2.4 MB of text against a bound of 2 MiB. PDF.js drops text beyond
    // the page edge, so tiny letters keep every line on the page.
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const line = "Dugacak izmisljeni redak teksta koji se ponavlja mnogo puta. ".repeat(8);
    for (let p = 0; p < 25; p++) {
      const page = pdf.addPage([595, 842]);
      for (let y = 820; y > 20; y -= 4) page.drawText(line, { x: 10, y, size: 1, font });
    }
    const result = await readPdf(await save(pdf), limits);
    expect(result).toEqual({ ok: false, code: "CONTENT_TOO_LARGE" });
  });
});

describe("preparePdfImport: the manifest with three hashes", () => {
  it("fileFormat pdf, no traces key, hashes of the bytes and of the content", async () => {
    const bytes = await save(await textPdf([["Seminar o vodi."]]));
    const prepared = await preparePdfImport({
      bytes,
      documentId: "00000000-0000-4000-8000-00000000d0c1",
      fileName: "Seminar o vodi.pdf",
      limits,
      importId: "00000000-0000-4000-8000-0000000001a1",
      uuid: counter(),
    });
    if (!prepared.ok) throw new Error(prepared.code);
    const { manifest, manifestText, manifestSha256, content } = prepared.preview;
    const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
    expect(manifest).toMatchObject({
      importKind: "file-upload",
      fileFormat: "pdf",
      rawSha256: sha(bytes),
      rawByteLength: bytes.length,
      contentSha256: sha(canonicalizeJcs(content)),
    });
    expect(Object.hasOwn(manifest, "traces")).toBe(false);
    expect(manifestText).toBe(canonicalizeJcs(manifest));
    expect(manifestSha256).toBe(sha(manifestText));
    expect(prepared.preview.fileName).toBe("Seminar o vodi.pdf");
  });

  it("a refused read gives no manifest", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const prepared = await preparePdfImport({
      bytes: await save(pdf),
      documentId: "00000000-0000-4000-8000-00000000d0c1",
      fileName: null,
      limits,
    });
    expect(prepared).toEqual({ ok: false, code: "PDF_NO_TEXT_LAYER" });
  });
});
