// DOCX writer for an export model: cover page, then the blocks of the work.
import type { ExportBlock, ExportModel, ExportRun } from "./model.ts";
import { writeZip, type ZipEntry } from "./zip.ts";
import { imageXml, tableXml, type ImagePart } from "./docx-table.ts";
import type { ExportImages } from "./image.ts";
import { xmlEscape } from "./xml.ts";

export { xmlEscape };

/** Facts of the cover page; derived by the caller from the work, task and rules profile (§7). */
export type ExportCover = {
  readonly institution: string;
  readonly unit: string;
  readonly workType: string;
  readonly student: string;
  readonly mentor: string;
  readonly study?: string;
  readonly place?: string;
  readonly date?: string;
};

/** From the faculty rules profile; the document never carries page shape (§7). */
export type PageSetup = {
  readonly widthTwips: number;
  readonly heightTwips: number;
  readonly marginTwips: number;
};
export const A4_PAGE: PageSetup = { widthTwips: 11906, heightTwips: 16838, marginTwips: 1418 };

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type Links = string[];

/** A line feed is a break and a tab a tab stop; a literal one in `w:t` is not rendered (§4.2 allows both). */
function textParts(text: string): string {
  return text
    .split(/(\n|\t)/)
    .map((part) =>
      part === "\n"
        ? "<w:br/>"
        : part === "\t"
          ? "<w:tab/>"
          : part === ""
            ? ""
            : `<w:t xml:space="preserve">${xmlEscape(part)}</w:t>`,
    )
    .join("");
}

