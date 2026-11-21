import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// SRV-1809 (plan M9.0-S2; acceptance 3; T8, Q-10): there is no cost figure in
// the code. Every limit, reservation and amount comes from the published cost
// configuration in the database, and an empty one turns the assistant off.
// The check: in the assistant code no number other than zero is bound to a
// name about money, no bigint other than 0n appears at all (amounts are
// bigint micro-euros), and the assistant migrations give no money column a
// default or a bound above zero.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AREAS = [
  "server/external/assistant",
  "server/domain/assistant",
  "server/http/assistant",
  "server/database/assistant",
  "server/contracts/evidence-transfer",
];
const MONEY =
  /micro|cost|budget|price|euro|eur\b|amount|reserv|cap\b|caps\b|limit|spen[dt]|tariff|fee/iu;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The name a literal is bound to: variable, property, parameter default or the other side of a comparison. */
function boundName(node: ts.Node): string | null {
  let current: ts.Node = node;
  while (
    ts.isPrefixUnaryExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    (ts.isBinaryExpression(current.parent) &&
      [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
        current.parent.operatorToken.kind,
      ))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name !== undefined
  ) {
    return parent.name.getText();
  }
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === current ? parent.right : parent.left;
    return other.getText();
  }
  return null;
}

type Finding = { file: string; line: number; text: string };

function costFigures(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    const numeric = ts.isNumericLiteral(node);
    const bigint = ts.isBigIntLiteral(node);
    if (numeric || bigint) {
      const value = node.text.replace(/n$/u, "").replaceAll("_", "");
      const zero = Number(value) === 0;
      const name = boundName(node);
      if (!zero && (bigint || (name !== null && MONEY.test(name)))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push({ file, line: line + 1, text: `${name ?? "?"} = ${node.getText()}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no cost figures in the code (acceptance 3)", () => {
  const files = AREAS.flatMap(sourceFiles);

  it("covers the assistant areas", () => {
    for (const area of AREAS) expect(files.some((file) => file.startsWith(area))).toBe(true);
  });

  it("binds no number above zero to a name about money, and uses no bigint above zero", () => {
    const found = files.flatMap((file) =>
      costFigures(file, readFileSync(join(ROOT, file), "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("the check catches a figure", () => {
    const samples = [
      "const DEFAULT_RESERVE_MICRO = 50_000n;",
      "const limits = { studentDayMicro: 2000000n };",
      "const studentDayCostEur = 0.5;",
      "if (spent > 3 * 1000) {}",
      "function f(capMicro = 10) {}",
      "const x = 7n;",
    ];
    for (const sample of samples)
      expect(costFigures("sample.ts", sample).length).toBeGreaterThan(0);
    for (const sample of [
      "const MAX_RESPONSE_CODE_POINTS = 8_000;",
      "if (limit > 0n) {}",
      "const reserveMicro = 0n;",
      "const QUERY_MAX = 200;",
    ]) {
      expect(costFigures("sample.ts", sample)).toEqual([]);
    }
  });

  it("the assistant migrations give no money column a default or a bound above zero", () => {
    const migrations = readdirSync(join(ROOT, "db/main/migrations")).filter((name) =>
      /assistant/u.test(name),
    );
    expect(migrations.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const name of migrations) {
      const sql = readFileSync(join(ROOT, "db/main/migrations", name), "utf8")
        .replace(/--[^\n]*/gu, "")
        .replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const match of sql.matchAll(
        /\w*_micro\b[^;,\n]*?(?:DEFAULT|>=|<=|<>|=|>|<)\s*\(?\s*([0-9][0-9_.]*)/giu,
      )) {
        if (Number(match[1]?.replaceAll("_", "")) !== 0) found.push(`${name}: ${match[0]}`);
      }
      for (const match of sql.matchAll(/\b([1-9][0-9]*)\s*::\s*(?:bigint|numeric)\b/giu)) {
        found.push(`${name}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  });
});
