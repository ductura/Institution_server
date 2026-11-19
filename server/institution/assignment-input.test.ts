// The content of an assignment version (SRV-14): the port of Ductus
// parseAssignmentInput and the version body. All values are invented.
import { describe, expect, it } from "vitest";

import {
  isAssignmentVersion,
  parseAssignmentInput,
  parseAssignmentVersionBody,
} from "./assignment-input.ts";

const GOOD = {
  title: "Izmišljeni zadatak",
  instructions: "Izmišljene upute.",
  workType: "seminar_paper",
  opensAt: "2026-10-01T08:00:00+02:00",
  dueAt: "2027-01-31T23:59:00.123456Z",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading", "literature_search"],
  evidenceProfile: "basic",
  importAllowed: false,
};

describe("parseAssignmentInput", () => {
  it("takes exactly the content; absent word bounds are null", () => {
    expect(parseAssignmentInput(GOOD)).toEqual({ ...GOOD, wordMin: null, wordMax: null });
    expect(parseAssignmentInput({ ...GOOD, wordMin: 1500, wordMax: 2500 })).toMatchObject({
      wordMin: 1500,
      wordMax: 2500,
    });
  });

  it.each([
    ["an extra key", { ...GOOD, courseId: "x" }],
    ["a missing key", { ...GOOD, title: undefined }],
    ["an empty title", { ...GOOD, title: "" }],
    ["a NUL in the instructions", { ...GOOD, instructions: `a${String.fromCodePoint(0)}b` }],
    ["an unknown work type", { ...GOOD, workType: "poem" }],
    ["30 February", { ...GOOD, dueAt: "2027-02-30T10:00:00Z" }],
    ["a year before 1000", { ...GOOD, opensAt: "0999-12-31T10:00:00Z" }],
    ["a repeated purpose", { ...GOOD, aiPurposes: ["proofreading", "proofreading"] }],
    ["a purpose under a prohibited policy", { ...GOOD, aiPolicy: "prohibited" }],
    ["wordMin above wordMax", { ...GOOD, wordMin: 3000, wordMax: 2000 }],
    ["one word bound only, as a version", null],
  ])("refuses %s", (name, value) => {
    if (value === null) {
      expect(parseAssignmentInput({ ...GOOD, wordMin: 1 }, true)).toBeNull();
      return;
    }
    expect(parseAssignmentInput(value), name).toBeNull();
  });
});

describe("parseAssignmentVersionBody", () => {
  it("splits the expected version from the content; both word bounds must be named", () => {
    const body = { expectedVersion: 2, ...GOOD, wordMin: null, wordMax: 2500 };
    expect(parseAssignmentVersionBody(body)).toEqual({
      expectedVersion: 2,
      content: { ...GOOD, wordMin: null, wordMax: 2500 },
    });
    expect(parseAssignmentVersionBody({ expectedVersion: 2, ...GOOD })).toBeNull();
    expect(parseAssignmentVersionBody({ ...GOOD, wordMin: null, wordMax: null })).toBeNull();
    expect(parseAssignmentVersionBody([])).toBeNull();
  });

  it("a version is 1 to 2^31 - 1", () => {
    expect([0, 1, 2_147_483_647, 2_147_483_648, 1.5, "1"].map(isAssignmentVersion)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
