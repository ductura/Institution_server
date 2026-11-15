import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_KINDS } from "./account-kinds.ts";
import { ACTIONS, SCOPES, scopeOf } from "./permissions.ts";

const DOC_PATH = resolve(import.meta.dirname, "..", "..", "docs", "account-permissions.md");
const START = "<!-- permissions-table:start -->";
const END = "<!-- permissions-table:end -->";
const HEADER = ["Radnja", ...ACCOUNT_KINDS, "Izvor"];
const CODE_CELL = /^`([^`]+)`$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Differences between the table in the document and the code, both ways. */
function compareDoc(markdown: string): string[] {
  const starts = markdown.split(START).length - 1;
  const ends = markdown.split(END).length - 1;
  if (starts !== 1 || ends !== 1) return [`expected one start and one end marker`];
  const body = markdown.slice(markdown.indexOf(START) + START.length, markdown.indexOf(END));
  // One table: only blank lines around it, every line inside starts with "|"
  // at column 0, so no row can hide in a code block or a second paragraph.
  const lines = body.replace(/^\n+|\n+$/g, "").split("\n");
  const problems: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) problems.push(`not a table row: ${JSON.stringify(line)}`);
  }
  const rows = lines.filter((line) => line.startsWith("|")).map(splitRow);
  const [header, separator, ...data] = rows;
  if (JSON.stringify(header) !== JSON.stringify(HEADER)) {
    problems.push(`header ${JSON.stringify(header)} is not ${JSON.stringify(HEADER)}`);
    return problems;
  }
  if (!separator?.every((cell) => /^:?-+:?$/.test(cell))) problems.push("missing separator row");
  const seen = new Set<string>();
  for (const cells of data) {
    const action = CODE_CELL.exec(cells[0] ?? "")?.[1];
    if (!action) {
      problems.push(`row without an action code: ${cells.join(" | ")}`);
      continue;
    }
    if (cells.length !== HEADER.length) problems.push(`${action}: ${cells.length} cells`);
    if (seen.has(action)) problems.push(`${action}: duplicate row`);
    seen.add(action);
    if (!(ACTIONS as readonly string[]).includes(action)) {
      problems.push(`${action}: row in the document, not in the code`);
      continue;
    }
    ACCOUNT_KINDS.forEach((kind, index) => {
      const scope = CODE_CELL.exec(cells[index + 1] ?? "")?.[1];
      if (scope === undefined || !(SCOPES as readonly string[]).includes(scope)) {
        problems.push(`${action} × ${kind}: no valid scope in "${cells[index + 1] ?? ""}"`);
      } else if (scope !== scopeOf(kind, action)) {
        problems.push(`${action} × ${kind}: document ${scope}, code ${scopeOf(kind, action)}`);
      }
    });
    if (!cells[HEADER.length - 1]) problems.push(`${action}: no source`);
  }
  for (const action of ACTIONS) {
    if (!seen.has(action)) problems.push(`${action}: in the code, no row in the document`);
  }
  return problems;
}

const DOC = readFileSync(DOC_PATH, "utf8");

function rowOf(action: string): string {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\``));
  if (!line) throw new Error(`no row for ${action}`);
  return line;
}

describe("docs/account-permissions.md", () => {
  it("has the same table as the code", () => {
    expect(compareDoc(DOC)).toEqual([]);
  });

  it("fails on a row in the document that the code does not have", () => {
    const extra = rowOf("export_logs").replace("`export_logs`", "`delete_any_work`");
    const problems = compareDoc(DOC.replace(END, `${extra}\n${END}`));
    expect(problems).toContain("delete_any_work: row in the document, not in the code");
  });

  it("fails on an action in the code that has no row", () => {
    const problems = compareDoc(DOC.replace(`${rowOf("backup_and_restore")}\n`, ""));
    expect(problems).toContain("backup_and_restore: in the code, no row in the document");
  });

  it("fails on a duplicate row", () => {
    const row = rowOf("delete_draft");
    expect(compareDoc(DOC.replace(row, `${row}\n${row}`))).toContain("delete_draft: duplicate row");
  });

  it("fails on an extra or missing account kind column", () => {
    const header = DOC.split("\n").find((l) => l.startsWith("| Radnja"));
    if (!header) throw new Error("no header");
    expect(
      compareDoc(DOC.replace(header, header.replace("| Izvor", "| operator | Izvor"))),
    ).toHaveLength(1);
    expect(compareDoc(DOC.replace(header, header.replace("| app_admin ", "")))).toHaveLength(1);
  });

  it("fails on an empty, unknown or different cell", () => {
    const row = rowOf("read_students_work");
    const cells = row.split("|");
    const withCell = (index: number, value: string): string =>
      DOC.replace(row, cells.map((cell, i) => (i === index ? ` ${value} ` : cell)).join("|"));
    expect(compareDoc(withCell(3, ""))).toContain(
      'read_students_work × teacher: no valid scope in ""',
    );
    expect(compareDoc(withCell(3, "`everything`"))).toContain(
      'read_students_work × teacher: no valid scope in "`everything`"',
    );
    expect(compareDoc(withCell(5, "`all`"))).toContain(
      "read_students_work × app_admin: document all, code none",
    );
  });

  it("fails on a row hidden outside the table syntax", () => {
    expect(compareDoc(DOC.replace(END, `- \`export_logs\`: all\n${END}`))).toContain(
      'not a table row: "- `export_logs`: all"',
    );
    const indented = `\n    ${rowOf("export_logs")}\n`;
    expect(compareDoc(DOC.replace(END, `${indented}\n${END}`)).length).toBeGreaterThan(0);
  });
});
