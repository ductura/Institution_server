import { describe, expect, it } from "vitest";

import { MAX_PARAGRAPH_CODE_POINTS, canonicalUuid, parseParagraph } from "./request.ts";

describe("parseParagraph (Z9, Z10)", () => {
  it("normalises to NFC before counting", () => {
    // 2 × limit code points in NFD, exactly the limit in NFC.
    const nfd = "š".repeat(MAX_PARAGRAPH_CODE_POINTS);
    expect(parseParagraph(nfd)).toEqual({ ok: true, text: "š".repeat(MAX_PARAGRAPH_CODE_POINTS) });
    expect(parseParagraph(`${nfd}š`)).toEqual({ ok: false, rule: "paragraph_too_long" });
  });

  it("counts code points, not UTF-16 units", () => {
    expect(parseParagraph("𝔸".repeat(MAX_PARAGRAPH_CODE_POINTS)).ok).toBe(true);
    expect(parseParagraph("𝔸".repeat(MAX_PARAGRAPH_CODE_POINTS + 1))).toEqual({
      ok: false,
      rule: "paragraph_too_long",
    });
  });

  it("keeps a well-formed surrogate pair and emoji sequences", () => {
    expect(parseParagraph("Odlomak 😀 i 👩‍🎓.").ok).toBe(true);
  });

  it("refuses every C0 except tab and line feed, DEL and every C1", () => {
    for (let code = 0; code <= 0x9f; code += 1) {
      const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      if (!isControl) continue;
      const result = parseParagraph(`a${String.fromCharCode(code)}b`);
      if (code === 0x09 || code === 0x0a) expect(result.ok, code.toString(16)).toBe(true);
      else expect(result, code.toString(16)).toEqual({ ok: false, rule: "paragraph_control" });
    }
  });

  it("refuses a non-string", () => {
    for (const value of [null, undefined, 1, ["a"], { text: "a" }])
      expect(parseParagraph(value)).toEqual({ ok: false, rule: "paragraph_not_string" });
  });
});

describe("canonicalUuid", () => {
  it("lower-cases a UUID and refuses anything else", () => {
    expect(canonicalUuid("3F0C2A9E-6B1D-4C8E-9A7F-1E2D3C4B5A69")).toBe(
      "3f0c2a9e-6b1d-4c8e-9a7f-1e2d3c4b5a69",
    );
    for (const bad of [
      "",
      "3f0c2a9e6b1d4c8e9a7f1e2d3c4b5a69",
      " 3f0c2a9e-6b1d-4c8e-9a7f-1e2d3c4b5a69",
      1,
      null,
    ])
      expect(canonicalUuid(bad)).toBeNull();
  });
});
