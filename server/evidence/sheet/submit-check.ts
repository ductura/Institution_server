// SRV-V14-SHEET-SUBMIT: what the submission of a spreadsheet work adds to the
// text path (WEB docs/nalazi/val14-razlika.md, task 5). The record is replayed
// with the sheet step format (so a text or slides step on a spreadsheet work is
// a mismatch, never a success), the document it reproduces is judged by the
// spreadsheet validator, and its formulas are computed again. The computed
// result is never stored as truth and never part of the receipt: the only
// trace is the mark "calculation aligned", which carries no grade and no rank.
import {
  computeSheet,
  validateSheetDocument,
  type EvidenceStepReplayerV2,
  type SheetDocument,
} from "../../domain/index.ts";

import { sheetStepReplayer } from "./reconstruct.ts";

/**
 * - `aligned`: the document is valid and computing it twice gives the same
 *   results (formula errors such as `#DIV/0!` are results, not failures).
 * - `divergent`: two computations of the same document differ or one threw.
 *   Never a verdict on the student: the mark is absent, the submission goes on.
 * - `invalid`: the reproduced document is not a valid spreadsheet document.
 */
export type SheetSubmissionCheck = { status: "aligned" | "divergent" | "invalid" };

/** Judges the document a submitted revision reproduces; `null` (nothing replayed) is invalid. */
export function checkSheetSubmission(document: unknown): SheetSubmissionCheck {
  if (document === null || document === undefined) return { status: "invalid" };
  const valid = validateSheetDocument(document);
  if (!valid.ok) return { status: "invalid" };
  try {
    const first = JSON.stringify(valid.doc.sheets.map(computeSheet));
    const second = JSON.stringify(valid.doc.sheets.map(computeSheet));
    return { status: first === second ? "aligned" : "divergent" };
  } catch {
    return { status: "divergent" };
  }
}

/**
 * The sheet replayer that remembers the last document it produced, so the
 * reconstruction (which gives only the hash of the final document) can be
 * followed by the check of that very document.
 */
export function capturingSheetReplayer(): {
  replayer: EvidenceStepReplayerV2<SheetDocument>;
  last: () => SheetDocument | null;
} {
  let latest: SheetDocument | null = null;
  const replayer: EvidenceStepReplayerV2<SheetDocument> = {
    transactionFormat: sheetStepReplayer.transactionFormat,
    load(canonical) {
      latest = sheetStepReplayer.load(canonical);
      return latest;
    },
    apply(document, event) {
      latest = sheetStepReplayer.apply(document, event);
      return latest;
    },
    toCanonical: (document) => sheetStepReplayer.toCanonical(document),
  };
  return { replayer, last: () => latest };
}
