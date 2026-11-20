import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs, jcsUtf8Bytes } from "../forensics/index.ts";
import {
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_SHA256,
  REVISION_ZERO_V3_JCS,
  REVISION_ZERO_V3_SHA256,
  revisionZeroDocumentV3,
} from "./revision-zero.ts";
import { contentEqual, documentsEqual } from "./equality.ts";
import { normalizeDocument } from "./normalize.ts";
import type { CanonicalDocumentV3, NodeId } from "./schema.ts";
import { verifyVersionedDocumentSnapshot } from "./snapshot.ts";
import { validateDocument, validateVersionedDocument } from "./validate.ts";
import { documentWordCount } from "./word-count.ts";

// Document v3 (docs/contracts/document-schema-v3.md, SRV-7A). The vectors
// and the revision 0 hex were derived outside this code and are compared as
// written, never recomputed into the expected value.

type Accepted = { name: string; value: unknown; utf8Hex: string; sha256: string };
type Rejected = { name: string; value: unknown; errors: [string, string][] };

const VECTORS = (() => {
  const bytes = readFileSync(new URL("./golden-vectors-v3.json", import.meta.url));
  if (bytes.some((byte) => byte > 0x7e || byte === 0x0d))
    throw new Error("vectors must be ASCII with LF");
  return JSON.parse(bytes.toString("latin1")) as {
    documentsV3: Accepted[];
    rejectedDocumentsV3: Rejected[];
  };
})();

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P = "11111111-1111-4111-8111-111111111111";

const para = (...children: unknown[]) => ({
  schemaVersion: 3,
  sources: [],
  nodes: [{ type: "paragraph", id: P, children }],
});
const errorsOf = (doc: unknown) => {
  const outcome = validateVersionedDocument(doc);
  return outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code]);
};
const at = (field: string, code: string) => [[`$.nodes[0].children[0]${field}`, code]];

describe("revision 0 of document v3 (§6, class 40)", () => {
  const text =
    '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":3,"sources":[]}';
  const sha256 = "b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141";

  it("has these exact JCS bytes and this SHA-256, and v1 and v2 keep their own", () => {
    expect(canonicalizeJcs(revisionZeroDocumentV3())).toBe(text);
    expect(REVISION_ZERO_V3_JCS).toBe(text);
    const bytes = jcsUtf8Bytes(revisionZeroDocumentV3());
    expect(bytes.byteLength).toBe(121);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    expect(REVISION_ZERO_V3_SHA256).toBe(sha256);
    expect(REVISION_ZERO_SHA256).toBe(
      "a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b",
    );
    expect(REVISION_ZERO_V2_SHA256).toBe(
      "8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618",
    );
  });

  it("is valid as v3 only: returned unchanged, refused by the v1 view", () => {
    expect(validateVersionedDocument(JSON.parse(text))).toEqual({
      ok: true,
      doc: revisionZeroDocumentV3(),
    });
    expect(validateDocument(JSON.parse(text)).ok).toBe(false);
  });
});

describe("golden vectors of document v3", () => {
  it.each(VECTORS.documentsV3)("$name is accepted with the same bytes and hash", async (vector) => {
    const bytes = Buffer.from(vector.utf8Hex, "hex");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    const outcome = validateVersionedDocument(vector.value);
    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(Buffer.from(jcsUtf8Bytes(outcome.doc)).toString("hex")).toBe(vector.utf8Hex);
    // The snapshot path of the commit takes the same bytes (contract v3 §7).
    const snapshot = await verifyVersionedDocumentSnapshot(new Uint8Array(bytes));
    expect(snapshot.ok && snapshot.sha256).toBe(vector.sha256);
  });

  it.each(VECTORS.rejectedDocumentsV3)("$name is refused with exactly its errors", (vector) => {
    expect(errorsOf(vector.value)).toEqual(vector.errors);
  });
});

