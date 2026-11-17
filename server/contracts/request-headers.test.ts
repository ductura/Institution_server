import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { createClient } from "./generated/index.ts";
import { ROUTES } from "./index.ts";

// DAN-930-1: request headers a route does not answer without are in its
// contract, and the generated client sends them (ugovor Ductus#2028 c.6961819901).

const protocolOf = (headers: Readonly<Record<string, string>> = {}) =>
  Object.entries(headers).find(([name]) => name.toLowerCase() === "ductus-protocol")?.[1];

describe("ductus-protocol is declared exactly where every success vector carries it", () => {
  it.each(ROUTES.map((route) => [route.id, route] as const))("%s", (id, route) => {
    const success = VECTORS.filter((v) => v.route === id && v.response.status < 400);
    const carried = success.length > 0 && success.every((v) => protocolOf(v.request.headers));
    const declared = route.request.headers;
    expect(declared?.properties["ductus-protocol"] !== undefined).toBe(carried);
    if (declared === undefined) return;
    for (const name of Object.keys(declared.properties))
      expect(name).toMatch(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);
    for (const v of success) {
      const given = Object.fromEntries(
        Object.keys(declared.properties).map((name) => [name, v.request.headers?.[name]]),
      );
      expect(Value.Check(declared, given), v.name).toBe(true);
      // Closed (QA c.6963047958): one more header is refused.
      const extra = { ...given, cookie: "__Host-ductus_session=izmisljeno" };
      expect(Value.Check(declared, extra), v.name).toBe(false);
    }
    expect(declared.additionalProperties).toBe(false);
  });

  it("five routes declare it", () => {
    const ids = ROUTES.filter((r) => r.request.headers !== undefined).map((r) => r.id);
    expect(ids.sort()).toEqual([
      "evidence.commit.post",
      "evidence.open.post",
      "evidence.replay.post",
      "live.document.get",
      "submission.submit.post",
    ]);
  });
});

describe("the client sends the declared headers and nothing the caller adds", () => {
  const sent = async (baseUrl: string, headers: Record<string, unknown>) => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: URL, given?: RequestInit) => {
      init = given;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await createClient(baseUrl, fetchImpl)("evidence.open.post", {
      params: undefined,
      query: undefined,
      body: { assignmentId: "00000000-0000-4000-8000-000000000001" },
      headers: headers as never,
    });
    return init?.headers;
  };

  it("a plain object with content-type, the protocol and the origin of the base URL", async () => {
    expect(
      await sent("https://u:p@ductura.example.invalid:8443/a/b?c", { "ductus-protocol": "1" }),
    ).toEqual({
      "content-type": "application/json",
      "ductus-protocol": "1",
      origin: "https://ductura.example.invalid:8443",
    });
  });

  it.each([
    ["origin", "https://drugo.example.invalid"],
    ["Origin", "https://drugo.example.invalid"],
    ["content-type", "text/plain"],
    ["Ductus-Protocol", "2"],
    ["__proto__", "1"],
    ["toString", "1"],
    ["cookie", "__Host-ductus_session=izmisljeno"],
  ])("ignores %s from the caller", async (name, value) => {
    const given = Object.create(null) as Record<string, unknown>;
    given["ductus-protocol"] = "1";
    given[name] = value;
    expect(await sent("https://ductura.example.invalid", given)).toEqual({
      "content-type": "application/json",
      "ductus-protocol": "1",
      origin: "https://ductura.example.invalid",
    });
  });

  it.each([1, null, true, ["1"], { value: "1" }])(
    "a protocol that is not a string (%j) is not sent",
    async (value) => {
      expect(await sent("https://ductura.example.invalid", { "ductus-protocol": value })).toEqual({
        "content-type": "application/json",
        origin: "https://ductura.example.invalid",
      });
    },
  );

  it("an inherited protocol is not sent", async () => {
    const inherited = Object.create({ "ductus-protocol": "1" }) as Record<string, unknown>;
    expect(await sent("https://ductura.example.invalid", inherited)).toEqual({
      "content-type": "application/json",
      origin: "https://ductura.example.invalid",
    });
  });

  it("a GET without a body sends its headers too, and no origin it does not declare", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: URL, given?: RequestInit) => {
      init = given;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const call = createClient("https://ductura.example.invalid", fetchImpl);
    const input = {
      params: { documentId: "dokument-izmisljeni-1" },
      query: undefined,
      body: undefined,
    };
    await call("live.document.get", { ...input, headers: { "ductus-protocol": "1" } });
    expect(init?.headers).toEqual({ "ductus-protocol": "1" });
    // @ts-expect-error A route that declares headers needs them.
    await call("live.document.get", input);
    const none = { params: undefined, query: undefined, body: {} as never };
    // @ts-expect-error The same for open
    await call("evidence.open.post", none);
    // @ts-expect-error and for commit.
    await call("evidence.commit.post", none);
    // A route id known only as a union (review FAIL c.6962469723): headers are
    // needed when any route of it declares them, and fit every one of them.
    const either = "live.document.get" as "live.document.get" | "platform.health.get";
    // @ts-expect-error One of the routes declares headers.
    await call(either, input);
    await call(either, { ...input, headers: { "ductus-protocol": "1" } });
    const open = "evidence.open.post" as "evidence.open.post" | "platform.health.get";
    // @ts-expect-error The same with open (QA FAIL c.6962480873).
    await call(open, none);
    await call(open, { ...none, headers: { "ductus-protocol": "1" } });
    const write = "evidence.open.post" as "evidence.open.post" | "evidence.commit.post";
    // @ts-expect-error "2" is not a protocol of open.
    await call(write, { ...none, headers: { "ductus-protocol": "2" } });
    await call(write, { ...none, headers: { "ductus-protocol": "1" } });
    await call("platform.health.get", { params: undefined, query: undefined, body: undefined });
    expect(init?.headers).toBeUndefined();
  });
});
