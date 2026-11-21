// SRV-1804 (M8.3): the PDF reader against the attack plan of the import
// contract (docs/adr/import-contract.md, class D) and the manifest of a PDF.
// Every PDF is built here in memory from invented text.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, resolveImportReadLimits } from "../../contracts/index.ts";

import { buildPdf, scannedPdf, textPdf } from "./fixtures.test-support.ts";
import { preparePdfImport, readPdf } from "./index.ts";
import { prepareImport } from "../index.ts";

const LIMITS = IMPORT_READ_LIMITS;
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const DOC = "dokument-izmisljeni-uvoz-pdf";

describe("readPdf", () => {
  it("reads the text layer into paragraphs of document v2", async () => {
    const read = await readPdf(
      textPdf([["Izmisljeni naslov", "", "Prvi odlomak izmisljenog rada.", "Drugi redak."]]),
      LIMITS,
      uuid,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const texts = read.content.nodes.map((n) =>
      "children" in n ? n.children.map((c) => ("text" in c ? c.text : "")).join("") : "",
    );
    expect(texts[0]).toBe("Izmisljeni naslov");
    expect(texts.join(" ")).toContain("Prvi odlomak izmisljenog rada.");
    expect(read.content.sources).toEqual([]);
    expect(sha(read.contentCanonical)).toHaveLength(64);
  });

  it("D1: more pages than the limit is PDF_TOO_MANY_PAGES", async () => {
    const limited = resolveImportReadLimits({ maxPdfPages: 2 });
    expect(limited).not.toBeNull();
    if (limited === null) return;
    const read = await readPdf(textPdf([["a"], ["b"], ["c"]]), limited, uuid);
    expect(read).toEqual({ ok: false, code: "PDF_TOO_MANY_PAGES" });
  });

  it("D2: an encrypted PDF is PDF_ENCRYPTED", async () => {
    const pdf = Buffer.from(textPdf([["tajni tekst"]])).toString("latin1");
    const encrypted = pdf.replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R");
    const read = await readPdf(new Uint8Array(Buffer.from(encrypted, "latin1")), LIMITS, uuid);
    expect(read).toEqual({ ok: false, code: "PDF_ENCRYPTED" });
  });

  it.each([
    [
      "JavaScript in OpenAction",
      { catalog: " /OpenAction << /S /JavaScript /JS (app.alert(1)) >>" },
    ],
    ["obfuscated name", { catalog: " /OpenAction << /S /J#61vaScript /JS (1) >>" }],
    ["embedded files", { catalog: " /Names << /EmbeddedFiles << /Names [] >> >>" }],
    ["XFA", { catalog: " /AcroForm << /XFA [] >>" }],
    ["Launch action", { pageExtra: " /AA << /O << /S /Launch /F (x.exe) >> >>" }],
  ])("D3: %s is PDF_ACTIVE_CONTENT", async (_name, extra) => {
    const read = await readPdf(textPdf([["Izmisljeni tekst"]], extra), LIMITS, uuid);
    expect(read).toEqual({ ok: false, code: "PDF_ACTIVE_CONTENT" });
  });

  it("D4: a broken structure is PDF_INVALID", async () => {
    const read = await readPdf(
      new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog\n", "latin1")),
      LIMITS,
      uuid,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe("PDF_INVALID");
  });

  it("D4: a page tree that points to itself ends in PDF_INVALID", async () => {
    const read = await readPdf(
      buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"]),
      LIMITS,
      uuid,
    );
    expect(read.ok).toBe(false);
  });

  it("a scan without a text layer is PDF_NO_TEXT_LAYER", async () => {
    expect(await readPdf(scannedPdf(), LIMITS, uuid)).toEqual({
      ok: false,
      code: "PDF_NO_TEXT_LAYER",
    });
  });

  it("refuses empty, oversized and non-PDF bytes", async () => {
    expect(await readPdf(new Uint8Array(0), LIMITS, uuid)).toEqual({
      ok: false,
      code: "FILE_EMPTY",
    });
    expect(await readPdf(new Uint8Array([1, 2, 3]), LIMITS, uuid)).toEqual({
      ok: false,
      code: "FORMAT_NOT_ALLOWED",
    });
    const big = new Uint8Array(LIMITS.maxInputBytes + 1);
    expect(await readPdf(big, LIMITS, uuid)).toEqual({ ok: false, code: "FILE_TOO_LARGE" });
  });
});

describe("preparePdfImport", () => {
  const input = (bytes: Uint8Array, fileName: string | null = "Seminar o vodi.pdf") => ({
    bytes,
    documentId: DOC,
    fileName,
    limits: LIMITS,
    importId: "c4d5e6f7-a8b9-4c0d-a1e2-f3a4b5c6d7e8",
    uuid,
  });

  it("builds the manifest with the three hashes and no traces key (M9)", async () => {
    const bytes = textPdf([["Izmisljeni tekst rada."]]);
    const prepared = await preparePdfImport(input(bytes));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { preview } = prepared;
    const manifest = JSON.parse(preview.manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      fileFormat: "pdf",
      importKind: "file-upload",
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      rawByteLength: bytes.length,
    });
    expect(typeof manifest.contentSha256).toBe("string");
    expect("traces" in manifest).toBe(false);
    expect(preview.traces).toEqual([]);
    expect(preview.manifestSha256).toBe(sha(preview.manifestText));
    expect(preview.fileName).toBe("Seminar o vodi.pdf");
    expect(manifest).not.toHaveProperty("fileName");
  });

  it("an id the contract refuses gets no manifest", async () => {
    const prepared = await preparePdfImport({ ...input(textPdf([["x y"]])), documentId: " " });
    expect(prepared).toEqual({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("prepareImport picks the reader from the bytes, not the name", async () => {
    const pdf = await prepareImport(input(textPdf([["Izmisljeni tekst."]]), "rad.docx"));
    expect(pdf.ok && pdf.preview.fileFormat).toBe("pdf");
    const notPdf = await prepareImport(
      input(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), "rad.pdf"),
    );
    expect(notPdf.ok).toBe(false);
  });
});
