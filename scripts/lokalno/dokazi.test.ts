// INT-08: the evidence statements and the S3 settings of `pnpm lokalno`, with
// no PostgreSQL: the SQL is only transformed here (the registration itself is
// db/main/local/evidence-signing-key.sql, run by scripts/stack in its tests).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evidenceKeyStatements, s3Root, seedPath } from "./dokazi.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SQL = readFileSync(join(ROOT, "db/main/local/evidence-signing-key.sql"), "utf8");
const VARS = new Map([
  ["institution_slug", "demo-fakultet"],
  ["key_id", "dev-key"],
  ["key_version", "v1"],
  ["key_base64url", "AbC_-123"],
]);

describe("evidenceKeyStatements", () => {
  it("drops the psql guard and \\gset and fills every variable", () => {
    const text = evidenceKeyStatements(SQL, VARS);
    expect(text).not.toMatch(/\\gset|\\set|\\if|\\endif|:'/u);
    expect(text).not.toContain("trusted_local_operator");
    expect(text).toContain("set_config('ductus_local.institution_slug', 'demo-fakultet', true)");
    expect(text).toContain("BEGIN;");
    expect(text).toContain("COMMIT;");
  });
  it("refuses an unsafe or missing value and a changed guard", () => {
    expect(() => evidenceKeyStatements(SQL, new Map([...VARS, ["key_id", "x'; DROP"]]))).toThrow(
      "safe value",
    );
    const missing = new Map(VARS);
    missing.delete("key_version");
    expect(() => evidenceKeyStatements(SQL, missing)).toThrow("safe value");
    expect(() => evidenceKeyStatements("SELECT 1;\n", VARS)).toThrow("guard");
  });
});

describe("where the files live", () => {
  it("the signing seed is outside the checkout and the S3 objects are in .local", () => {
    const seed = seedPath("/work/repo/.local", "/work/repo", "/home/dev");
    expect(seed.startsWith("/home/dev/.ductura/")).toBe(true);
    expect(() => seedPath("/work/repo/.local", "/work/repo", "/work/repo/home")).toThrow("HOME");
    // A root with a trailing slash (a file URL's) still counts as the checkout.
    expect(seedPath("/work/repo/.local", "/work/repo/", "/home/dev")).toBe(seed);
    expect(s3Root("/work/repo/.local")).toBe("/work/repo/.local/s3");
  });
});
