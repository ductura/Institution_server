import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../forensics/index.ts";
import {
  REVISION_ZERO_JCS,
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_JCS,
  REVISION_ZERO_V2_SHA256,
} from "./revision-zero.ts";
import {
  MAX_DOCUMENT_SNAPSHOT_BYTES,
  verifyDocumentSnapshot,
  verifyVersionedDocumentSnapshot,
} from "./snapshot.ts";

// SRV-33 (Ductus#2028 c.7009695691): the commit snapshot of schema 1 or 2.
// Accepted: v1 and v2 as exact JCS; refused: an unknown field (B-8) in either
// version, a document over 2 MiB, a v2 document that is not JCS. Synthetic data.

const SRC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P = "11111111-1111-4111-8111-111111111111";
const book = {
  type: "book",
  id: SRC,
  authors: [{ kind: "person", family: "Prezime", given: "Ime" }],
  year: 2020,
  title: "Izvor 1",
  place: "Zagreb",
  publisher: "Nakladnik",
};
const v1 = (text: string) => ({
  schemaVersion: 1,
  nodes: [{ type: "paragraph", id: P, children: [{ type: "text", text, marks: [] }] }],
});
const v2 = (text: string) => ({
  schemaVersion: 2,
  nodes: [
    {
      type: "paragraph",
      id: P,
      children: [
        { type: "text", text, marks: [] },
        { type: "citation", sourceId: SRC, locator: "str. 12" },
      ],
    },
  ],
  sources: [book],
});
const encode = (value: unknown) => new TextEncoder().encode(canonicalizeJcs(value));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `make(padding)` with the padding chosen so its JCS is exactly `size` bytes. */
function ofSize(make: (text: string) => unknown, size: number) {
  const pad = size - encode(make("")).byteLength;
  return make("x".repeat(pad));
}

describe("verifyVersionedDocumentSnapshot", () => {
  it.each([
    ["v1", REVISION_ZERO_JCS, REVISION_ZERO_SHA256, 1],
    ["v2", REVISION_ZERO_V2_JCS, REVISION_ZERO_V2_SHA256, 2],
  ])("accepts the %s revision 0 with the hash of its golden vector", async (_, jcs, hash, v) => {
    const result = await verifyVersionedDocumentSnapshot(new TextEncoder().encode(jcs));
    expect(result).toMatchObject({ ok: true, text: jcs, sha256: hash });
    expect(result.ok && result.document.schemaVersion).toBe(v);
  });

  it.each([
    ["v1", v1("Izmišljeni odlomak.")],
    ["v2 with a source and a citation", v2("Izmišljeni odlomak.")],
  ])("accepts a %s document, unchanged and hashed over the received bytes", async (_, doc) => {
    const bytes = encode(doc);
    const result = await verifyVersionedDocumentSnapshot(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(canonicalizeJcs(doc));
    expect(canonicalizeJcs(result.document)).toBe(canonicalizeJcs(doc));
    expect(result.sha256).toBe(sha256(bytes));
  });

  it.each([
    ["v1 at the top", { ...v1("a"), extra: 1 }],
    ["v1 with sources", { ...v1("a"), sources: [] }],
    ["v2 at the top", { ...v2("a"), extra: 1 }],
    ["v2 in a source", { ...v2("a"), sources: [{ ...book, note: "x" }] }],
    [
      "v2 in a citation",
      {
        ...v2("a"),
        nodes: [
          {
            type: "paragraph",
            id: P,
            children: [{ type: "citation", sourceId: SRC, marks: [] }],
          },
        ],
      },
    ],
  ])("refuses an unknown field (%s) as invalid", async (_, doc) => {
    expect(await verifyVersionedDocumentSnapshot(encode(doc))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it.each([
    ["v2 without sources", { schemaVersion: 2, nodes: v1("a").nodes }],
    ["schemaVersion 3", { ...v2("a"), schemaVersion: 3 }],
    ['schemaVersion "2"', { ...v2("a"), schemaVersion: "2" }],
  ])("refuses %s as invalid", async (_, doc) => {
    expect(await verifyVersionedDocumentSnapshot(encode(doc))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a v2 document whose bytes are not JCS", async () => {
    const pretty = new TextEncoder().encode(JSON.stringify(v2("a"), null, 1));
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(v2("a"))]);
    for (const bytes of [pretty, bom]) {
      expect(await verifyVersionedDocumentSnapshot(bytes)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it.each([
    ["v1", v1],
    ["v2", v2],
  ])(
    "accepts a %s document of exactly 2 MiB and refuses one byte more as too large",
    async (_, make) => {
      const atLimit = encode(ofSize(make, MAX_DOCUMENT_SNAPSHOT_BYTES));
      expect(atLimit.byteLength).toBe(MAX_DOCUMENT_SNAPSHOT_BYTES);
      expect((await verifyVersionedDocumentSnapshot(atLimit)).ok).toBe(true);
      const over = encode(ofSize(make, MAX_DOCUMENT_SNAPSHOT_BYTES + 1));
      expect(over.byteLength).toBe(MAX_DOCUMENT_SNAPSHOT_BYTES + 1);
      expect(await verifyVersionedDocumentSnapshot(over)).toEqual({
        ok: false,
        reason: "too_large",
      });
    },
  );

  it("leaves verifyDocumentSnapshot at v1, for the readers that do not show citations yet", async () => {
    expect(await verifyDocumentSnapshot(encode(v2("a")))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await verifyDocumentSnapshot(encode(v1("a")))).ok).toBe(true);
  });
});
