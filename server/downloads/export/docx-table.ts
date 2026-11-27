// DOCX table and image blocks (contract v4 §5). Pure string builders: the caller
// (docx.ts) owns the package, so relationships and media are handed back, not written.
import type { ExportBlock } from "./model.ts";
import { verifyImage, type ExportImages, type VerifiedImage } from "./image.ts";
import { xmlEscape } from "./xml.ts";

type TableBlock = Extract<ExportBlock, { kind: "table" }>;
type ImageBlock = Extract<ExportBlock, { kind: "image" }>;

const STRIPE_FILL = "#f2f2f2";
const EMU_PER_TWIP = 635;

const cellPara = (text: string, bold: boolean): string =>
  `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

export const captionPara = (text: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="Caption"/><w:keepNext/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

const sourcePara = (text: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

/** Table: caption above, grid of equal columns, merged areas, fills and stripes, source below. */
export function tableXml(b: TableBlock, textWidthTwips: number): string {
  const columns = b.rows[0]?.length ?? 1;
  const tops = new Map(b.merges.map((m) => [`${m.row},${m.column}`, m]));
  const covered = (r: number, c: number) =>
    b.merges.find(
      (m) => r >= m.row && r < m.row + m.rowSpan && c >= m.column && c < m.column + m.columnSpan,
    );
  const fills = new Map(b.cellFills.map((f) => [`${f.row},${f.column}`, f.color]));
  const rows = b.rows
    .map((row, r) => {
      const isHeader = b.header && r === 0;
      const bodyIndex = r - (b.header ? 1 : 0);
      const cells: string[] = [];
      for (let c = 0; c < columns; c += 1) {
        const merge = covered(r, c);
        // Only the left cell of a merged area is written; later rows continue it (vMerge).
        if (merge !== undefined && c !== merge.column) continue;
        const fill =
          fills.get(`${r},${c}`) ??
          (isHeader ? b.headerFill : undefined) ??
          (b.stripes && !isHeader && bodyIndex % 2 === 1 ? STRIPE_FILL : undefined);
        const span = merge !== undefined && merge.columnSpan > 1 ? merge.columnSpan : 1;
        const top = tops.get(`${r},${c}`);
        const vMerge =
          merge === undefined || merge.rowSpan === 1
            ? ""
            : top !== undefined
              ? '<w:vMerge w:val="restart"/>'
              : "<w:vMerge/>";
        const props =
          (span > 1 ? `<w:gridSpan w:val="${span}"/>` : "") +
          vMerge +
          (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill.slice(1)}"/>` : "");
        const text = top !== undefined || merge === undefined ? (row[c] ?? "") : "";
        cells.push(`<w:tc><w:tcPr>${props}</w:tcPr>${cellPara(text, isHeader)}</w:tc>`);
      }
      return `<w:tr>${isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.join("")}</w:tr>`;
    })
    .join("");
  const width = Math.floor(textWidthTwips / columns);
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("");
  return (
    captionPara(b.caption) +
    `<w:tbl><w:tblPr><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
    (b.source ? sourcePara(b.source) : "<w:p></w:p>")
  );
}

export type ImagePart = {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type: string;
};

/**
 * Image: caption above, the picture cropped and sized as a share of the text width, source
 * below. A missing or mismatching attachment prints the "unavailable" line instead.
 */
export function imageXml(
  b: ImageBlock,
  images: ExportImages | undefined,
  textWidthTwips: number,
  parts: ImagePart[],
): string {
  const head = captionPara(b.caption);
  const tail = b.source ? sourcePara(b.source) : "";
  const image: VerifiedImage | null = verifyImage(images, b.attachmentId, b.attachmentSha256);
  if (image === null) return head + sourcePara(b.unavailable) + tail;
  const crop = b.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const shownW = image.width * (1 - (crop.left + crop.right) / 100);
  const shownH = image.height * (1 - (crop.top + crop.bottom) / 100);
  const cx = Math.round(((textWidthTwips * b.widthPercent) / 100) * EMU_PER_TWIP);
  const cy = Math.max(1, Math.round((cx * shownH) / shownW));
  const n = parts.length + 1;
  parts.push({
    name: `image${n}.${image.type === "png" ? "png" : "jpg"}`,
    bytes: image.bytes,
    type: image.type,
  });
  const src = `<a:srcRect l="${crop.left * 1000}" t="${crop.top * 1000}" r="${crop.right * 1000}" b="${crop.bottom * 1000}"/>`;
  const jc = b.align === "center" ? "center" : b.align === "right" ? "right" : "left";
  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="Image ${n}" descr="${xmlEscape(b.caption)}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdI${n}"/>${src}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  return `${head}<w:p><w:pPr><w:keepNext/><w:jc w:val="${jc}"/></w:pPr><w:r>${drawing}</w:r></w:p>${tail}`;
}
