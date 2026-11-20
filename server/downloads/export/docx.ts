// DOCX writer for an export model: cover page, then the blocks of the work.
import type { ExportBlock, ExportModel, ExportRun } from "./model.ts";
import { writeZip } from "./zip.ts";

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
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Characters outside XML 1.0's allowed set are printed as U+FFFD, never dropped silently. */
function xmlSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const ok =
      c === 9 ||
      c === 10 ||
      c === 13 ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      c >= 0x10000;
    out += ok ? ch : "\uFFFD";
  }
  return out;
}

export function xmlEscape(text: string): string {
  return xmlSafe(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

type Links = string[];

function run(r: ExportRun, extra = ""): string {
  const props =
    (r.bold ? "<w:b/>" : "") +
    (r.italic ? "<w:i/>" : "") +
    (r.superscript ? '<w:vertAlign w:val="superscript"/>' : "") +
    (r.subscript ? '<w:vertAlign w:val="subscript"/>' : "") +
    (r.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${r.highlight.slice(1)}"/>` : "") +
    (r.language ? `<w:lang w:val="${xmlEscape(r.language)}"/>` : "") +
    extra;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
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
  }
}

function coverXml(cover: ExportCover, title: string): string {
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
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  );
}

export function renderDocx(
  model: ExportModel,
  cover: ExportCover,
  page: PageSetup = A4_PAGE,
): Uint8Array {
  const links: Links = [];
  const body = coverXml(cover, model.title) + model.blocks.map((b) => block(b, links)).join("");
  const sect = `<w:sectPr><w:pgSz w:w="${page.widthTwips}" w:h="${page.heightTwips}"/><w:pgMar w:top="${page.marginTwips}" w:right="${page.marginTwips}" w:bottom="${page.marginTwips}" w:left="${page.marginTwips}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const styles = (id: string, name: string, props: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${props}</w:style>`;
  const stylesXml = `${head}<w:styles ${NS}>${styles("Title", "Title", '<w:rPr><w:b/><w:sz w:val="40"/></w:rPr>')}${[1, 2, 3].map((n) => styles(`Heading${n}`, `heading ${n}`, `<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - n * 4}"/></w:rPr>`)).join("")}${styles("Caption", "caption", '<w:rPr><w:i/><w:sz w:val="20"/></w:rPr>')}</w:styles>`;
  const docRels = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>${links.map((href, i) => `<Relationship Id="rIdL${i + 1}" Type="${REL}/hyperlink" Target="${xmlEscape(href)}" TargetMode="External"/>`).join("")}</Relationships>`;
  const enc = new TextEncoder();
  return writeZip(
    [
      [
        "[Content_Types].xml",
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ],
      ["word/_rels/document.xml.rels", docRels],
      ["word/styles.xml", stylesXml],
      [
        "word/document.xml",
        `${head}<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`,
      ],
    ].map(([name, xml]) => ({ name: name!, data: enc.encode(xml) })),
  );
}
