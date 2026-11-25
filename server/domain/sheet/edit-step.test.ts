// SRV-V14-SHEET-EVIDENCE: the steps of a spreadsheet work. All ids and texts are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applySheetStep,
  applySheetSteps,
  parseSheetStep,
  parseSheetSteps,
  sheetCellSha256,
  sheetCellsSha256,
  sheetDigest,
  sheetJcsBytes,
  sheetRevisionZeroDocument,
  sheetTextSha256,
  type SheetDocument,
  type SheetStep,
} from "./index.ts";

// Vectors derived outside this code (Python), compared as written.
const VECTORS = JSON.parse(
  readFileSync(new URL("./edit-step-vectors.json", import.meta.url), "latin1"),
) as {
  revisionZero: { jcs: string; sha256: string };
  chain: { steps: unknown[]; finalJcs: string; finalSha256: string };
  removedHashes: Record<string, { sha256: string } & Record<string, unknown>>;
};

const S = "00000000-0000-4000-8000-000000000000";
const OTHER = "11111111-1111-4111-8111-111111111111";
const zero = sheetRevisionZeroDocument();

function apply(doc: SheetDocument, ...steps: unknown[]): SheetDocument {
  const parsed = parseSheetSteps(steps);
  if (!parsed.ok) throw new Error(`parse: ${parsed.error}`);
  const applied = applySheetSteps(doc, parsed.steps);
  if (!applied.ok) throw new Error(`apply: ${applied.error} at ${applied.index}`);
  return applied.doc;
}

function refused(doc: SheetDocument, step: unknown) {
  const parsed = parseSheetStep(step);
  if (!parsed.ok) throw new Error(`parse: ${parsed.error}`);
  const applied = applySheetStep(doc, parsed.step);
  return applied.ok ? null : applied.error;
}

describe("revision 0 and the golden vectors", () => {
  it("is the known-answer document", () => {
    expect(Buffer.from(sheetJcsBytes(zero)).toString("utf8")).toBe(VECTORS.revisionZero.jcs);
    expect(sheetDigest(zero)).toBe(VECTORS.revisionZero.sha256);
    expect(createHash("sha256").update(VECTORS.revisionZero.jcs).digest("hex")).toBe(
      VECTORS.revisionZero.sha256,
    );
  });

  it("gives the recorded final document for the recorded chain of steps", () => {
    const final = apply(zero, ...VECTORS.chain.steps);
    expect(Buffer.from(sheetJcsBytes(final)).toString("utf8")).toBe(VECTORS.chain.finalJcs);
    expect(sheetDigest(final)).toBe(VECTORS.chain.finalSha256);
  });

  it("hashes removed content as recorded", () => {
    const v = VECTORS.removedHashes;
    expect(sheetCellSha256(v.cell!.cell as never)).toBe(v.cell!.sha256);
    expect(sheetCellsSha256(v.row2!.cells as never)).toBe(v.row2!.sha256);
    expect(sheetCellsSha256(v.column3!.cells as never)).toBe(v.column3!.sha256);
    expect(sheetCellsSha256({})).toBe(v.emptyRow!.sha256);
    expect(sheetTextSha256("List1")).toBe(v.sheetName!.sha256);
  });

  it("gives the same output for the same input", () => {
    expect(sheetDigest(apply(zero, ...VECTORS.chain.steps))).toBe(
      sheetDigest(apply(zero, ...VECTORS.chain.steps)),
    );
  });
});

