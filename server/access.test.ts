import { describe, expect, it } from "vitest";

import { canRead, canWrite, parseBearer } from "./access.ts";

describe("parseBearer", () => {
  it("reads the user ID and rejects malformed headers", () => {
    expect(parseBearer("Bearer Student-A@PRIMJER.invalid")).toBe("student-a@primjer.invalid");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});

describe("canRead", () => {
  it("allows the owner and a collaborator, nobody else", () => {
    const doc = { ownerId: "student-a", sharedWith: ["student-b"] };
    expect(canRead("student-a", doc)).toBe(true);
    expect(canRead("student-b", doc)).toBe(true);
    expect(canRead("student-c", doc)).toBe(false);
    expect(canRead(null, doc)).toBe(false);
  });
});

describe("canWrite", () => {
  it("allows the owner only", () => {
    const doc = { ownerId: "student-a", sharedWith: ["student-b"] };
    expect(canWrite("student-a", doc)).toBe(true);
    expect(canWrite("student-b", doc)).toBe(false);
  });
});
