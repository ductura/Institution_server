import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../forensics/index.ts";
import {
  REVISION_ZERO_V3_SHA256,
  REVISION_ZERO_V4_JCS,
  REVISION_ZERO_V4_SHA256,
  revisionZeroDocumentV4,
} from "./revision-zero.ts";
import { MARK_V4_ORDER } from "./schema.ts";
import { validateVersionedDocument, type ValidationError } from "./validate.ts";
import { marksV4Key, validateMarksV4 } from "./validate-marks-v4.ts";

// Document v4, marks and revision 0 (docs/contracts/document-schema-v4.md §3
// and §10; SRV-10A). Synthetic data only. The revision 0 hex is the
// contract's, compared as written, never recomputed into the expected value.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const run = (marks: unknown[]) => {
  const errors: ValidationError[] = [];
  const result = validateMarksV4(marks, "$.m", errors);
  return { result, errors: errors.map((error) => [error.path, error.code]) };
};
const errorsOf = (marks: unknown[]) => run(marks).errors;
const accepts = (marks: unknown[]) => expect(run(marks)).toEqual({ result: marks, errors: [] });

describe("revision 0 of document v4 (§10, class 60)", () => {
  it("has the contract's JCS bytes and SHA-256 and differs from v3", () => {
    const jcs =
      '{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":4,"sources":[]}';
    const sha256 = "52da86d9b1344b46cf3028d3cf891bbc78a70a860b4c4e481c792a77b66557d5";
    expect(canonicalizeJcs(revisionZeroDocumentV4())).toBe(jcs);
    expect(REVISION_ZERO_V4_JCS).toBe(jcs);
    expect(REVISION_ZERO_V4_SHA256).toBe(sha256);
    expect(createHash("sha256").update(jcs, "utf8").digest("hex")).toBe(sha256);
    expect(sha256).not.toBe(REVISION_ZERO_V3_SHA256);
  });

  it("is not yet accepted by validateVersionedDocument (§11)", () => {
    const outcome = validateVersionedDocument(revisionZeroDocumentV4());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? [] : outcome.errors).toContainEqual({
      path: "$.schemaVersion",
      code: "SCHEMA_VERSION_INVALID",
    });
  });
});

describe("marks (§3, classes 48 and 49)", () => {
  const all = [
    "bold",
    "italic",
    "sup",
    { color: "#f2d24b", type: "highlight" },
    { lang: "en", type: "lang" },
    { href: "https://primjer.invalid/a?b=1", type: "link" },
    { pasteId: A, sourceId: B, type: "paste" },
    "imported",
  ];

  it("accepts every mark but sub together, in canonical order", () => {
    expect(MARK_V4_ORDER).toEqual([
      "bold",
      "italic",
      "sup",
      "sub",
      "highlight",
      "lang",
      "link",
      "paste",
      "imported",
    ]);
    accepts(all);
    accepts([]);
    accepts(["sub"]);
    accepts([{ lang: "und", type: "lang" }]);
    accepts([{ href: "mailto:netko@primjer.invalid", type: "link" }]);
    accepts([{ pasteId: A, type: "paste" }]);
  });

  it("copies an object mark with sorted keys, not the input object", () => {
    const input = { type: "paste", sourceId: B, pasteId: A };
    const { result } = run([input]);
    expect(result).toEqual([input]);
    expect(result![0]).not.toBe(input);
    expect(Object.keys(result![0] as object)).toEqual(["pasteId", "sourceId", "type"]);
  });

  it("refuses sup with sub, a repeated type, the wrong order and the wrong form", () => {
    expect(errorsOf(["sup", "sub"])).toEqual([["$.m", "MARKS_EXCLUSIVE"]]);
    expect(
      errorsOf([
        { lang: "en", type: "lang" },
        { lang: "de", type: "lang" },
      ]),
    ).toEqual([["$.m[1]", "MARKS_DUPLICATE"]]);
    expect(errorsOf(["bold", "bold"])).toEqual([["$.m[1]", "MARKS_DUPLICATE"]]);
    expect(errorsOf(["imported", "bold"])).toEqual([["$.m", "MARKS_UNSORTED"]]);
    expect(errorsOf([{ lang: "en", type: "lang" }, "sup"])).toEqual([["$.m", "MARKS_UNSORTED"]]);
    for (const bad of [{ type: "bold" }, "lang", "paste", "aitext", "Bold", 1, null, ["bold"]]) {
      expect(errorsOf([bad])).toEqual([["$.m[0]", "MARK_INVALID"]]);
    }
    expect(errorsOf([{ lang: "en", type: "lang", l: "en" }])).toEqual([
      ["$.m[0].l", "UNKNOWN_FIELD"],
    ]);
  });

  it("refuses an invalid or missing attribute with MARK_ATTRIBUTE_INVALID (class 49)", () => {
    const typeOf: Record<string, string> = {
      color: "highlight",
      lang: "lang",
      href: "link",
      pasteId: "paste",
      sourceId: "paste",
    };
    const bad: [string, unknown][] = [
      ["color", "#F2D24B"],
      ["color", "#f2d24b80"],
      ["color", "f2d24b"],
      ["lang", "EN"],
      ["lang", "e"],
      ["lang", "engl"],
      ["lang", "hr-HR"],
      ["href", "javascript:alert(1)"],
      ["href", "https://"],
      ["href", "https://primjer.invalid/a b"],
      ["href", `https://${"a".repeat(2041)}`],
      ["pasteId", "00000000-0000-0000-0000-000000000000"],
      ["pasteId", "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"],
      ["pasteId", A.toUpperCase()],
      ["sourceId", ""],
    ];
    for (const [key, value] of bad) {
      const mark = {
        ...(key === "sourceId" ? { pasteId: A } : {}),
        [key]: value,
        type: typeOf[key],
      };
      expect(errorsOf([mark])).toEqual([[`$.m[0].${key}`, "MARK_ATTRIBUTE_INVALID"]]);
    }
    expect(errorsOf([{ type: "link" }])).toEqual([["$.m[0].href", "MARK_ATTRIBUTE_INVALID"]]);
    expect(errorsOf([{ type: "paste" }])).toEqual([["$.m[0].pasteId", "MARK_ATTRIBUTE_INVALID"]]);
    accepts([{ href: `https://${"a".repeat(2040)}`, type: "link" }]);
  });

  it("gives equal keys exactly for equal marks with equal attributes (class 50)", () => {
    const lang = (value: string) => run([{ type: "lang", lang: value }]).result!;
    expect(marksV4Key(lang("en"))).toBe(marksV4Key(lang("en")));
    expect(marksV4Key(lang("en"))).not.toBe(marksV4Key(lang("de")));
    expect(marksV4Key(["bold"])).not.toBe(marksV4Key(["bold", "italic"]));
  });
});
