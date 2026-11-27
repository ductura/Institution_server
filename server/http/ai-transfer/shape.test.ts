// SRV-1809 (Ductus#2059 c.7208831876): the transfer from an answer of the
// assistant is written by the owner of the work only, the client sends the
// answer and the text and nothing the server derives (provider, model,
// purpose, phase), and the answer holds the record with the hash of the text,
// never the text.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

describe("ai transfer contract", () => {
  const post = ROUTES.find((route) => route.id === "work.ai-transfer.post")!;
  const created = post.responses.find((response) => response.status === 201)!;
  type Closed = { properties: Record<string, unknown>; additionalProperties?: boolean };

  it("only the owner writes, with the answer and the text and nothing else", () => {
    expect(post.access).toBe("student_owner");
    const body = post.request.body as unknown as Closed;
    expect(Object.keys(body.properties).sort()).toEqual(["responseId", "text"]);
    expect(body.additionalProperties).toBe(false);
    expect(JSON.stringify(body.properties.text)).toContain('"maxLength":40000');
  });

  it("the answer is the id, the hash and the record, and the record holds no text", () => {
    const body = created.body as unknown as Closed & {
      properties: { record: Closed };
    };
    expect(Object.keys(body.properties).sort()).toEqual([
      "aiTransferId",
      "aiTransferSha256",
      "record",
    ]);
    const record = Object.keys(body.properties.record.properties);
    expect(record).toContain("textSha256");
    expect(record.filter((key) => /^(text|content|quote|excerpt)$/i.test(key))).toEqual([]);
  });
});
