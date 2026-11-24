// SRV-ADMIN-2 (NF-7 OA-10): the reading of an uploaded list of students.
// Every identifier and name below is invented.
import { describe, expect, it } from "vitest";

import { isPlainName, parseRosterCsv, ROSTER_IMPORT_MAX_ROWS } from "./roster-import.ts";

const rowsOf = (text: string) => {
  const parsed = parseRosterCsv(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rows;
};

describe("parseRosterCsv", () => {
  it("reads a semicolon file with a header in any case and order, other columns ignored", () => {
    const text =
      "\uFEFFGrupa;PREZIME;Identifikator;Ime\r\nA;Izmišljena;Ana.Izmisljena@Fakultet.invalid;Ana\r\n";
    expect(rowsOf(text)).toEqual([
      {
        line: 2,
        identifier: "ana.izmisljena@fakultet.invalid",
        givenName: "Ana",
        familyName: "Izmišljena",
        problem: null,
      },
    ]);
  });

  it("takes the comma when the header has it first, and RFC 4180 quotes", () => {
    const text =
      'identifikator,ime,prezime\n"ana@fakultet.invalid","Ana ""Anči""","Izmišljena, mlađa"\n';
    expect(rowsOf(text)).toEqual([
      expect.objectContaining({ givenName: 'Ana "Anči"', familyName: "Izmišljena, mlađa" }),
    ]);
  });

  it("counts lines across quoted line breaks and skips empty lines", () => {
    const text =
      'identifikator;ime;prezime\r\n\r\n"a@f.invalid";"Ana\r\nMarija";I\r\n;;\r\nb@f.invalid;Bo;I';
    const rows = rowsOf(text);
    expect(rows.map((row) => row.line)).toEqual([3, 6]);
    expect(rows[0]?.problem).toBe("missing_name");
    expect(rows[1]?.problem).toBeNull();
  });

  it("judges each row: identifier, names, then a duplicate of an earlier row", () => {
    const text = [
      "identifikator;ime;prezime",
      "bez-domene;Ana;I",
      "ima razmak@f.invalid;Ana;I",
      "a@F_X.invalid;Ana;I",
      "a@f.invalid;;I",
      "b@f.invalid;Bo;\u202Eobrnuto",
      "c@f.invalid;Cvita;I",
      "C@F.INVALID;Cvita;I",
      "d@f.invalid;Dora",
    ].join("\n");
    expect(rowsOf(text).map((row) => row.problem)).toEqual([
      "invalid_identifier",
      "invalid_identifier",
      "invalid_identifier",
      "missing_name",
      "missing_name",
      null,
      "duplicate",
      "missing_name",
    ]);
  });

  it("cuts long cells for the answer", () => {
    const long = "x".repeat(300);
    const [row] = rowsOf(`identifikator;ime;prezime\n${long};${long};${long}\n`);
    expect(row).toMatchObject({ problem: "invalid_identifier" });
    expect([row?.identifier.length, row?.givenName.length, row?.familyName.length]).toEqual([
      255, 200, 200,
    ]);
  });

  it("refuses a file without the three columns, a quote left open and too many rows", () => {
    expect(parseRosterCsv("")).toEqual({ ok: false, error: "roster_columns_missing" });
    expect(parseRosterCsv("ime;prezime\nAna;I\n")).toEqual({
      ok: false,
      error: "roster_columns_missing",
    });
    expect(parseRosterCsv('identifikator;ime;prezime\n"a@f.invalid;Ana;I\n')).toEqual({
      ok: false,
      error: "roster_malformed",
    });
    const rows = (count: number) =>
      Array.from({ length: count }, (_, at) => `s${at}@f.invalid;Ana;I`).join("\n");
    expect(rowsOf(`identifikator;ime;prezime\n${rows(ROSTER_IMPORT_MAX_ROWS)}`)).toHaveLength(
      ROSTER_IMPORT_MAX_ROWS,
    );
    expect(
      parseRosterCsv(`identifikator;ime;prezime\n${rows(ROSTER_IMPORT_MAX_ROWS + 1)}`),
    ).toEqual({ ok: false, error: "roster_too_many_rows" });
  });

  it("reads a header alone as no rows", () => {
    expect(parseRosterCsv("Prezime,Ime,Identifikator\n")).toEqual({ ok: true, rows: [] });
  });
});

describe("isPlainName", () => {
  it.each([
    ["Ana", true],
    ["", false],
    ["   ", false],
    ["a\u0007b", false],
    ["a\u200Bb", false],
    ["x".repeat(200), true],
    ["x".repeat(201), false],
  ])("%j -> %s", (value, plain) => {
    expect(isPlainName(value)).toBe(plain);
  });
});