describe("parseSheetStep", () => {
  const ok = { type: "cellSet", sheetId: S, ref: "B2", value: 3 };

  it("reads a valid step as a fresh copy of the known fields", () => {
    const parsed = parseSheetStep(ok);
    expect(parsed).toEqual({ ok: true, step: ok });
    if (parsed.ok) expect(parsed.step).not.toBe(ok);
  });

  it.each([
    ["an unknown step type", { type: "cellDrop", sheetId: S }, "unknown_step"],
    ["no type", { sheetId: S }, "unknown_step"],
    ["a non-object", "cellSet", "not_an_object"],
    ["an array", [], "not_an_object"],
    ["an unknown field", { ...ok, at: 1 }, "step_invalid"],
    ["a time field", { ...ok, timestamp: 1 }, "step_invalid"],
    [
      "an uppercase sheet id",
      { ...ok, sheetId: S.toUpperCase().replace(/0/g, "A") },
      "step_invalid",
    ],
    ["a reference outside A1 form", { ...ok, ref: "AA1" }, "step_invalid"],
    ["a reference with a zero row", { ...ok, ref: "A0" }, "step_invalid"],
    ["a row beyond the grid", { ...ok, ref: "A201" }, "step_invalid"],
    ["both a value and a formula", { ...ok, formula: "=1" }, "step_invalid"],
    ["neither a value nor a formula", { type: "cellSet", sheetId: S, ref: "A1" }, "step_invalid"],
    ["a boolean value", { ...ok, value: true }, "step_invalid"],
    ["a null value", { ...ok, value: null }, "step_invalid"],
    ["an infinite value", { ...ok, value: Number.POSITIVE_INFINITY }, "step_invalid"],
    [
      "a formula over 500 points",
      { type: "cellSet", sheetId: S, ref: "A1", formula: `=${"1".repeat(500)}` },
      "step_invalid",
    ],
    ["a malformed replaced hash", { ...ok, replacedSha256: "ABC" }, "step_invalid"],
    ["a clear without its hash", { type: "cellClear", sheetId: S, ref: "A1" }, "step_invalid"],
    ["a row of zero", { type: "rowInsert", sheetId: S, row: 0 }, "step_invalid"],
    ["a fractional row", { type: "rowInsert", sheetId: S, row: 1.5 }, "step_invalid"],
    [
      "a column given as a letter",
      { type: "columnInsert", sheetId: S, column: "B" },
      "step_invalid",
    ],
    ["a removal without its hash", { type: "rowRemove", sheetId: S, row: 1 }, "step_invalid"],
    [
      "a rename without the old name's hash",
      { type: "sheetRename", sheetId: S, name: "x" },
      "step_invalid",
    ],
  ])("refuses %s", (_name, raw, error) => {
    expect(parseSheetStep(raw)).toEqual({ ok: false, error });
  });

  it("refuses __proto__ as a key", () => {
    expect(
      parseSheetStep(JSON.parse(`{"type":"rowInsert","sheetId":"${S}","row":1,"__proto__":{}}`)).ok,
    ).toBe(false);
  });

  it("refuses an empty, sparse or oversized array of steps and names the bad index", () => {
    const sparse: unknown[] = [ok];
    sparse[2] = ok;
    expect(parseSheetSteps([])).toEqual({ ok: false, error: "step_invalid" });
    expect(parseSheetSteps({})).toEqual({ ok: false, error: "step_invalid" });
    expect(parseSheetSteps(sparse)).toEqual({ ok: false, error: "step_invalid", index: 1 });
    expect(parseSheetSteps([ok, { type: "nope", sheetId: S }])).toEqual({
      ok: false,
      error: "unknown_step",
      index: 1,
    });
    expect(parseSheetSteps(Array.from({ length: 1001 }, () => ok))).toEqual({
      ok: false,
      error: "too_many_steps",
    });
  });
});

