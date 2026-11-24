// SRV-0910, P-1 rule 4: the composition answer holds only the closed list of
// kinds and their shares: no key, no speed, no derived measure. All values are
// invented.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

describe("origin composition contract", () => {
  const route = ROUTES.find((candidate) => candidate.id === "work.origin-composition.get")!;
  const body = route.responses[0]!.body!;

  it("has one property, the parts, with a closed kind and a share", () => {
    expect(Object.keys((body as unknown as { properties: object }).properties)).toEqual(["parts"]);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(
      /keycode|keystroke|\bkeys?\b|speed|wpm|average|median|velocity|profile|stddev|variance/i,
    );
    for (const kind of [
      "typed",
      "assistant_inserted",
      "assistant_match",
      "imported_file",
      "pasted_known",
      "pasted_unknown",
    ]) {
      expect(text).toContain(`"const":"${kind}"`);
    }
  });

  it("gives the ranges the same closed kinds and nothing about typing", () => {
    const segments = ROUTES.find((candidate) => candidate.id === "work.origin-segments.get")!;
    const answer = segments.responses[0]!.body! as unknown as {
      properties: { segments: { items: { properties: object } } };
    };
    expect(Object.keys(answer.properties)).toEqual(["revision", "segments"]);
    expect(Object.keys(answer.properties.segments.items.properties)).toEqual([
      "blockId",
      "start",
      "end",
      "kind",
      "segmentRef",
    ]);
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(
      /keycode|keystroke|\bkeys?\b|speed|wpm|average|median|velocity|profile|stddev|variance|author/i,
    );
    expect(text).toContain(`"const":"pasted_unknown"`);
  });
});
