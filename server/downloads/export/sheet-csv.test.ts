// The CSV of a sheet (SRV-V14-SHEET-CSV): the bytes, the injection guard, the
// quoting, the numbers and the choice of the sheet. Every value is invented.
import { describe, expect, it } from "vitest";

import type { Sheet, SheetDocument } from "../../domain/index.ts";
import { plainDecimal, renderSheetCsv } from "./index.ts";

type SheetCell = Sheet["cells"][string];
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sheet(id: string, name: string, cells: Record<string, SheetCell>): Sheet {
  return { id, name, rows: 200, columns: 26, cells };
}
function doc(...sheets: Sheet[]): SheetDocument {
  return { schemaVersion: 1, kind: "spreadsheet", sheets };
}
function csv(document: SheetDocument, sheetId: string | null = null): string {
  const result = renderSheetCsv(document, sheetId);
  if (result.status !== "ok") throw new Error("no sheet");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes);
}
const text = (value: string): SheetCell => ({ value });
const num = (value: number): SheetCell => ({ value });
const formula = (value: string): SheetCell => ({ value: null, formula: value });

describe("renderSheetCsv", () => {
  it("writes a byte order mark, semicolons, CRLF and the computed value of every cell", () => {
    const result = renderSheetCsv(
      doc(
        sheet(ID_A, "Demo", {
          ["A1"]: text("Stavka"),
          ["B1"]: text("Iznos"),
          ["A2"]: text("Demo jedan"),
          ["B2"]: num(12.5),
          ["A3"]: text("Demo dva"),
          ["B3"]: num(7.5),
          ["A4"]: text("Ukupno"),
          ["B4"]: formula("=SUM(B2:B3)"),
        }),
      ),
      null,
    );
    if (result.status !== "ok") throw new Error("no sheet");
    expect([...result.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes)).toBe(
      "﻿Stavka;Iznos\r\nDemo jedan;12.5\r\nDemo dva;7.5\r\nUkupno;20\r\n",
    );
  });

  it("gives the same bytes for the same document", () => {
    const document = doc(sheet(ID_A, "Demo", { ["A1"]: num(1), ["B1"]: formula("=A1*2") }));
    expect(csv(document)).toBe(csv(document));
  });

  it("keeps empty cells and rows between filled ones and stops at the last filled cell", () => {
    expect(csv(doc(sheet(ID_A, "Demo", { ["A1"]: text("a"), ["C3"]: text("c") })))).toBe(
      "﻿a;;\r\n;;\r\n;;c\r\n",
    );
  });

  it("writes only the byte order mark for an empty sheet", () => {
    expect(csv(doc(sheet(ID_A, "Demo", {})))).toBe("﻿");
  });

  it("puts an apostrophe before a text a spreadsheet would read as a formula", () => {
    const lines = csv(
      doc(
        sheet(ID_A, "Demo", {
          ["A1"]: text("=cmd|' /C calc'!A0"),
          ["A2"]: text("@SUM(1+1)"),
          ["A3"]: text("+1+1"),
          ["A4"]: text("-2+3"),
          ["A5"]: text("\tkartica"),
          ["A6"]: text("\rpovratnik"),
          ["A7"]: text("sigurno =tekst"),
        }),
      ),
    ).split("\r\n");
    expect(lines[0]).toBe("﻿'=cmd|' /C calc'!A0");
    expect(lines.slice(1, 4)).toEqual(["'@SUM(1+1)", "'+1+1", "'-2+3"]);
    expect(lines[4]).toBe("'\tkartica");
    // A carriage return inside a cell makes it quoted as well.
    expect(csv(doc(sheet(ID_A, "Demo", { ["A1"]: text("\rpovratnik") })))).toBe(
      '﻿"\'\rpovratnik"\r\n',
    );
    expect(lines[6]).toBe("sigurno =tekst");
  });

  it("guards the text a formula returns, but not a number, even a negative one", () => {
    expect(
      csv(
        doc(
          sheet(ID_A, "Demo", {
            ["A1"]: formula('=IF(1>0,"=zlo","dobro")'),
            ["B1"]: formula("=0-5"),
            ["C1"]: num(-3),
          }),
        ),
      ),
    ).toBe("﻿'=zlo;-5;-3\r\n");
  });

  it("quotes a cell with a semicolon, a quote or a new line", () => {
    expect(
      csv(
        doc(
          sheet(ID_A, "Demo", {
            ["A1"]: text("a;b"),
            ["B1"]: text('kaže "da"'),
            ["C1"]: text("prvi\ndrugi"),
          }),
        ),
      ),
    ).toBe('﻿"a;b";"kaže ""da""";"prvi\ndrugi"\r\n');
  });

  it("writes an error as its code and never a stored result", () => {
    expect(
      csv(
        doc(
          sheet(ID_A, "Demo", {
            ["A1"]: num(1),
            ["B1"]: formula("=A1/0"),
            ["C1"]: formula("=C1"),
            ["D1"]: formula("=NEPOSTOJI(1)"),
          }),
        ),
      ),
    ).toBe("﻿1;#DIV/0!;#CIRC!;#NAME?\r\n");
  });

  it("writes numbers as plain decimal text with at most 15 significant digits", () => {
    expect(
      csv(
        doc(
          sheet(ID_A, "Demo", {
            ["A1"]: formula("=0.1+0.2"),
            ["B1"]: formula("=1/3"),
            ["C1"]: num(1e21),
            ["D1"]: num(0.0000001),
          }),
        ),
      ),
    ).toBe("﻿0.3;0.333333333333333;1000000000000000000000;0.0000001\r\n");
    expect(plainDecimal(-0)).toBe("0");
    expect(plainDecimal(-12.5)).toBe("-12.5");
    expect(plainDecimal(123456789012345680000)).toBe("123456789012345680000");
  });

  it("rounds a numeric literal to 15 significant digits as a formula result is", () => {
    expect(
      csv(doc(sheet(ID_A, "Demo", { ["A1"]: num(1.2345678901234567), ["B1"]: formula("=A1") }))),
    ).toBe("\uFEFF1.23456789012346;1.23456789012346\r\n");
  });

  it("exports the first sheet, or the named one, and refuses an unknown sheet", () => {
    const document = doc(
      sheet(ID_A, "Prvi", { ["A1"]: text("prvi") }),
      sheet(ID_B, "Drugi", { ["A1"]: text("drugi") }),
    );
    expect(csv(document)).toBe("﻿prvi\r\n");
    expect(csv(document, ID_B)).toBe("﻿drugi\r\n");
    expect(renderSheetCsv(document, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toEqual({
      status: "no_sheet",
    });
  });
});
