// SRV-1230, P-1 rule 13 and C-6: the answers of the match with the assistant hold
// ids and the length of a run, never a text, and no wording that says anything
// was copied. All values are invented.
// PIL-P1-PODUDARANJE-OBJASNJENJE-SRV: a finding also carries the student's own
// explanation ({text, writtenAt} or null); that text is the student's, never the
// segment's or the answer's, so it is the only text the answers hold.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

describe("assistant match contract", () => {
  const get = ROUTES.find((route) => route.id === "work.assistant-match.get")!;
  const post = ROUTES.find((route) => route.id === "work.assistant-match.post")!;
  const explain = ROUTES.find((route) => route.id === "work.assistant-match-explanation.post")!;
  type Finding = { properties: Record<string, unknown> };
  const finding = () =>
    (get.responses[0]!.body as unknown as { properties: { findings: { items: Finding } } })
      .properties.findings.items;

  it("the answers hold no text of the segment or of the answer", () => {
    const rest = Object.fromEntries(
      Object.entries(finding().properties).filter(([key]) => key !== "explanation"),
    );
    const text = JSON.stringify([rest, post.responses]);
    expect(text).not.toMatch(/"(text|content|quote|excerpt|snippet)"/i);
    const all = JSON.stringify([get, post, explain]);
    expect(all).not.toMatch(/prepisan|copied|plagij|cheat/i);
  });

  it("the explanation is the student's text and its time, or null, at most 2000 characters", () => {
    const explanation = JSON.stringify(finding().properties.explanation);
    expect(explanation).toContain('"maxLength":2000');
    expect(explanation).toContain('"type":"null"');
    const body = explain.responses[0]!.body as unknown as { properties: object };
    expect(Object.keys(body.properties).sort()).toEqual(["text", "writtenAt"]);
    expect(explain.responses[0]!.status).toBe(201);
    expect(explain.access).toBe("student_owner");
  });

  it("the findings have the reference, the ids, the run, two instants and the explanation only", () => {
    const body = get.responses[0]!.body as unknown as {
      properties: { findings: { items: { properties: object } } };
    };
    expect(Object.keys(body.properties.findings.items.properties).sort()).toEqual([
      "attachedAt",
      "conversationId",
      "explanation",
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
