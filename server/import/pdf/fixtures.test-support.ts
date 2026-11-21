// Invented PDFs built in memory for the PDF import tests (SRV-1804). No binary
// file and no real document is used; every text here is made up.

/** A classic-xref PDF from object bodies; object 1 is the catalog, 2 the pages. */
export function buildPdf(objects: readonly string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const stream = (content: string) =>
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

const escapePdf = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** Pages of lines: each inner array is one page, each string one line of text. */
export function textPdf(
  pages: readonly (readonly string[])[],
  extra: { catalog?: string; pageExtra?: string } = {},
): Uint8Array {
  const pageCount = pages.length;
  const first = 4;
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${extra.catalog ?? ""} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines
      .map((line) => (line === "" ? "T*" : `(${escapePdf(line)}) Tj T*`))
      .join(" ")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + i * 2 + 1} 0 R${extra.pageExtra ?? ""} >>`,
      stream(content),
    );
  });
  return buildPdf(objects);
}

/** A scan: a page with an image and no text at all. */
export function scannedPdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    stream("q 612 0 0 792 0 0 cm Q"),
  ]);
}