describe("applySheetStep", () => {
  const set = (ref: string, value: string | number, replaced?: unknown) => ({
    type: "cellSet",
    sheetId: S,
    ref,
    value,
    ...(replaced === undefined ? {} : { replacedSha256: replaced }),
  });

  it("never changes its input", () => {
    const before = sheetDigest(zero);
    apply(zero, set("A1", "demo"));
    expect(sheetDigest(zero)).toBe(before);
  });

  it("refuses a step for a sheet the document does not have", () => {
    expect(refused(zero, { type: "rowInsert", sheetId: OTHER, row: 1 })).toBe("sheet_not_found");
  });

  it("refuses a cell outside the sheet's own grid", () => {
    expect(refused(zero, set("K1", 1))).toBe("cell_out_of_grid");
    expect(refused(zero, set("A101", 1))).toBe("cell_out_of_grid");
  });

  it("requires the hash of a replaced cell exactly when a cell is there", () => {
    const one = apply(zero, set("A1", "demo"));
    expect(refused(one, set("A1", "novo"))).toBe("hash_mismatch");
    expect(refused(zero, set("A1", "novo", "a".repeat(64)))).toBe("hash_mismatch");
    expect(refused(one, set("A1", "novo", "a".repeat(64)))).toBe("hash_mismatch");
    expect(refused(one, set("A1", "novo", sheetCellSha256({ value: "demo" })))).toBeNull();
  });

  it("refuses a step that changes nothing", () => {
    const one = apply(zero, set("A1", "demo"));
    expect(refused(one, set("A1", "demo", sheetCellSha256({ value: "demo" })))).toBe("no_change");
    expect(
      refused(zero, { type: "cellClear", sheetId: S, ref: "A1", removedSha256: "a".repeat(64) }),
    ).toBe("no_change");
  });

  it('keeps the number 1 and the text "1" apart', () => {
    const one = apply(zero, set("A1", 1));
    expect(refused(one, set("A1", "1", sheetCellSha256({ value: 1 })))).toBeNull();
  });

  it("clears a cell only with the hash of what is there", () => {
    const one = apply(zero, set("A1", "demo"));
    expect(
      refused(one, { type: "cellClear", sheetId: S, ref: "A1", removedSha256: "b".repeat(64) }),
    ).toBe("hash_mismatch");
    const cleared = apply(one, {
      type: "cellClear",
      sheetId: S,
      ref: "A1",
      removedSha256: sheetCellSha256({ value: "demo" }),
    });
    expect(cleared.sheets[0]!.cells).toEqual({});
  });

  it("shifts cells with an inserted row and a removed column, and drops the removed ones", () => {
    const doc = apply(zero, set("A1", 1), set("B2", 2), set("C3", 3));
    const inserted = apply(doc, { type: "rowInsert", sheetId: S, row: 2 });
    expect(Object.keys(inserted.sheets[0]!.cells).sort()).toEqual(["A1", "B3", "C4"]);
    expect(inserted.sheets[0]!.rows).toBe(101);
    const removed = apply(doc, {
      type: "columnRemove",
      sheetId: S,
      column: 2,
      removedSha256: sheetCellsSha256({ ["B2"]: { value: 2 } }),
    });
    expect(Object.keys(removed.sheets[0]!.cells).sort()).toEqual(["A1", "B3"]);
    expect(removed.sheets[0]!.columns).toBe(9);
  });

  it("refuses to remove a row whose content is not the one the step names", () => {
    const doc = apply(zero, set("A2", 1));
    expect(
      refused(doc, { type: "rowRemove", sheetId: S, row: 2, removedSha256: sheetCellsSha256({}) }),
    ).toBe("hash_mismatch");
    expect(
      refused(doc, { type: "rowRemove", sheetId: S, row: 3, removedSha256: sheetCellsSha256({}) }),
    ).toBeNull();
  });

  it("keeps rows and columns inside the limits", () => {
    expect(refused(zero, { type: "rowInsert", sheetId: S, row: 102 })).toBe("index_out_of_range");
    expect(
      refused(zero, {
        type: "rowRemove",
        sheetId: S,
        row: 101,
        removedSha256: sheetCellsSha256({}),
      }),
    ).toBe("index_out_of_range");
    const wide = { ...zero, sheets: [{ ...zero.sheets[0]!, rows: 200, columns: 26 }] };
    expect(refused(wide, { type: "rowInsert", sheetId: S, row: 1 })).toBe("index_out_of_range");
    expect(refused(wide, { type: "columnInsert", sheetId: S, column: 1 })).toBe(
      "index_out_of_range",
    );
  });

  it("refuses a result the document validator refuses", () => {
    const named = apply(zero, {
      type: "sheetRename",
      sheetId: S,
      name: "Drugi",
      replacedSha256: sheetTextSha256("List1"),
    });
    const two: SheetDocument = {
      ...named,
      sheets: [...named.sheets, { id: OTHER, name: "Treci", rows: 5, columns: 5, cells: {} }],
    };
    // A name that clashes with another sheet's, ignoring case, is refused after the step.
    expect(
      refused(two, {
        type: "sheetRename",
        sheetId: OTHER,
        name: "DRUGI",
        replacedSha256: sheetTextSha256("Treci"),
      }),
    ).toBe("result_invalid");
    // A name the .xlsx format refuses.
    expect(
      refused(zero, {
        type: "sheetRename",
        sheetId: S,
        name: "a/b",
        replacedSha256: sheetTextSha256("List1"),
      }),
    ).toBe("result_invalid");
  });

  it("refuses a cell text over its limit and more than 3000 filled cells", () => {
    expect(refused(zero, set("A1", "x".repeat(1001)))).toBe("result_invalid");
    const keys: string[] = [];
    for (let row = 1; keys.length < 3000; row += 1) {
      for (let col = 0; col < 26 && keys.length < 3000; col += 1) {
        keys.push(`${String.fromCharCode(65 + col)}${row}`);
      }
    }
    const doc: SheetDocument = {
      ...zero,
      sheets: [
        {
          ...zero.sheets[0]!,
          rows: 200,
          columns: 26,
          cells: Object.fromEntries(keys.map((k) => [k, { value: 1 }])),
        },
      ],
    };
    expect(refused(doc, set("A200", 1))).toBe("result_invalid");
  });

  it("refuses a document that is not valid to begin with", () => {
    const parsed = parseSheetStep(set("A1", 1)) as { ok: true; step: SheetStep };
    expect(applySheetStep({ ...zero, kind: "text" } as never, parsed.step)).toEqual({
      ok: false,
      error: "document_invalid",
    });
  });

  it("stores a formula as text and never a result", () => {
    const doc = apply(zero, { type: "cellSet", sheetId: S, ref: "A1", formula: "=1+1" });
    expect(doc.sheets[0]!.cells.A1).toEqual({ value: null, formula: "=1+1" });
  });

  it("leaves no trace of a refused step in a list of steps", () => {
    const parsed = parseSheetSteps([set("A1", 1), set("K1", 1)]);
    if (!parsed.ok) throw new Error("parse");
    expect(applySheetSteps(zero, parsed.steps)).toEqual({
      ok: false,
      error: "cell_out_of_grid",
      index: 1,
    });
    expect(sheetDigest(zero)).toBe(VECTORS.revisionZero.sha256);
  });
});
