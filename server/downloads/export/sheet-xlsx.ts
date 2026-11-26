// The .xlsx of one stored version of a spreadsheet work (SRV-V14-SHEET-XLSX, val 14
// decision 6): the stored text is read as a SheetDocument, every formula is
// computed again by the server (decision 4: a stored result is never the truth) and
// the workbook is written as OOXML inside the deterministic ZIP of the DOCX
// export. The same document gives the same bytes. No library, no clock, no
// macros: only the parts a reader needs (content types, relationships, workbook,
// styles, shared strings and one worksheet per sheet).
// The caller (server/http/export/sheet-xlsx) has already checked access and read the text.
import {
  columnLabel,
  computeSheet,
  parseCellRef,
  parseFormula,
  sheetDigest,
  validateSheetDocument,
  type ComputedCell,
  type FormulaNode,
  type Sheet,
  type SheetDocument,
} from "../../domain/index.ts";
import { writeZip, type ZipEntry } from "./zip.ts";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SheetXlsxInput = {
  /** The exact stored bytes of the text of the revision. */
  readonly body: string;
};

export type SheetXlsx =
  | { readonly status: "rendered"; readonly bytes: Uint8Array; readonly sheetSha256: string }
  /** The stored text is not a spreadsheet: a text work, or another kind, has no .xlsx (404). */
  | { readonly status: "not_spreadsheet" }
  /** A spreadsheet the export cannot read; the reason is a closed code for the server's own record. */
  | { readonly status: "unreadable"; readonly reason: "body_not_json" | "body_invalid" };

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A character XML 1.0 cannot carry (control characters other than tab, new line and CR, lone surrogates, U+FFFE/U+FFFF). */
const NOT_XML =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/** Text safe inside an XML element or attribute: markup characters escaped, an unwritable character is U+FFFD. */
export function escapeXml(text: string): string {
  return text
    .replace(NOT_XML, "�")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * Text of a cell, a computed text or a sheet name as ST_Xstring reads it: a literal
 * `_xHHHH_` would be read back as the character U+HHHH, so its underscore is escaped
 * (`_x005F_`) before the markup is.
 */
export function xstring(text: string): string {
  return escapeXml(text.replace(/_(?=[xX][0-9A-Fa-f]{4}_)/gu, "_x005F_"));
}

/** Whether the formula uses only what the server computes: no unknown name or function, no reference outside the grid. */
function isSupportedFormula(node: FormulaNode): boolean {
  switch (node.type) {
    case "bad-name":
    case "bad-ref":
      return false;
    case "unary":
      return isSupportedFormula(node.operand);
    case "binary":
      return isSupportedFormula(node.left) && isSupportedFormula(node.right);
    case "call":
      return node.args.every(isSupportedFormula);
    default:
      return true;
  }
}

/**
 * The formula as the file writes it: without the leading "=", and with function and
 * reference names in capitals outside text literals ("..." with "" for a quote), so
 * a reader that is strict about case reads what the server computed.
 */
export function formulaForFile(formula: string): string {
  let out = "";
  let inText = false;
  for (const char of formula.slice(1)) {
    if (char === '"') inText = !inText;
    out += inText || char === '"' ? char : char.toUpperCase();
  }
  return out;
}

/** The shortest decimal text that reads back as the same double; `-0` is `0`. */
function numberText(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

class SharedStrings {
  private readonly index = new Map<string, number>();
  private readonly list: string[] = [];
  references = 0;

  add(text: string): number {
    this.references += 1;
    const known = this.index.get(text);
    if (known !== undefined) return known;
    const at = this.list.length;
    this.index.set(text, at);
    this.list.push(text);
    return at;
  }

  xml(): string {
    const items = this.list
      .map((text) => `<si><t xml:space="preserve">${xstring(text)}</t></si>`)
      .join("");
    return `${XML_DECLARATION}<sst xmlns="${MAIN_NS}" count="${this.references}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

/**
 * The error values OOXML knows. The server's own #CIRC! (a cycle) is not one of them, and
 * a reader may call a file with it damaged, so it is written as #REF!, the nearest known error.
 */
function fileErrorCode(code: string | undefined): string {
  if (code === undefined) return "#VALUE!";
  return code === "#CIRC!" ? "#REF!" : code;
}

function formulaResultCell(ref: string, formula: string, result: ComputedCell | undefined): string {
  // A formula the server does not compute (an unknown function such as WEBSERVICE, a
  // reference outside the grid, bad syntax) is never written as a formula: a reader
  // that calculates would run what the server refused. Only its error value is written.
  const parsed = parseFormula(formula);
  const f =
    parsed.ok && isSupportedFormula(parsed.node)
      ? `<f>${escapeXml(formulaForFile(formula))}</f>`
      : "";
  if (result === undefined || result.type === "error") {
    return `<c r="${ref}" t="e">${f}<v>${escapeXml(fileErrorCode(result?.code))}</v></c>`;
  }
  if (result.type === "text") {
    return `<c r="${ref}" t="str">${f}<v>${xstring(result.value)}</v></c>`;
  }
  return `<c r="${ref}">${f}<v>${numberText(result.value)}</v></c>`;
}

function worksheetXml(sheet: Sheet, strings: SharedStrings): string {
  const computed = computeSheet(sheet);
  const cells: { column: number; row: number; ref: string }[] = [];
  for (const ref of Object.keys(sheet.cells)) {
    const at = parseCellRef(ref);
    if (at !== null) cells.push({ column: at.column, row: at.row, ref });
  }
  cells.sort((a, b) => a.row - b.row || a.column - b.column);
  let rows = "";
  let open = 0;
  let maxColumn = 1;
  let maxRow = 1;
  for (const { column, row, ref } of cells) {
    const cell = sheet.cells[ref];
    if (cell === undefined) continue;
    if (row !== open) {
      if (open !== 0) rows += "</row>";
      rows += `<row r="${row}">`;
      open = row;
    }
    maxColumn = Math.max(maxColumn, column);
    maxRow = Math.max(maxRow, row);
    if (cell.formula !== undefined) {
      rows += formulaResultCell(ref, cell.formula, computed[ref]);
    } else if (typeof cell.value === "number") {
      rows += `<c r="${ref}"><v>${numberText(cell.value)}</v></c>`;
    } else {
      rows += `<c r="${ref}" t="s"><v>${strings.add(cell.value)}</v></c>`;
    }
  }
  if (open !== 0) rows += "</row>";
  const last = `${columnLabel(maxColumn) ?? "A"}${maxRow}`;
  const dimension = last === "A1" ? "A1" : `A1:${last}`;
  const data = rows === "" ? "<sheetData/>" : `<sheetData>${rows}</sheetData>`;
  return `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${data}</worksheet>`;
}

const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const ROOT_RELS_XML = `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function contentTypesXml(sheets: number): string {
  const sheetOverrides = Array.from(
    { length: sheets },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
}

function workbookXml(doc: SheetDocument): string {
  const sheets = doc.sheets
    .map(
      (sheet, i) => `<sheet name="${xstring(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("");
  return `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>${sheets}</sheets></workbook>`;
}

function workbookRelsXml(sheets: number): string {
  const sheetRels = Array.from(
    { length: sheets },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_BASE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">${sheetRels}<Relationship Id="rId${sheets + 1}" Type="${REL_BASE}/styles" Target="styles.xml"/><Relationship Id="rId${sheets + 2}" Type="${REL_BASE}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
}

/** The workbook of a valid spreadsheet document: every sheet, formulas with their computed values. */
export function sheetXlsxBytes(doc: SheetDocument): Uint8Array {
  const encoder = new TextEncoder();
  const strings = new SharedStrings();
  // Worksheets first: they fill the shared strings the workbook then lists.
  const worksheets = doc.sheets.map((sheet) => worksheetXml(sheet, strings));
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", xml: contentTypesXml(doc.sheets.length) },
    { name: "_rels/.rels", xml: ROOT_RELS_XML },
    { name: "xl/workbook.xml", xml: workbookXml(doc) },
    { name: "xl/_rels/workbook.xml.rels", xml: workbookRelsXml(doc.sheets.length) },
    ...worksheets.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml })),
    { name: "xl/styles.xml", xml: STYLES_XML },
    { name: "xl/sharedStrings.xml", xml: strings.xml() },
  ].map(({ name, xml }) => ({ name, data: encoder.encode(xml) }));
  return writeZip(entries);
}

/** The .xlsx of one stored version; a body that is no valid spreadsheet document is refused with a closed reason. */
export function renderSheetXlsx(input: SheetXlsxInput): SheetXlsx {
  let stored: unknown;
  try {
    stored = JSON.parse(input.body);
  } catch {
    return { status: "unreadable", reason: "body_not_json" };
  }
  const checked = validateSheetDocument(stored);
  if (!checked.ok) {
    // A text work (or a slide deck) is valid JSON of another kind: not a spreadsheet, so no export.
    const kind =
      typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? (stored as { kind?: unknown }).kind
        : undefined;
    return kind === "spreadsheet"
      ? { status: "unreadable", reason: "body_invalid" }
      : { status: "not_spreadsheet" };
  }
  return {
    status: "rendered",
    bytes: sheetXlsxBytes(checked.doc),
    sheetSha256: sheetDigest(checked.doc),
  };
}
