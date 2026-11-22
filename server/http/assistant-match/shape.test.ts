// SRV-1230, P-1 rule 13 and C-6: the answers of the match with the assistant hold
// ids and the length of a run, never a text, and no wording that says anything
// was copied. All values are invented.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

describe("assistant match contract", () => {
  const get = ROUTES.find((route) => route.id === "work.assistant-match.get")!;
  const post = ROUTES.find((route) => route.id === "work.assistant-match.post")!;

  it("the answers hold no text of the segment or of the answer", () => {
    const text = JSON.stringify([get.responses, post.responses]);
    expect(text).not.toMatch(/"(text|content|quote|excerpt|snippet)"/i);
    expect(text).not.toMatch(/prepisan|copied|plagij|cheat/i);
  });

  it("the findings have the reference, the ids, the run and two instants only", () => {
    const body = get.responses[0]!.body as unknown as {
      properties: { findings: { items: { properties: object } } };
    };
    expect(Object.keys(body.properties.findings.items.properties).sort()).toEqual([
      "attachedAt",
      "conversationId",
      "messageId",
      "recordedAt",
      "runWords",
      "segmentRef",
    ]);
  });

  it("the run is at least 8 words", () => {
    expect(JSON.stringify(get.responses[0]!.body)).toContain('"minimum":8');
    expect(JSON.stringify(post.responses[0]!.body)).toContain('"minimum":8');
  });

  it("only the owner writes", () => expect(post.access).toBe("student_owner"));
});
