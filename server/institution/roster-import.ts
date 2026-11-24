// SRV-ADMIN-2 admin-uvoz-popisa (Ductus#2055, NF-7 OA-10): the reading of
// the list of a course's students that an administrator uploads from Merlin
// or ISVU. Pure: text in, rows out; the database decides the rest
// (institution.preview_roster_import, 20261215120000).
//
// The format is a PROPOSAL waiting for an example of a real export ("čeka
// primjer stvarnog izvoza"; contract institution.roster-imports.post):
//   - UTF-8 text; a byte order mark at the start is dropped;
//   - RFC 4180: cells in double quotes may hold the separator, line breaks
//     and doubled quotes; CRLF, LF and CR all end a line;
//   - the separator is a semicolon or a comma, whichever the first line has
//     first outside quotes (a semicolon when it has neither);
//   - the first line that is not empty is the header; identifikator (the
//     AAI@EduHr identifier, hrEduPersonUniqueID), ime and prezime in any case
//     and order, other columns ignored; empty lines are skipped.
// The limits are the contract's (ROSTER_IMPORT_MAX_CSV_LENGTH and
// ROSTER_IMPORT_MAX_ROWS in server/contracts/routes/roster-import.ts; a test
// in server/http holds them equal).

export const ROSTER_IMPORT_MAX_CSV_LENGTH = 200_000;
export const ROSTER_IMPORT_MAX_ROWS = 1000;

/** Why a row is not sent to the database at all. */
export type RosterRowProblem = "invalid_identifier" | "missing_name" | "duplicate";
export type RosterRow = {
  /** The line of the file where the row starts, the header being line 1 or later. */
  readonly line: number;
  /** Trimmed and in lower case, cut to 255 UTF-16 units for the answer. */
  readonly identifier: string;
  /** Trimmed, cut to 200 UTF-16 units for the answer. */
  readonly givenName: string;
  readonly familyName: string;
  readonly problem: RosterRowProblem | null;
};
export type RosterFileError =
  "roster_columns_missing" | "roster_too_many_rows" | "roster_malformed";
export type RosterParse =
  | { readonly ok: true; readonly rows: readonly RosterRow[] }
  | { readonly ok: false; readonly error: RosterFileError };

/**
 * An identifier as the database takes it: printable ASCII without a space or
 * "@", then "@" and a domain in lower case (institution.preview_roster_import).
 */
const IDENTIFIER = /^[\x21-\x3f\x41-\x7e]{1,128}@[a-z0-9.-]{1,126}$/;
/** institution.is_plain_label: no control, bidirectional or zero-width character. */
const NOT_PLAIN =
  /[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const HEADERS: Readonly<Record<string, "identifier" | "givenName" | "familyName">> = {
  identifikator: "identifier",
  ime: "givenName",
  prezime: "familyName",
};

/** A plain label of institution.is_plain_label: 1 to 200 units, not only space. */
export function isPlainName(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /\S/u.test(value) && !NOT_PLAIN.test(value);
}

type CsvRecord = { readonly line: number; readonly cells: readonly string[] };

function separatorOf(text: string): string {
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && (char === ";" || char === ",")) return char;
  }
  return ";";
}

/** The records of the text, or null for a quote left open. */
function recordsOf(text: string, separator: string): CsvRecord[] | null {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => {
    cells.push(cell);
    records.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else quoted = false;
      } else {
        if (char === "\n" || (char === "\r" && text[at + 1] !== "\n")) line += 1;
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[at + 1] === "\n") at += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      cell += char;
    }
  }
  if (quoted) return null;
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}

/** The file's rows, or why the whole file is refused. Never throws. */
export function parseRosterCsv(input: string): RosterParse {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const records = recordsOf(text, separatorOf(text));
  if (records === null) return { ok: false, error: "roster_malformed" };
  const filled = records.filter((record) => record.cells.some((cell) => cell.trim() !== ""));
  const [header, ...data] = filled;
  const columns: Partial<Record<"identifier" | "givenName" | "familyName", number>> = {};
  header?.cells.forEach((name, at) => {
    const key = HEADERS[name.trim().toLowerCase()];
    if (key !== undefined && columns[key] === undefined) columns[key] = at;
  });
  const { identifier: idAt, givenName: givenAt, familyName: familyAt } = columns;
  if (idAt === undefined || givenAt === undefined || familyAt === undefined) {
    return { ok: false, error: "roster_columns_missing" };
  }
  if (data.length > ROSTER_IMPORT_MAX_ROWS) return { ok: false, error: "roster_too_many_rows" };

  const seen = new Set<string>();
  const rows = data.map(({ line, cells }): RosterRow => {
    const identifier = (cells[idAt] ?? "").trim().toLowerCase();
    const givenName = (cells[givenAt] ?? "").trim();
    const familyName = (cells[familyAt] ?? "").trim();
    let problem: RosterRowProblem | null = null;
    if (!IDENTIFIER.test(identifier)) problem = "invalid_identifier";
    else if (!isPlainName(givenName) || !isPlainName(familyName)) problem = "missing_name";
    else if (seen.has(identifier)) problem = "duplicate";
    else seen.add(identifier);
    return {
      line,
      identifier: identifier.slice(0, 255),
      givenName: givenName.slice(0, 200),
      familyName: familyName.slice(0, 200),
      problem,
    };
  });
  return { ok: true, rows };
}
