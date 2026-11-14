import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// S-0.13 (DAN-726): db/main/local/migrator.sql is the role file of the local
// and CI database, verbatim from Ductus db/local/migrator.sql at d52a92c3.
// Like the migrations, git checks it out with LF on every platform.
const FILE = "db/main/local/migrator.sql";

describe(FILE, () => {
  it("is checked out as text with LF on every platform", () => {
    const output = execFileSync("git", ["check-attr", "text", "eol", "--", FILE], {
      encoding: "utf8",
    });
    expect(output.trimEnd().split("\n")).toStrictEqual([`${FILE}: text: set`, `${FILE}: eol: lf`]);
  });

  it("contains no carriage return in this checkout", () => {
    expect(readFileSync(FILE).includes(0x0d)).toBe(false);
  });
});
