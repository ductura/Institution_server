// DAN-803 live.document.put answers 409 {outcome: "conflict", token}: a state,
// not an error, which the caller needs to retry. The generated client returns
// a listed status as an answer unless its body is a problem body, because the
// same status can also be an error (Ductus#1836 c.6908963345, point 6).
import { describe, expect, it } from "vitest";

import { createClient } from "./generated/index.ts";

const answer = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const put = (fetchImpl: typeof fetch) =>
  createClient("https://ductura.example.invalid", fetchImpl)("live.document.put", {
    params: { documentId: "izmisljeni-rad-0001" },
    query: undefined,
    body: { type: "doc" },
  });

describe("a status listed as an answer at 400 or above", () => {
  it("409 with the state is ok, with its body", async () => {
    const res = await put(answer(409, { outcome: "conflict", token: null }));
    expect(res).toMatchObject({
      ok: true,
      status: 409,
      body: { outcome: "conflict", token: null },
    });
  });

  it("a problem body on the same status is still an error", async () => {
    const res = await put(answer(409, { error: "conflict", code: "conflict" }));
    expect(res).toEqual({ ok: false, status: 409, code: "unexpected" });
  });

  it("a status not listed stays an error, and 428 keeps its code", async () => {
    expect(await put(answer(428, { error: "precondition_required" }))).toEqual({
      ok: false,
      status: 428,
      code: "precondition_required",
    });
  });
});
