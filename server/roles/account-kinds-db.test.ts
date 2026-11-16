// DAN-798 (S-1J.1-b): every account kind has a row in the pgTAP access matrix
// of db/main/tests/130-account-kinds.sql, and the matrix names no other kind.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_KINDS } from "./account-kinds.ts";

const MATRIX_PATH = resolve(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "main",
  "tests",
  "130-account-kinds.sql",
);
const START = "-- account-kinds:begin";
const END = "-- account-kinds:end";
const ROW = /^ {2}\('([a-z_]+)', '([a-z_]+\.[a-z_]+)', (?:'[^']*'|\$\$[^$]*\$\$)\),?$/;

/** Kinds of the matrix in the SQL file, or the problems found reading it. */
function readMatrix(sql: string): { kinds: string[]; problems: string[] } {
  const problems: string[] = [];
  if (sql.split(START).length !== 2 || sql.split(END).length !== 2) {
    return { kinds: [], problems: ["expected one start and one end marker"] };
  }
  const body = sql.slice(sql.indexOf(START) + START.length, sql.indexOf(END));
  const kinds: string[] = [];
  for (const line of body.replace(/^\n+|\n+$/g, "").split("\n")) {
    const match = ROW.exec(line);
    if (match?.[1] === undefined) problems.push(`not a matrix row: ${JSON.stringify(line)}`);
    else kinds.push(match[1]);
  }
  return { kinds, problems };
}

describe("account kinds in the database access matrix", () => {
  it("has exactly one row for each kind of ACCOUNT_KINDS, in order", () => {
    const { kinds, problems } = readMatrix(readFileSync(MATRIX_PATH, "utf8"));
    expect(problems).toEqual([]);
    expect(kinds).toEqual([...ACCOUNT_KINDS]);
  });

  it("fails on a missing, extra or hidden row", () => {
    const rows = ACCOUNT_KINDS.map((kind) => `  ('${kind}', 'identity.t', 'true'),`);
    const wrap = (lines: string[]) => `x\n${START}\n${lines.join("\n")}\n${END}\n;`;
    expect(readMatrix(wrap(rows)).kinds).toEqual([...ACCOUNT_KINDS]);
    expect(readMatrix(wrap(rows.slice(1))).kinds).not.toEqual([...ACCOUNT_KINDS]);
    expect(readMatrix(wrap([...rows, "  ('operator', 'identity.t', 'true')"])).kinds).not.toEqual([
      ...ACCOUNT_KINDS,
    ]);
    expect(
      readMatrix(wrap([...rows, "-- ('operator', 'identity.t', 'true')"])).problems,
    ).not.toEqual([]);
    expect(readMatrix(`${START}\n${START}\n${END}`).problems).not.toEqual([]);
  });
});