describe("classes 32 to 39 of contract v3 §10", () => {
  it("32: v3 has the closed top level of v2; other versions are not v3", () => {
    expect(
      errorsOf({ schemaVersion: 3, nodes: [{ type: "paragraph", id: P, children: [] }] }),
    ).toEqual([["$.sources", "SOURCES_NOT_ARRAY"]]);
    for (const version of ["3", 3.5, 4]) {
      expect(errorsOf({ ...para(), schemaVersion: version })).toContainEqual([
        "$.schemaVersion",
        "SCHEMA_VERSION_INVALID",
      ]);
    }
  });

  it("34: via is tidy text of 1 to 200 code points", () => {
    const citation = (via: unknown) => para({ type: "citation", sourceId: A, via });
    for (const via of ["v", "v".repeat(200), "😀".repeat(200), "Izmišljeni, 1973"]) {
      expect(errorsOf(citation(via)), via).toEqual([]);
    }
    for (const via of ["", "v".repeat(201), " a", "a ", "a​b", "a\nb", 1973, null]) {
      expect(errorsOf(citation(via)), JSON.stringify(via)).toEqual(
        at(".via", "CITATION_VIA_INVALID"),
      );
    }
  });

  it("35: rq is a lowercase UUID v4 and nothing else", () => {
    expect(errorsOf(para({ type: "citation", sourceId: A, rq: C }))).toEqual([]);
    for (const rq of [
      C.toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
      "cccccccc-cccc-1ccc-8ccc-cccccccccccc",
      "rqabc123",
      "",
      1,
    ]) {
      expect(errorsOf(para({ type: "citation", sourceId: A, rq })), String(rq)).toEqual(
        at(".rq", "CITATION_REQUEST_INVALID"),
      );
    }
  });

  it("36: a footnote is tidy plain text of 1 to 2000 code points, without other fields", () => {
    for (const text of ["x", "f".repeat(2000), "😀".repeat(2000)]) {
      expect(errorsOf(para({ type: "footnote", text }))).toEqual([]);
    }
    for (const text of [undefined, "", "f".repeat(2001), " x", "x ", "a\nb", "a\tb", "\ud800"]) {
      const footnote = text === undefined ? { type: "footnote" } : { type: "footnote", text };
      expect(errorsOf(para(footnote)), JSON.stringify(text)).toEqual(
        at(".text", "FOOTNOTE_TEXT_INVALID"),
      );
    }
    for (const field of ["marks", "id", "children"]) {
      expect(errorsOf(para({ type: "footnote", text: "x", [field]: [] }))).toEqual(
        at(`.${field}`, "UNKNOWN_FIELD"),
      );
    }
  });

  it("37: a cross reference holds only a lowercase UUID v4 target", () => {
    for (const targetId of [
      undefined,
      B.toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
      7,
    ]) {
      const reference =
        targetId === undefined ? { type: "crossReference" } : { type: "crossReference", targetId };
      expect(errorsOf(para(reference))).toEqual(at(".targetId", "CROSS_REFERENCE_TARGET_INVALID"));
    }
    expect(errorsOf(para({ type: "crossReference", targetId: B, text: "poglavlje 1" }))).toEqual(
      at(".text", "UNKNOWN_FIELD"),
    );
  });

  it("39: orphans, neighbouring atoms and a block of atoms only are valid and unchanged", () => {
    const doc = para(
      { type: "text", text: "a", marks: ["italic"] },
      { type: "crossReference", targetId: B },
      { type: "footnote", text: "x" },
      { type: "citation", sourceId: A, rq: C },
      { type: "text", text: "b", marks: ["italic"] },
    );
    const outcome = validateVersionedDocument(doc);
    expect(outcome).toEqual({ ok: true, doc });
    expect(validateVersionedDocument(para({ type: "footnote", text: "x" })).ok).toBe(true);
  });

  it("an atom adds no word and separates the text on its two sides (§8)", () => {
    const doc = para(
      { type: "text", text: "Prva", marks: [] },
      { type: "footnote", text: "Ove riječi se ne broje." },
      { type: "text", text: "riječ", marks: [] },
      { type: "crossReference", targetId: B },
    );
    const outcome = validateVersionedDocument(doc);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(documentWordCount(outcome.doc)).toBe(2);
  });
});

describe("consumers of document v3 (§8, class 45)", () => {
  const every = () =>
    structuredClone(
      VECTORS.documentsV3.find((v) => v.name === "v3-every-atom")!.value,
    ) as CanonicalDocumentV3;
  const firstParagraph = (doc: CanonicalDocumentV3) =>
    doc.nodes[1] as Extract<CanonicalDocumentV3["nodes"][number], { type: "paragraph" }>;

  it("normalizeDocument keeps v3, the sources and every atom byte-equal", () => {
    const doc = every();
    const normalized = normalizeDocument(doc);
    expect(canonicalizeJcs(normalized)).toBe(canonicalizeJcs(doc));
    expect(normalized.sources).not.toBe(doc.sources);
  });

  it("normalizeDocument never merges text across an atom", () => {
    const doc = para(
      { type: "text", text: "a", marks: [] },
      { type: "footnote", text: "x" },
      { type: "text", text: "b", marks: [] },
    ) as unknown as CanonicalDocumentV3;
    expect(normalizeDocument(doc)).toEqual(doc);
  });

  it("an atom equals only an atom of the same type with the same fields", () => {
    expect(documentsEqual(every(), every())).toBe(true);
    const changes: ((doc: CanonicalDocumentV3) => void)[] = [
      (doc) => Object.assign(firstParagraph(doc).children[1]!, { via: "Druga, 1980" }),
      (doc) => delete (firstParagraph(doc).children[1] as { rq?: string }).rq,
      (doc) => Object.assign(firstParagraph(doc).children[3]!, { text: "Drugo objašnjenje." }),
      (doc) => Object.assign(firstParagraph(doc).children[5]!, { targetId: P }),
      (doc) =>
        (firstParagraph(doc).children[3] = { type: "crossReference", targetId: B as NodeId }),
      (doc) => doc.sources.pop(),
    ];
    for (const change of changes) {
      const other = every();
      change(other);
      expect(documentsEqual(every(), other)).toBe(false);
      expect(contentEqual(every(), other)).toBe(false);
    }
    const asV2 = { ...every(), schemaVersion: 2 } as unknown as CanonicalDocumentV3;
    expect(documentsEqual(every(), asV2)).toBe(false);
  });
});
