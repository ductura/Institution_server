// SRV-7F: the version of a work is named by the hash of its revision 0
// (docs/contracts/document-schema-v3.md §6 and §7). The hashes are the
// written hex of the contracts, never recomputed here. Every identifier is
// invented.
import { describe, expect, it } from "vitest";

import { readWorkVersion, schemaVersionOfRevisionZero } from "./evidence-work-version.ts";
import type { ActorTransaction } from "./with-actor.ts";

const V1 = "a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b";
const V2 = "8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618";
const V3 = "b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141";

const tx = (rows: Record<string, unknown>[]) => {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const t: ActorTransaction = {
    async query(text, values) {
      seen.push({ text, values });
      return { rows: rows as never[], rowCount: rows.length };
    },
  };
  return { t, seen };
};

describe("schemaVersionOfRevisionZero", () => {
  it("names v1, v2 and v3 by the hex their contracts write", () => {
    expect(schemaVersionOfRevisionZero(V1)).toBe(1);
    expect(schemaVersionOfRevisionZero(V2)).toBe(2);
    expect(schemaVersionOfRevisionZero(V3)).toBe(3);
  });

  it.each([
    "a".repeat(64),
    V3.toUpperCase(),
    ` ${V3}`,
    "__proto__",
    "toString",
    "",
    null,
    undefined,
    3,
  ])("%s names no version", (value) => {
    expect(schemaVersionOfRevisionZero(value)).toBeNull();
  });
});

describe("readWorkVersion", () => {
  it("reads revision 0 of the given document, with the document id as a parameter", async () => {
    const { t, seen } = tx([{ content_hash: V3 }]);
    expect(await readWorkVersion(t, "dokument-izmisljeni-7f")).toEqual({
      schemaVersion: 3,
      revisionZeroHash: V3,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("evidence.document_revision");
    expect(seen[0]?.text).toMatch(/revision = 0/);
    expect(seen[0]?.values).toEqual(["dokument-izmisljeni-7f"]);
  });

  it.each([
    ["no row", []],
    ["two rows", [{ content_hash: V2 }, { content_hash: V2 }]],
    ["an unknown hash", [{ content_hash: "c".repeat(64) }]],
    ["no hash", [{}]],
  ])("%s is no version", async (_name, rows) => {
    expect(await readWorkVersion(tx(rows).t, "dokument-izmisljeni-7f")).toBeNull();
  });
});
