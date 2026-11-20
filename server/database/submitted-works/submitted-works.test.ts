// SRV-1109: the rows of app.fast_path_works as the sources of the Merlin
// package. All names, texts and ids are invented.
import { describe, expect, it } from "vitest";

import { sourceOf } from "./index.ts";

const S = "00000000-0000-4000-8000-0000000000e1";

describe("sourceOf", () => {
  const row = {
    student_id: S,
    given_name: "Demo",
    family_name: "Anić",
    document_id: "rad-izmisljeni-1",
    submitted: true,
    revision: "7",
    body: "{}",
  };

  it("reads a work row and a row without a work", () => {
    expect(sourceOf(row)).toEqual({
      studentId: S,
      givenName: "Demo",
      familyName: "Anić",
      work: { documentId: "rad-izmisljeni-1", submitted: true, revision: 7, body: "{}" },
    });
    expect(
      sourceOf({ ...row, document_id: null, submitted: null, revision: null, body: null }),
    ).toEqual({ studentId: S, givenName: "Demo", familyName: "Anić", work: null });
  });

  it.each([
    ["an upper-case id", { student_id: S.toUpperCase() }],
    ["half a name pair", { given_name: null }],
    ["a revision that is not a number", { revision: "x" }],
    ["a missing text", { body: null }],
    ["a submission flag that is not a boolean", { submitted: "true" }],
    ["fields without a work", { document_id: null }],
  ])("throws on %s", (_, change) => {
    expect(() => sourceOf({ ...row, ...change })).toThrow();
  });
});
