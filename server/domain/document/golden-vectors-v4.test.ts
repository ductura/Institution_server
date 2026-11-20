import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { jcsUtf8Bytes } from "../forensics/index.ts";
import { validateDocumentV4 } from "./validate-v4.ts";

// Golden vectors of document v4 (docs/contracts/document-schema-v4.md §12,
// class 60; SRV-10A). Derived outside this code; compared as written, never
// regenerated from the code under test.

type Accepted = { name: string; value: unknown; utf8Hex: string; sha256: string };
type Rejected = { name: string; value: unknown; errors: [string, string][] };

const VECTORS = (() => {
  const bytes = readFileSync(new URL("./golden-vectors-v4.json", import.meta.url));
  if (bytes.some((byte) => byte > 0x7e || byte === 0x0d))
    throw new Error("vectors must be ASCII with LF");
  return JSON.parse(bytes.toString("latin1")) as {
    documentsV4: Accepted[];
    rejectedDocumentsV4: Rejected[];
  };
})();

describe("golden vectors of document v4", () => {
  it.each(VECTORS.documentsV4)("$name is accepted with the same bytes and hash", (vector) => {
    const bytes = Buffer.from(vector.utf8Hex, "hex");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    const outcome = validateDocumentV4(vector.value);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Buffer.from(jcsUtf8Bytes(outcome.doc)).toString("hex")).toBe(vector.utf8Hex);
    }
    // The bytes themselves parse back to a document with the same JCS.
    const reparsed = validateDocumentV4(JSON.parse(bytes.toString("utf8")));
    expect(reparsed.ok && Buffer.from(jcsUtf8Bytes(reparsed.doc)).toString("hex")).toBe(
      vector.utf8Hex,
    );
  });

  it.each(VECTORS.rejectedDocumentsV4)("$name is refused with exactly its errors", (vector) => {
    const outcome = validateDocumentV4(vector.value);
    expect(outcome.ok ? [] : outcome.errors.map((error) => [error.path, error.code])).toEqual(
      vector.errors,
    );
  });

  it("covers every v4 block type and every v4 mark", () => {
    const text = JSON.stringify(VECTORS.documentsV4[0]!.value);
    for (const type of ["table", "image", "formula", "codeBlock", "box", "pageBreak"]) {
      expect(text).toContain(`"type":"${type}"`);
    }
    for (const mark of ["sup", "highlight", "lang", "link", "paste", "imported"]) {
      expect(text).toContain(mark);
    }
  });
});
