// Port of Ductus tests/unit/problem-report-routes.test.ts at 220b5db
// (DAN-851-2a3, contract Ductus#1836 c.6943435196), without its app/ page
// checks: this repo has no pages. The migration's CHECKs and the domain module
// are one contract; a value one accepts and the other refuses is a report lost
// or a class widened. The edges of the shared limits and "every listed page
// maps back to itself" are in server/domain/support/problem-report.test.ts.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BROWSER_FAMILIES,
  PROBLEM_REPORT_CATEGORIES,
  PROBLEM_REPORT_DESCRIPTION_MAX,
  PROBLEM_REPORT_ROUTES,
  SYNC_STATES,
} from "../../server/domain/index.ts";

const DIRECTORY = new URL("../../db/main/migrations/", import.meta.url);
const FIRST = "20261112110000_problem_report.sql";
const read = (name: string) => readFileSync(new URL(name, DIRECTORY), "utf8");
const halves = (sql: string) => {
  const at = sql.indexOf("-- migrate:down");
  return { up: sql.slice(0, at), down: sql.slice(at) };
};
const UP = halves(read(FIRST)).up;

/** The quoted members of a `CHECK (route IN (...))` that replaces problem_report_route_check. */
function routeCheck(sql: string): string[] {
  const match = /ADD CONSTRAINT problem_report_route_check\s+CHECK \(route IN \(([^)]*)\)\)/.exec(
    sql,
  );
  if (!match?.[1]) throw new Error("no route CHECK");
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
}

/** Later migrations that replace the route CHECK, oldest first. */
const ROUTE_MIGRATIONS = readdirSync(DIRECTORY)
  .filter((name) => name > FIRST && name.endsWith(".sql"))
  .sort()
  .map(read)
  .filter((sql) => sql.includes("problem_report_route_check"))
  .map(halves);

/** The quoted members of `column ... IN (...)` in the table's CHECK. */
function checkSet(column: string): string[] {
  const match = new RegExp(
    `\\n  ${column} text[^\\n]*CHECK \\(${column} IN \\(([^)]*)\\)`,
    "s",
  ).exec(UP);
  if (!match?.[1]) throw new Error(`no CHECK set for ${column}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
}

describe("DAN-431 problem report: migration and domain agree", () => {
  it("every closed set is the same in both", () => {
    expect(ROUTE_MIGRATIONS).toHaveLength(4);
    expect(routeCheck(ROUTE_MIGRATIONS.at(-1)?.up ?? "")).toEqual([...PROBLEM_REPORT_ROUTES]);
    expect([...PROBLEM_REPORT_ROUTES].sort()).toEqual([...PROBLEM_REPORT_ROUTES]);
    expect(checkSet("category")).toEqual([...PROBLEM_REPORT_CATEGORIES]);
    expect(checkSet("browser_family")).toEqual([...BROWSER_FAMILIES]);
    expect(checkSet("sync_state")).toEqual([...SYNC_STATES]);
  });

  it("each route CHECK keeps every earlier route, and its down restores exactly the one before", () => {
    let before = checkSet("route");
    for (const { up, down } of ROUTE_MIGRATIONS) {
      const after = routeCheck(up);
      expect(after.filter((route) => !before.includes(route))).not.toEqual([]);
      expect(before.filter((route) => !after.includes(route))).toEqual([]);
      expect([...after].sort()).toEqual(after);
      expect(routeCheck(down)).toEqual(before);
      before = after;
    }
    for (const route of [
      "/stanje",
      "/kako-radi",
      "/rad/[assignmentId]/dnevnik-pristupa",
      "/nastavnik/zadatak/[assignmentId]/rad/[documentId]/jezik",
    ])
      expect(before).toContain(route);
  });

  it("the description length, the major range and the patterns are the same", () => {
    expect(UP).toContain(
      `char_length(description) BETWEEN 1 AND ${PROBLEM_REPORT_DESCRIPTION_MAX}`,
    );
    expect(UP).toContain("browser_major BETWEEN 0 AND 999");
    const source = readFileSync(
      new URL("../../server/domain/support/problem-report.ts", import.meta.url),
      "utf8",
    );
    // Prettier may break the line after "=".
    const tsVersion = /const APP_VERSION =\s*\/(.*)\/;/.exec(source)?.[1];
    expect(tsVersion).toBeDefined();
    expect(UP).toContain(`app_version ~ '${tsVersion}'`);
    const tsVisible = /const VISIBLE =\s*\/(\[\^[^\]]*\])\/u;/.exec(source)?.[1];
    expect(tsVisible).toBeDefined();
    expect(UP).toContain(`description ~ '${tsVisible}'`);
    const tsBidi = /const BIDI = \/\[([^\]]*)\]\/u;/.exec(source)?.[1];
    expect(tsBidi).toBeDefined();
    expect(UP).toMatch(
      new RegExp(`description !~ '\\[[^\\]]*${tsBidi?.replace(/\\/g, "\\\\")}\\]'`),
    );
  });
});
