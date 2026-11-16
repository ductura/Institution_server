// DAN-803 collaboration.revision-requests.post: 409 is both an answer (a stale
// counter, {outcome: "conflict", …}) and an error (not_allowed). The client
// and the published document keep the two apart (Ductus#1836 c.6908963345 t. 6).
import { describe, expect, it } from "vitest";

import { openapiDocument } from "../../scripts/index.ts";
import { createClient } from "./generated/index.ts";

const answer = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const withdraw = (fetchImpl: typeof fetch) =>
  createClient("https://ductura.example.invalid", fetchImpl)(
    "collaboration.revision-requests.post",
    {
      params: { action: "withdraw" },
      query: undefined,
      body: { expectedSeq: 1, requestId: "8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c01" },
    },
  );

describe("409 of revision requests", () => {
  it("a stale counter is an answer with the current state", async () => {
    const state = { outcome: "conflict", row_seq: 3, version: 1, state: "responded" };
    expect(await withdraw(answer(409, state))).toMatchObject({
      ok: true,
      status: 409,
      body: state,
    });
  });

  it("a transition the state does not allow is the error not_allowed", async () => {
    const res = await withdraw(answer(409, { error: "not_allowed", code: "not_allowed" }));
    expect(res).toEqual({ ok: false, status: 409, code: "not_allowed" });
  });

  it("the published 409 holds both: the answer and the error, as an anyOf", () => {
    type Node = { [key: string]: Node } & { anyOf?: Node[] };
    const doc = openapiDocument() as unknown as Node;
    const schema = doc["paths"]?.["/api/v1/revision-requests/{action}"]?.["post"]?.["responses"]?.[
      "409"
    ]?.["content"]?.["application/json"]?.["schema"] as Node;
    expect(schema.anyOf).toHaveLength(2);
    expect(schema.anyOf?.[0]?.["properties"]?.["outcome"]).toMatchObject({ const: "conflict" });
    expect(schema.anyOf?.[1]?.["properties"]?.["error"]).toMatchObject({ const: "not_allowed" });
  });
});
