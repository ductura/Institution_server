// Minimal WordprocessingML writer for the spike. M8.4-P02 will write the real
// export with the `docx` library (D-254); the spike only needs a realistic DOCX
// (styles, headings, footnotes, a table, a page-number footer, Croatian
// language) without adding a dependency.
import { crc32, deflateRawSync } from "node:zlib";

import type { Corpus } from "./corpus.ts";

/** The only font the document asks for: Liberation Serif 2.x, SIL OFL 1.1. */
export const DOCUMENT_FONT = "Liberation Serif";

const FOOTNOTE_EVERY = 5;

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function paragraph(text: string, style?: string, extra = ""): string {
  const pPr = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>${extra}</w:p>`;
}

function footnoteReference(id: number): string {
  return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
}

function table(): string {
  const rows = [
    ["Četvrt", "Kućanstva", "Udio biootpada"],
    ["Zelena četvrt", "18", "41 %"],
    ["Šumski jaglaci", "12", "35 %"],
    ["Čađavi dimnjaci", "10", "29 %"],
  ];
  const cell = (text: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`;
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
    rows.map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`).join("") +
    `</w:tbl>` +
    paragraph("Tablica 1. Izmišljeni udio biootpada po četvrtima.", "Caption")
  );
}

type Parts = { body: string; footnotes: string[] };

function documentBody(corpus: Corpus): Parts {
  const out: string[] = [paragraph(corpus.title, "Title"), paragraph(corpus.author, "Subtitle")];
  const footnotes: string[] = [];
  let paragraphIndex = 0;
  corpus.sections.forEach((section, sectionIndex) => {
    out.push(paragraph(section.heading, "Heading1"));
    for (const sub of section.subsections) {
      out.push(paragraph(sub.heading, "Heading2"));
      for (const text of sub.paragraphs) {
        paragraphIndex += 1;
        if (paragraphIndex % FOOTNOTE_EVERY === 0) {
          const id = footnotes.length + 1;
          footnotes.push(
            `Izmišljeni izvor br. ${id}, Lipovac: Naklada Đurđica, 2026., str. ${id + 10}.`,
          );
          out.push(paragraph(text, undefined, footnoteReference(id)));
        } else {
          out.push(paragraph(text));
        }
      }
    }
    if (sectionIndex === 0) {
      out.push(
        paragraph("„Kompost nije otpad, nego sporo pismo vrtu.” (izmišljeni citat)", "Quote"),
      );
      out.push(table());
    }
  });
  const sectPr =
    `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  return { body: out.join("") + sectPr, footnotes };
}

function styles(): string {
  const font = `<w:rFonts w:ascii="${DOCUMENT_FONT}" w:hAnsi="${DOCUMENT_FONT}" w:eastAsia="${DOCUMENT_FONT}" w:cs="${DOCUMENT_FONT}"/>`;
  const style = (id: string, name: string, pPr: string, rPr: string, type = "paragraph") =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="24"/><w:szCs w:val="24"/>` +
    `<w:lang w:val="hr-HR" w:eastAsia="hr-HR" w:bidi="hr-HR"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    style(
      "Title",
      "Title",
      '<w:jc w:val="center"/><w:spacing w:after="240"/>',
      '<w:b/><w:sz w:val="36"/>',
    ) +
    style("Subtitle", "Subtitle", '<w:jc w:val="center"/><w:spacing w:after="480"/>', "<w:i/>") +
    style(
      "Heading1",
      "heading 1",
      '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/>',
      '<w:b/><w:sz w:val="32"/>',
    ) +
    style(
      "Heading2",
      "heading 2",
      '<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/>',
      '<w:b/><w:sz w:val="28"/>',
    ) +
    style("Quote", "Quote", '<w:ind w:left="720" w:right="720"/>', "<w:i/>") +
    style("Caption", "caption", '<w:jc w:val="center"/>', '<w:i/><w:sz w:val="20"/>') +
    style(
      "FootnoteText",
      "footnote text",
      '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>',
      '<w:sz w:val="20"/>',
    ) +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

function footnotesPart(footnotes: string[]): string {
  const separator =
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
  const notes = footnotes
    .map(
      (text, index) =>
        `<w:footnote w:id="${index + 1}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
        `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>` +
        `<w:r><w:t xml:space="preserve"> ${xml(text)}</w:t></w:r></w:p></w:footnote>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>${separator}${notes}</w:footnotes>`;
}

const FOOTER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` +
  `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;
const DOCUMENT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>` +
  `<Relationship Id="rIdFooter" Type="${REL}/footer" Target="footer1.xml"/>` +
  `</Relationships>`;

function coreProps(corpus: Corpus): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xml(corpus.title)}</dc:title><dc:creator>${xml(corpus.author)}</dc:creator>` +
    `<dc:language>hr-HR</dc:language>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">2026-11-21T00:00:00Z</dcterms:created>` +
    `</cp:coreProperties>`
  );
}

export type ZipEntry = { name: string; data: Buffer };

/** Deflated ZIP with a fixed timestamp, so equal input gives equal bytes. */
export function zip(entries: ZipEntry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 21;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export type BuiltDocx = { bytes: Buffer; footnotes: number };

export function buildDocx(corpus: Corpus): BuiltDocx {
  const { body, footnotes } = documentBody(corpus);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`;
  const parts: [string, string][] = [
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["docProps/core.xml", coreProps(corpus)],
    ["word/_rels/document.xml.rels", DOCUMENT_RELS],
    ["word/document.xml", document],
    ["word/styles.xml", styles()],
    ["word/footnotes.xml", footnotesPart(footnotes)],
    ["word/footer1.xml", FOOTER],
  ];
  const bytes = zip(parts.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
  return { bytes, footnotes: footnotes.length };
}
