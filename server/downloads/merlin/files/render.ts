// The two files of one submitted work in the Merlin package (SRV-1109, Val 11,
// N-18, C-16): the DOCX of the export (server/downloads/export) and a PDF with
// the same blocks, both from the document of the submitted revision. The
// same document, names and labels give the same bytes, so the fingerprint a
// roster names is the fingerprint of the file the package carries.
import fontkit from "@cantoo/fontkit";
import { PageSizes, PDFDocument, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";

import type { CanonicalDocumentV4, VersionedDocument } from "../../../domain/index.ts";
import {
  buildExportModel,
  renderDocx,
  type ExportBlock,
  type ExportLabels,
  type ExportModel,
} from "../../export/index.ts";
import { RECEIPT_FONT_BASE64 } from "../../receipt-pdf/index.ts";

export type WorkFiles = { readonly pdf: Uint8Array; readonly docx: Uint8Array };

export type WorkFilesInput = {
  readonly document: VersionedDocument;
  /** "Ime Prezime" for the cover; "" when the account has no name pair. */
  readonly student: string;
  readonly labels: ExportLabels;
};

const FONT_BYTES = Buffer.from(RECEIPT_FONT_BASE64, "base64");
const MARGIN = 56;
const INK = rgb(0.12, 0.12, 0.12);
const BODY_SIZE = 11;
const LINE = 15;
const HEADING_SIZE = [18, 15, 13] as const;

/**
 * The export model of any accepted document version. A v1 to v3 document has
 * only the blocks and inline text of v4 (heading, paragraph, bullet, quote,
 * text), which buildExportModel reads the same way; citations, footnotes and
 * cross references print no characters, as in the v4 export (open item there).
 */
export function exportModelOf(document: VersionedDocument, labels: ExportLabels): ExportModel {
  return buildExportModel(document as CanonicalDocumentV4, labels);
}

function blockText(block: ExportBlock): { size: number; lines: string[]; indent: number } {
  const runs = (r: readonly { text: string }[]) => r.map((x) => x.text).join("");
  switch (block.kind) {
    case "heading":
      return {
        size: HEADING_SIZE[block.level - 1] ?? BODY_SIZE,
        lines: [`${block.number} ${runs(block.runs)}`],
        indent: 0,
      };
    case "paragraph":
      return { size: BODY_SIZE, lines: [runs(block.runs)], indent: 0 };
    case "bullet":
      return { size: BODY_SIZE, lines: [`• ${runs(block.runs)}`], indent: 12 };
    case "ordered":
      return { size: BODY_SIZE, lines: [`${block.number}. ${runs(block.runs)}`], indent: 12 };
    case "quote":
      return { size: BODY_SIZE, lines: [runs(block.runs)], indent: 24 };
    case "code":
      return { size: BODY_SIZE - 1, lines: [...block.lines, block.caption], indent: 12 };
    case "box":
      return { size: BODY_SIZE, lines: [block.label, ...block.paragraphs.map(runs)], indent: 12 };
    case "formula":
      return { size: BODY_SIZE, lines: [`${block.tex} (${block.number})`], indent: 24 };
    case "pageBreak":
      return { size: BODY_SIZE, lines: [], indent: 0 };
  }
}

/** A character the embedded subset has no glyph for prints as "?", never as nothing. */
function printable(font: PDFFont, text: string): string {
  const known = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text.replace(/\s+/gu, " ")) out += known.has(ch.codePointAt(0)!) ? ch : "?";
  return out;
}

/** A word wider than the line is split by code points, so nothing is drawn past the margin. */
function pieces(font: PDFFont, word: string, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= width) return [word];
  const out: string[] = [];
  let piece = "";
  for (const ch of word) {
    if (piece !== "" && font.widthOfTextAtSize(piece + ch, size) > width) {
      out.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  out.push(piece);
  return out;
}

/** The lines of one paragraph, none wider than `width` (a single glyph excepted). */
export function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").flatMap((w) => pieces(font, w, size, width))) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

/** The PDF of the work: a cover line with the student and title, then the blocks. */
export async function renderWorkPdf(model: ExportModel, student: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  if (model.title !== "") pdf.setTitle(model.title);
  const font = await pdf.embedFont(FONT_BYTES, { subset: true });
  const [width, height] = PageSizes.A4;
  let page: PDFPage = pdf.addPage(PageSizes.A4);
  let y = height - MARGIN;
  const newPage = () => {
    page = pdf.addPage(PageSizes.A4);
    y = height - MARGIN;
  };
  const write = (text: string, size: number, indent: number) => {
    for (const line of wrap(font, printable(font, text), size, width - 2 * MARGIN - indent)) {
      if (y - size < MARGIN) newPage();
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color: INK });
      y -= Math.max(LINE, size + 4);
    }
  };
  if (student !== "") write(student, BODY_SIZE, 0);
  if (model.title !== "") write(model.title, HEADING_SIZE[0], 0);
  y -= LINE;
  for (const block of model.blocks) {
    if (block.kind === "pageBreak") {
      newPage();
      continue;
    }
    const { size, lines, indent } = blockText(block);
    for (const line of lines) write(line, size, indent);
    y -= LINE / 2;
  }
  return pdf.save();
}

/** Both files of one submitted work. */
export async function renderWorkFiles(input: WorkFilesInput): Promise<WorkFiles> {
  const model = exportModelOf(input.document, input.labels);
  const docx = renderDocx(model, {
    institution: "",
    unit: "",
    workType: "",
    student: input.student,
    mentor: "",
  });
  return { pdf: await renderWorkPdf(model, input.student), docx };
}
