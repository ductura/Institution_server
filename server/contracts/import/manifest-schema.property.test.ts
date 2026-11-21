import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_IMPORT_RAW_BYTES } from "./limits.ts";
import { ImportManifestV1, IMPORT_MANIFEST_SCHEMA_V1, parseImportManifestV1 } from "./manifest.ts";

// SRV-1801 (ADR docs/adr/import-contract.md §2): the published TypeBox schema
// and the hand-written reader give the same answer. The reader is stricter
// only where a schema cannot speak: trace order, a real minute and a
// document id that is blank or holds a lone surrogate. All data is invented.

const UUID = "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c";
const absent = Symbol("absent");

const field = {
  manifestSchema: [
    IMPORT_MANIFEST_SCHEMA_V1,
    "ductus-import-manifest-V1",
    "ductus-import-manifest-v2",
    1,
  ],
  importId: [UUID, UUID.toUpperCase(), "00000000-0000-0000-0000-000000000000", "", 7],
  documentId: [
    "dokument-izmisljeni-uvoz",
    "",
    "  ",
    "x".repeat(256),
    "x".repeat(257),
    "a\uD800b",
    3,
  ],
  importKind: ["file-upload", "cloud-version", "email", ""],
  fileFormat: ["docx", "pdf", "odt", "DOCX"],
  rawSha256: ["1".repeat(64), "A".repeat(64), "1".repeat(63), null],
  rawByteLength: [1, MAX_IMPORT_RAW_BYTES, MAX_IMPORT_RAW_BYTES + 1, 0, 1.5, "10", Number.NaN],
  contentSha256: ["2".repeat(64), "g".repeat(64), "2".repeat(65)],
  traces: [
    [{ traceKind: "comment", count: 2 }],
    absent,
    [],
    [
      { traceKind: "comment", count: 1 },
      { traceKind: "insertion", count: 3 },
    ],
    [
      { traceKind: "insertion", count: 1 },
      { traceKind: "comment", count: 1 },
    ],
    [
      { traceKind: "comment", count: 1 },
      { traceKind: "comment", count: 1 },
    ],
    [{ traceKind: "comment", count: 0 }],
    [{ traceKind: "comment", count: 1, author: "Lorem Autor" }],
    [{ traceKind: "move", count: 1 }],
    {},
  ],
  savedAt: [
    absent,
    "2026-11-10T08:15:00.000Z",
    "2026-11-10T08:15:30.000Z",
    "2026-02-30T08:15:00.000Z",
    "2026-11-10T08:15:00Z",
  ],
  extra: [absent, "Lorem Autor"],
} as const;

// Mostly the first (valid) value, so accepted manifests are common too.
const pick = <T>(values: readonly T[]) =>
  fc.oneof(
    { arbitrary: fc.constant(values[0] as T), weight: 12 },
    { arbitrary: fc.constantFrom(...values), weight: 1 },
  );

const manifest = fc
  .record(Object.fromEntries(Object.entries(field).map(([key, values]) => [key, pick(values)])))
  .map((choice) => {
    const value: Record<string, unknown> = {};
    for (const [key, chosen] of Object.entries(choice)) {
      if (chosen === absent) continue;
      value[key === "extra" ? "author" : key] = chosen;
    }
    return value;
  });

function onlySchemaCanMiss(value: Record<string, unknown>): boolean {
  const traces = value.traces;
  const order = ["comment", "deletion", "insertion"];
  const inOrder =
    !Array.isArray(traces) ||
    traces.every(
      (t, i) => i === 0 || order.indexOf(t.traceKind) > order.indexOf(traces[i - 1].traceKind),
    );
  const id = value.documentId;
  const goodId = typeof id !== "string" || (id.trim() !== "" && !/[\uD800-\uDFFF]/u.test(id));
  const at = value.savedAt;
  const realMinute = typeof at !== "string" || new Date(Date.parse(at)).toISOString() === at;
  return !(inOrder && goodId && realMinute);
}

describe("import manifest: schema and reader agree", () => {
  it("whatever the reader accepts, the schema accepts; the schema accepts more only where it cannot speak", () => {
    const seen = { accepted: 0, rejected: 0 };
    fc.assert(
      fc.property(manifest, (value) => {
        const read = parseImportManifestV1(value).ok;
        const schema = Value.Check(ImportManifestV1, value);
        seen[read ? "accepted" : "rejected"] += 1;
        if (read) expect(schema).toBe(true);
        if (schema && !read) expect(onlySchemaCanMiss(value)).toBe(true);
      }),
      { numRuns: 3000 },
    );
    // Both answers must actually occur, or the property says nothing.
    expect(seen.accepted).toBeGreaterThan(100);
    expect(seen.rejected).toBeGreaterThan(100);
  });
});
