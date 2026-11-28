import { createHash } from "node:crypto";

import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFObject } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS } from "../../contracts/index.ts";
import { canonicalizeJcs } from "../../domain/index.ts";

import { preparePdfImport } from "./index.ts";
import { readPdf } from "./read-pdf.ts";

async function pdf(text?: string) {
  const document = await PDFDocument.create();
  const page = document.addPage();
  if (text === undefined) {
    // An invented one-pixel raster image with no text operators.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
      "base64",
    );
    page.drawImage(await document.embedPng(png));
  } else {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { font, lineHeight: 16, x: 20, y: page.getHeight() - 30 });
  }
  return { document, page };
}

const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function dictionary(document: PDFDocument, entries: readonly (readonly [string, PDFObject])[]) {
  const result = document.context.obj({});
  for (const [key, value] of entries) result.set(PDFName.of(key), value);
  return result;
}

const javascript = [
  ["S", PDFName.of("JavaScript")],
  ["JS", PDFString.of("")],
] as const;

describe("PDF import", () => {
  it("uses the V1 upload manifest and binds the bytes, canonical document and manifest", async () => {
    const { document } = await pdf("Izmisljeni rad\nDrugi redak.");
    document.addPage();
    const bytes = await document.save();
    const result = await preparePdfImport({
      bytes,
      documentId: "rad-izmisljeni",
      fileName: "demo/Izmisljeni rad.pdf",
      limits: IMPORT_READ_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.content.nodes).toMatchObject([
      { type: "paragraph", children: [{ type: "text", text: "Izmisljeni rad", marks: [] }] },
      { type: "paragraph", children: [{ type: "text", text: "Drugi redak.", marks: [] }] },
    ]);
    expect(preview.manifest).toEqual({
      manifestSchema: "ductus-import-manifest-v1",
      importId: preview.importId,
      documentId: "rad-izmisljeni",
      importKind: "file-upload",
      fileFormat: "pdf",
      rawByteLength: bytes.length,
      rawSha256: hash(bytes),
      contentSha256: hash(canonicalizeJcs(preview.content)),
    });
    expect(preview.fileName).toBe("Izmisljeni rad.pdf");
    expect(preview.manifestText).toBe(canonicalizeJcs(preview.manifest));
    expect(preview.manifestSha256).toBe(hash(preview.manifestText));
  }, 20_000);

  it.each([undefined, "   "])(
    "refuses a raster scan or whitespace-only page (%s)",
    async (text) => {
      const { document } = await pdf(text);
      expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toEqual({
        ok: false,
        code: "pdf_no_text_layer",
      });
    },
  );

  it.each([
    ["empty input", "", "FILE_EMPTY"],
    ["another format", "tekst", "FORMAT_NOT_ALLOWED"],
    ["broken PDF", "%PDF-1.7\n", "PDF_INVALID"],
  ])("refuses %s", async (_label, input, code) => {
    expect(await readPdf(Buffer.from(input), IMPORT_READ_LIMITS)).toEqual({ ok: false, code });
  });

  it("enforces both the upload and the page limit", async () => {
    const { document } = await pdf("Izmisljeni rad");
    document.addPage();
    const bytes = await document.save();
    expect(
      await readPdf(bytes, { ...IMPORT_READ_LIMITS, maxInputBytes: bytes.length - 1 }),
    ).toEqual({
      ok: false,
      code: "FILE_TOO_LARGE",
    });
    expect(await readPdf(bytes, { ...IMPORT_READ_LIMITS, maxPdfPages: 1 })).toEqual({
      ok: false,
      code: "PDF_TOO_MANY_PAGES",
    });
  });

  it.each([
    ["document JavaScript", "OpenAction", javascript],
    ["launch action", "OpenAction", [["S", PDFName.of("Launch")]]],
    ["automatic action", "OpenAction", [["S", PDFName.of("Named")]]],
    ["embedded file", "Names", [["EmbeddedFiles", PDFString.of("")]]],
    ["XFA form", "AcroForm", [["XFA", PDFString.of("")]]],
    ["rich media", "Example", [["Subtype", PDFName.of("RichMedia")]]],
  ] as const)("refuses %s in compressed PDF objects", async (_label, key, entries) => {
    const { document } = await pdf("Izmisljeni rad");
    document.catalog.set(PDFName.of(key), document.context.register(dictionary(document, entries)));
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "PDF_ACTIVE_CONTENT",
    });
  });

  it("refuses page JavaScript before extracting text", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    page.node.set(
      PDFName.of("AA"),
      dictionary(document, [["O", dictionary(document, javascript)]]),
    );
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "PDF_ACTIVE_CONTENT",
    });
  });

  it("refuses an encryption dictionary before reading pages", async () => {
    const { document } = await pdf("Izmisljeni rad");
    document.context.trailerInfo.Encrypt = document.context.register(
      dictionary(document, [["Filter", PDFName.of("Standard")]]),
    );
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "PDF_ENCRYPTED",
    });
  });

  it("accepts a destination array in OpenAction", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    document.catalog.set(PDFName.of("OpenAction"), document.context.obj([page.ref, "Fit"]));
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toMatchObject({ ok: true });
  });
});