function run(r: ExportRun, extra = ""): string {
  const props =
    (r.bold ? "<w:b/>" : "") +
    (r.italic ? "<w:i/>" : "") +
    (r.superscript ? '<w:vertAlign w:val="superscript"/>' : "") +
    (r.subscript ? '<w:vertAlign w:val="subscript"/>' : "") +
    (r.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${r.highlight.slice(1)}"/>` : "") +
    (r.language ? `<w:lang w:val="${xmlEscape(r.language)}"/>` : "") +
    extra;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${textParts(r.text)}</w:r>`;
}

function runs(items: readonly ExportRun[], links: Links): string {
  return items
    .map((r) => {
      if (r.href === undefined) return run(r);
      links.push(r.href);
      return `<w:hyperlink r:id="rIdL${links.length}">${run(r, '<w:u w:val="single"/>')}</w:hyperlink>`;
    })
    .join("");
}

const plain = (text: string, style?: string, jc?: string): string =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${jc ? `<w:jc w:val="${jc}"/>` : ""}</w:pPr>${run({ text, bold: false, italic: false, superscript: false, subscript: false })}</w:p>`;

function block(b: ExportBlock, links: Links): string {
  switch (b.kind) {
    case "heading":
      return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${run({ text: `${b.number} `, bold: false, italic: false, superscript: false, subscript: false })}${runs(b.runs, links)}</w:p>`;
    case "paragraph":
      return `<w:p>${runs(b.runs, links)}</w:p>`;
    case "bullet":
      return `<w:p><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>${run({ text: "• ", bold: false, italic: false, superscript: false, subscript: false })}${runs(b.runs, links)}</w:p>`;
    case "ordered":
      return `<w:p><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>${run({ text: `${b.number}. `, bold: false, italic: false, superscript: false, subscript: false })}${runs(b.runs, links)}</w:p>`;
    case "quote":
      return `<w:p><w:pPr><w:ind w:left="709" w:right="709"/></w:pPr>${runs(b.runs, links)}</w:p>`;
    case "code":
      return (
        b.lines
          .map(
            (line) =>
              `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="f2f2f2"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`,
          )
          .join("") + plain(b.caption, "Caption")
      );
    case "box":
      return (
        `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="808080"/></w:pBdr></w:pPr>${run({ text: b.label, bold: true, italic: false, superscript: false, subscript: false })}</w:p>` +
        b.paragraphs.map((p) => `<w:p>${runs(p, links)}</w:p>`).join("")
      );
    case "formula":
      return plain(`${b.tex}\t(${b.number})`, undefined, "center");
    case "pageBreak":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case "table":
    case "image":
      // Written by renderDocx, which knows the text width and the attachments.
      return "";
  }
}

function coverXml(cover: ExportCover, title: string, endsWithSection: boolean): string {
  const lines = [
    cover.institution,
    cover.unit,
    cover.study ?? "",
    "",
    title,
    cover.workType,
    "",
    cover.student,
    cover.mentor,
    "",
    [cover.place, cover.date].filter(Boolean).join(", "),
  ];
  return (
    lines.map((l, i) => plain(l, i === 4 ? "Title" : undefined, "center")).join("") +
    // A landscape first block starts with a section break, which already starts a page.
    (endsWithSection ? "" : '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
  );
}

const sectionOf = (page: PageSetup, landscape: boolean): string => {
  const [w, h] = landscape
    ? [page.heightTwips, page.widthTwips]
    : [page.widthTwips, page.heightTwips];
  const m = page.marginTwips;
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"${landscape ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
};

const isLandscape = (b: ExportBlock): boolean =>
  (b.kind === "table" || b.kind === "image") && b.landscape;

/**
 * `images` holds the stored bytes of the attachments of this work. An image is printed only
 * when its bytes match the hash in the document; otherwise its place says it is unavailable.
 */
export function renderDocx(
  model: ExportModel,
  cover: ExportCover,
  page: PageSetup = A4_PAGE,
  images?: ExportImages,
): Uint8Array {
  const links: Links = [];
  const parts: ImagePart[] = [];
  // A landscape table or image stands in its own section: the properties of a section sit in
  // the last paragraph of that section, so each change of orientation closes the section before.
  let landscape = false;
  const body: string[] = [];
  for (const b of model.blocks) {
    if (isLandscape(b) !== landscape) {
      body.push(`<w:p><w:pPr>${sectionOf(page, landscape)}</w:pPr></w:p>`);
      landscape = !landscape;
    }
    const width = (landscape ? page.heightTwips : page.widthTwips) - 2 * page.marginTwips;
    body.push(
      b.kind === "table"
        ? tableXml(b, width)
        : b.kind === "image"
          ? imageXml(b, images, width, parts)
          : block(b, links),
    );
  }
  const first = model.blocks[0];
  const cover0 = coverXml(cover, model.title, first !== undefined && isLandscape(first));
  const sect = sectionOf(page, landscape);
  const mainBody = cover0 + body.join("");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const styles = (id: string, name: string, props: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${props}</w:style>`;
  const stylesXml = `${head}<w:styles ${NS}>${styles("Title", "Title", '<w:rPr><w:b/><w:sz w:val="40"/></w:rPr>')}${[1, 2, 3].map((n) => styles(`Heading${n}`, `heading ${n}`, `<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - n * 4}"/></w:rPr>`)).join("")}${styles("Caption", "caption", '<w:rPr><w:i/><w:sz w:val="20"/></w:rPr>')}</w:styles>`;
  const docRels = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>${links.map((href, i) => `<Relationship Id="rIdL${i + 1}" Type="${REL}/hyperlink" Target="${xmlEscape(href)}" TargetMode="External"/>`).join("")}${parts.map((p, i) => `<Relationship Id="rIdI${i + 1}" Type="${REL}/image" Target="media/${p.name}"/>`).join("")}</Relationships>`;
  const mediaTypes =
    (parts.some((p) => p.type === "png")
      ? '<Default Extension="png" ContentType="image/png"/>'
      : "") +
    (parts.some((p) => p.type === "jpeg")
      ? '<Default Extension="jpg" ContentType="image/jpeg"/>'
      : "");
  const enc = new TextEncoder();
  return writeZip(
    [
      [
        "[Content_Types].xml",
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaTypes}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ],
      ["word/_rels/document.xml.rels", docRels],
      ["word/styles.xml", stylesXml],
      [
        "word/document.xml",
        `${head}<w:document ${NS}><w:body>${mainBody}${sect}</w:body></w:document>`,
      ],
    ]
      .map(([name, xml]): ZipEntry => ({ name: name!, data: enc.encode(xml) }))
      .concat(parts.map((p): ZipEntry => ({ name: `word/media/${p.name}`, data: p.bytes }))),
  );
}
