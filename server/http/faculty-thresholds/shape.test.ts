// SRV-1111, P-1 rule 12: the comparison answers only three words per kind that
// has a threshold: no share, no number, no ranking. All values are invented.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

describe("work thresholds contract", () => {
  const route = ROUTES.find((candidate) => candidate.id === "work.origin-thresholds.get")!;
  const text = JSON.stringify(route.responses[0]!.body);

  it("holds a kind and one of three words, and nothing numeric", () => {
    for (const word of ["in_line", "for_review", "exceeded"]) {
      expect(text).toContain(`"const":"${word}"`);
    }
    expect(text).not.toMatch(/percent|share|score|rank|"type":"number"|"type":"integer"/i);
    expect(text).not.toMatch(/suspect|plagiar|cheat|fraud|guilty/i);
  });

  it("has no default thresholds: the faculty's list starts empty", () => {
    const read = ROUTES.find((candidate) => candidate.id === "institution.origin-thresholds.get")!;
    expect(JSON.stringify(read.responses[0]!.body)).not.toContain('"default"');
    expect(read.summary).toContain("empty list while the faculty has written none");
  });
});
