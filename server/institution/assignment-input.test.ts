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

const CONTENT = {
  title: "Izmišljeni zadatak",
  instructions: "Izmišljene upute.",
  workType: "essay",
  opensAt: "2026-12-01T08:00:00Z",
  dueAt: "2026-12-15T22:00:00+01:00",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: null,
  wordMax: 3000,
};

const withoutWordMin: Record<string, unknown> = { ...CONTENT };
delete withoutWordMin.wordMin;

it.each<[string, unknown]>([
  ["no expectedVersion", CONTENT],
  ["expectedVersion 0", { expectedVersion: 0, ...CONTENT }],
  ["expectedVersion past int4", { expectedVersion: 2_147_483_648, ...CONTENT }],
  ["expectedVersion as text", { expectedVersion: "2", ...CONTENT }],
  ["a word bound left out", { expectedVersion: 2, ...withoutWordMin }],
  ["wordMin above wordMax", { expectedVersion: 2, ...CONTENT, wordMin: 3001 }],
  ["a purpose under prohibited", { expectedVersion: 2, ...CONTENT, aiPolicy: "prohibited" }],
  [
    "a repeated purpose",
    { expectedVersion: 2, ...CONTENT, aiPurposes: ["proofreading", "proofreading"] },
  ],
  ["February 30", { expectedVersion: 2, ...CONTENT, dueAt: "2026-02-30T12:00:00Z" }],
  ["year 0999 in UTC", { expectedVersion: 2, ...CONTENT, opensAt: "1000-01-01T00:30:00+01:00" }],
  ["a NUL in the title", { expectedVersion: 2, ...CONTENT, title: "a\u0000b" }],
  ["201 code points of title", { expectedVersion: 2, ...CONTENT, title: "😀".repeat(201) }],
  ["an extra key", { expectedVersion: 2, ...CONTENT, courseId: "x" }],
  ["an array", [CONTENT]],
])("version body refuses %s", (_, value) => {
  expect(parseAssignmentVersionBody(value)).toBeNull();
});

it("accepts a 200-code-point title and both word bounds null in a version", () => {
  const body = { expectedVersion: 1, ...CONTENT, title: "\u{1F600}".repeat(200), wordMax: null };
  expect(parseAssignmentVersionBody(body)).not.toBeNull();
});
