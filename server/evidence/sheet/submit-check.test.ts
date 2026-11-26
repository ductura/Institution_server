// SRV-V14-SHEET-SUBMIT: the check of a submitted spreadsheet document. All ids and texts are invented.
import { describe, expect, it } from "vitest";

import {
  sheetRevisionZeroDocument,
  type JcsJsonValue,
  type SheetStep,
} from "../../domain/index.ts";

import { capturingSheetReplayer, checkSheetSubmission } from "./submit-check.ts";

const S = "00000000-0000-4000-8000-000000000000";
const STEPS: SheetStep[] = [
  { type: "cellSet", sheetId: S, ref: "A1", value: 4 },
  { type: "cellSet", sheetId: S, ref: "B1", formula: "=A1/0" },
];

describe("checkSheetSubmission", () => {
  it("treats a formula error as a result, not as a failure", () => {
    const doc = sheetRevisionZeroDocument();
    doc.sheets[0]!.cells["A1"] = { value: null, formula: "=1/0" };
    expect(checkSheetSubmission(doc)).toEqual({ status: "aligned" });
  });

  it.each([null, undefined, {}, { schemaVersion: 1, nodes: [] }, "text"])(
    "refuses %j as no spreadsheet document",
    (value) => {
      expect(checkSheetSubmission(value)).toEqual({ status: "invalid" });
    },
  );
});

describe("capturingSheetReplayer", () => {
  it("remembers the revision 0 and then the last document", () => {
    const captured = capturingSheetReplayer();
    expect(captured.last()).toBeNull();
    const zero = sheetRevisionZeroDocument();
    const loaded = captured.replayer.load(zero as unknown as JcsJsonValue);
    expect(captured.last()).toEqual(loaded);
    const next = captured.replayer.apply(loaded, {
      sequence: 1,
      source: "editor",
      steps: STEPS,
    } as never);
    expect(captured.last()).toEqual(next);
    expect(next.sheets[0]!.cells["A1"]).toBeDefined();
  });
});
