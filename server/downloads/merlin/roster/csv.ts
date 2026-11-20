// The Merlin roster as CSV (SRV-1109, D-286): the same rows and columns as the
// JSON answer, RFC 4180 with CRLF line ends and a UTF-8 byte order mark, so a
// spreadsheet reads the Croatian letters. Empty cells are the nulls of the
// JSON rows (a student without a submission). A cell a spreadsheet would read
// as a formula (= + - @ or a tab or carriage return first) gets a leading
// apostrophe; it is never evaluated.
import type { ExportLabels } from "../../export/index.ts";

import type { MerlinRosterRow } from "./roster.ts";

/** The words of the roster and its files; the caller takes them from locales/merlin.ts. */
export type MerlinLabels = {
  /** One header per column, in the order of the row fields. */
  readonly csvHeader: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  readonly yes: string;
  readonly no: string;
  readonly exportLabels: ExportLabels;
};

function cell(value: string | boolean | null, labels: MerlinLabels): string {
  if (value === null) return "";
  let text = typeof value === "boolean" ? (value ? labels.yes : labels.no) : value;
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function merlinRosterCsv(rows: readonly MerlinRosterRow[], labels: MerlinLabels): string {
  const at = (value: string | boolean | null) => cell(value, labels);
  const lines = [labels.csvHeader.map(at).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.familyName,
        row.givenName,
        row.submitted,
        row.submittedMinute,
        row.afterDeadline,
        row.pdfName,
        row.pdfSha256,
        row.docxName,
        row.docxSha256,
      ]
        .map(at)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
