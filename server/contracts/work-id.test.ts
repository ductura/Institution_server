import { describe, expect, it } from "vitest";

import { isWorkId, WORK_ID_MAX, workIdFromPath } from "./index.ts";

// Cases from docs/PLAN.md §6, "Pomoćne funkcije" (S-1H.1-c). Invented ids only.
describe("isWorkId", () => {
  it("accepts a valid id and a UUID as open_work makes it", () => {
    expect(isWorkId("doc-izmisljeni-1")).toBe(true);
    expect(isWorkId("6f1c2a9e-0b7d-4c1e-9a55-3d2e8f0b1a77")).toBe(true);
  });

  it("refuses an empty id and one of only whitespace", () => {
    expect(isWorkId("")).toBe(false);
    expect(isWorkId(" ")).toBe(false);
  });

  it("accepts exactly WORK_ID_MAX code points and refuses one more", () => {
    expect(isWorkId("d".repeat(WORK_ID_MAX))).toBe(true);
    expect(isWorkId("d".repeat(WORK_ID_MAX + 1))).toBe(false);
  });

  it("counts code points as the database does, not UTF-16 units", () => {
    // 256 emoji are 512 UTF-16 units but 256 characters in length(id).
    expect(isWorkId("😀".repeat(WORK_ID_MAX))).toBe(true);
    expect(isWorkId("😀".repeat(WORK_ID_MAX + 1))).toBe(false);
  });

  it("passes ' and ; as opaque data: the id only reaches SQL as a bound parameter", () => {
    expect(isWorkId("doc'1")).toBe(true);
    expect(isWorkId("doc';DROP TABLE x;--")).toBe(true);
  });

  it("refuses NUL and every other control character", () => {
    for (const value of ["doc\u0000", "a\tb", "a\nb", "a\u007fb", "a\u0085b", "a\u009fb"]) {
      expect(isWorkId(value)).toBe(false);
    }
  });

  it("treats a literal %00 as text, not as NUL", () => {
    expect(isWorkId("%00")).toBe(true);
  });

  it("passes ../ as opaque data, as the database CHECK does", () => {
    expect(isWorkId("../doc")).toBe(true);
    expect(isWorkId("../../etc")).toBe(true);
  });

  it("accepts Unicode letters and refuses a lone surrogate", () => {
    expect(isWorkId("rad-čćžšđ-ŽĆ")).toBe(true);
    expect(isWorkId("문서-1")).toBe(true);
    expect(isWorkId("doc\uD800")).toBe(false);
    expect(isWorkId("\uDC00doc")).toBe(false);
  });

  it("refuses leading or trailing whitespace, Unicode spaces included", () => {
    for (const value of [" doc", "doc ", " doc", "doc ", "　doc"]) {
      expect(isWorkId(value)).toBe(false);
    }
  });

  it("refuses anything that is not a string", () => {
    for (const value of [undefined, null, 7, 7n, true, {}, [], ["doc"]]) {
      expect(isWorkId(value)).toBe(false);
    }
  });
});

describe("workIdFromPath", () => {
  it("returns the decoded id", () => {
    expect(workIdFromPath("doc-izmisljeni-1")).toBe("doc-izmisljeni-1");
    expect(workIdFromPath("rad-%C4%8D")).toBe("rad-č");
  });

  it("refuses %00, which decodes to NUL", () => {
    expect(workIdFromPath("%00")).toBeNull();
    expect(workIdFromPath("doc%00")).toBeNull();
  });

  it("decodes once: %2500 is the literal text %00", () => {
    expect(workIdFromPath("%2500")).toBe("%00");
  });

  it("refuses an empty segment and broken encoding", () => {
    for (const segment of ["", "%", "%zz", "%C4", "%ED%A0%80"]) {
      expect(workIdFromPath(segment)).toBeNull();
    }
  });

  it("refuses a segment that decodes to edge whitespace or an over-long id", () => {
    expect(workIdFromPath("%20doc")).toBeNull();
    expect(workIdFromPath("d".repeat(WORK_ID_MAX + 1))).toBeNull();
  });

  it("passes '; and ../ through as data, like isWorkId", () => {
    expect(workIdFromPath("doc%27%3B")).toBe("doc';");
    expect(workIdFromPath("..%2Fdoc")).toBe("../doc");
  });
});