// ADR docs/adr/import-manifest-v2.md §2, §2a and §4 t. 4.
describe("PDF comment traces", () => {
  const SECRET = "Izmisljeni komentar asistent@primjer.invalid";

  function annotation(
    document: PDFDocument,
    subtype: string,
    extra: readonly (readonly [string, PDFObject])[] = [],
  ) {
    return dictionary(document, [
      ["Type", PDFName.of("Annot")],
      ["Subtype", PDFName.of(subtype)],
      ["Rect", document.context.obj([20, 20, 60, 40])],
      ["Contents", PDFString.of(SECRET)],
      ["T", PDFString.of("Izmisljena Osoba")],
      ...extra,
    ]);
  }

  it("gives no traces for a PDF without annotations", async () => {
    const { document } = await pdf("Izmisljeni rad");
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toMatchObject({
      ok: true,
      traces: [],
    });
  });

  it("counts Text and FreeText threads, not popups, replies or markup", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    const note = document.context.register(annotation(document, "Text"));
    page.node.addAnnot(note);
    page.node.addAnnot(
      document.context.register(annotation(document, "Popup", [["Parent", note]])),
    );
    page.node.addAnnot(document.context.register(annotation(document, "Text", [["IRT", note]])));
    page.node.addAnnot(document.context.register(annotation(document, "FreeText")));
    page.node.addAnnot(document.context.register(annotation(document, "Highlight")));
    page.node.addAnnot(document.context.register(annotation(document, "StrikeOut")));
    // The same annotation on a second page is still one thread.
    document.addPage().node.addAnnot(note);
    const read = await readPdf(await document.save(), IMPORT_READ_LIMITS);
    expect(read).toMatchObject({ ok: true, traces: [{ traceKind: "comment", count: 2 }] });
    if (!read.ok) return;
    expect(read.content.nodes).toMatchObject([
      { type: "paragraph", children: [{ type: "text", text: "Izmisljeni rad", marks: [] }] },
    ]);
    // Contents and author of an annotation never reach the text (§2a, K8).
    expect(JSON.stringify(read)).not.toMatch(/komentar|Osoba/);
  });

  it("keeps the v1 manifest without traces and the same text", async () => {
    const plain = await pdf("Izmisljeni rad");
    const commented = await pdf("Izmisljeni rad");
    commented.page.node.addAnnot(
      commented.document.context.register(annotation(commented.document, "Text")),
    );
    const reads = await Promise.all(
      [plain, commented].map(async ({ document }) =>
        preparePdfImport({
          bytes: await document.save(),
          documentId: "rad-izmisljeni",
          fileName: null,
          limits: IMPORT_READ_LIMITS,
        }),
      ),
    );
    const [first, second] = reads.map((result) => (result.ok ? result.preview : null));
    expect(second?.manifest).toMatchObject({ manifestSchema: "ductus-import-manifest-v1" });
    expect(second?.manifest).not.toHaveProperty("traces");
    // Node ids are fresh per read, so the text is compared, not the hash.
    const text = (preview: typeof first) =>
      JSON.stringify(
        preview?.content.nodes.map((node) => ("children" in node ? node.children : [])),
      );
    expect(text(second)).toBe(text(first));
  }, 20_000);

  it("ignores annotation entries that are not dictionaries", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    page.node.set(
      PDFName.of("Annots"),
      document.context.obj([PDFName.of("Text"), 7, annotation(document, "Text")]),
    );
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toMatchObject({
      ok: true,
      traces: [{ traceKind: "comment", count: 1 }],
    });
  });

  it("refuses a truncated PDF with annotations", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    page.node.addAnnot(document.context.register(annotation(document, "Text")));
    const bytes = await document.save();
    expect(await readPdf(bytes.slice(0, bytes.length / 2), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "PDF_INVALID",
    });
  });

  it("refuses more annotations than a page or the document may hold", async () => {
    const onePage = await pdf("Izmisljeni rad");
    const many = Array.from({ length: 501 }, () => annotation(onePage.document, "Highlight"));
    onePage.page.node.set(PDFName.of("Annots"), onePage.document.context.obj(many));
    expect(await readPdf(await onePage.document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "CONTENT_TOO_LARGE",
    });

    const pages = await pdf("Izmisljeni rad");
    for (let index = 0; index < 11; index += 1) {
      const page = index === 0 ? pages.page : pages.document.addPage();
      const annots = Array.from({ length: 500 }, () => annotation(pages.document, "Text"));
      page.node.set(PDFName.of("Annots"), pages.document.context.obj(annots));
    }
    expect(await readPdf(await pages.document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "CONTENT_TOO_LARGE",
    });
  }, 20_000);

  it("refuses a page tree deeper than the limit", async () => {
    const { document, page } = await pdf("Izmisljeni rad");
    let child = page.ref;
    for (let depth = 0; depth < 33; depth += 1) {
      child = document.context.register(
        dictionary(document, [
          ["Type", PDFName.of("Pages")],
          ["Kids", document.context.obj([child])],
          ["Count", document.context.obj(1)],
        ]),
      );
    }
    document.catalog.set(PDFName.of("Pages"), child);
    expect(await readPdf(await document.save(), IMPORT_READ_LIMITS)).toEqual({
      ok: false,
      code: "PDF_INVALID",
    });
  });
});
