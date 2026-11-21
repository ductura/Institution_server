import { createRequire } from "node:module";
import pdfDocument from "pdfkit";
import { PAGES, type CorpusPage } from "./corpus.ts";

const require = createRequire(import.meta.url);
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSerif.ttf");
const FONT_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf");

// A4 in points; one corpus line per text run so the text layer has a predictable reading order.
export function buildPdf(pages: readonly CorpusPage[] = PAGES): Promise<Uint8Array> {
  const doc = new pdfDocument({
    size: "A4",
    margin: 56,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Uint8Array>((resolve) =>
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))),
  );
  pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    page.lines.forEach((line, lineIndex) => {
      doc
        .font(lineIndex === 0 ? FONT_BOLD : FONT)
        .fontSize(lineIndex === 0 ? 15 : 11)
        .text(line, { lineGap: 7, width: 483 });
    });
  });
  doc.end();
  return done;
}
