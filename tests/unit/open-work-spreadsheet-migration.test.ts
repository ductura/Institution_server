import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  sheetDigest,
  sheetJcsBytes,
  sheetRevisionZeroDocument,
} from "../../server/domain/index.ts";

// F4-V14-R01: app.open_student_work writes the spreadsheet revision 0 as a SQL
// literal. This keeps the migration and the sheet domain from drifting apart
// (pgTAP checks the stored bytes and hash against the same literals, db/main/
// tests/046-evidence-open-work.sql). Every value is invented.
const MIGRATION = "20261220560000_open_work_spreadsheet.sql";
const TEXT = readFileSync(
  new URL(`../../db/main/migrations/${MIGRATION}`, import.meta.url),
  "utf8",
);
const UP = TEXT.slice(0, TEXT.indexOf("-- migrate:down"));

describe("open_student_work spreadsheet migration", () => {
  const jcs = Buffer.from(sheetJcsBytes(sheetRevisionZeroDocument())).toString("utf8");

  it("stores the revision 0 bytes of the sheet domain", () => {
    expect(UP).toContain(`'${jcs}'::text`);
  });

  it("names the hash the pgTAP rows and the work reader expect", () => {
    expect(sheetDigest(sheetRevisionZeroDocument())).toBe(
      "70f7ffa27faf9f771316120c2b2f94e351aed32af3b94177d4c85ff56b0066e4",
    );
  });

  it("opens spreadsheet and text only; slides stay not configured", () => {
    expect(UP).toContain("v_kind NOT IN ('text', 'spreadsheet')");
  });
});
