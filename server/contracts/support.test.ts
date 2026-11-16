// DAN-803 support.problem-report.post: Ductus reads only the exact JCS bytes
// of the report (078c780 problem-report-route.ts, canonical()), so the
// generated client sends every JSON body in that form (review c.6908362361).
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { canonicalJson, createClient, validateInput } from "./generated/index.ts";

const vector = (name: string) => {
  const found = VECTORS.find((v) => v.route === "support.problem-report.post" && v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};

describe("canonicalJson (RFC 8785)", () => {
  it("orders keys by UTF-16 code units at every depth and keeps array order", () => {
    expect(canonicalJson({ b: [3, { y: 1, x: null }], a: "č", "￿": 1, "\u{1F600}": 2 })).toBe(
      '{"a":"č","b":[3,{"x":null,"y":1}],"\u{1F600}":2,"￿":1}',
    );
  });

  it("drops an undefined field and writes an undefined item as null, as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });
});

describe("the client sends the JCS bytes Ductus asks for", () => {
  it("a report built in any key order goes out canonical", async () => {
    const report = vector("recorded").request.body as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(report).reverse());
    const browser = report["browser"] as Record<string, unknown>;
    reordered["browser"] = Object.fromEntries(Object.entries(browser).reverse());
    let sent: unknown;
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      sent = init?.body;
      return new Response('{"reference":"PR-0A1B2C3D4E"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const call = createClient("https://ductura.example.invalid", fetchImpl);
    await call("support.problem-report.post", {
      params: undefined,
      query: undefined,
      body: reordered as never,
    });
    expect(sent).toBe(canonicalJson(report));
    expect(sent).not.toBe(JSON.stringify(reordered));
    expect(JSON.stringify(JSON.parse(sent as string))).toBe(sent);
  });

  it("the not-canonical vector is the same report, only out of order", () => {
    const raw = vector("not-canonical").request.rawBody as string;
    expect(JSON.parse(raw)).toEqual(vector("recorded").request.body);
    expect(raw).not.toBe(canonicalJson(JSON.parse(raw)));
    expect(vector("not-canonical").response.status).toBe(422);
  });
});

describe("lone surrogates are refused, as Ductus does (review c.6908717137)", () => {
  const report = () => ({ ...(vector("recorded").request.body as Record<string, unknown>) });
  const valid = (description: string) =>
    validateInput("support.problem-report.post", "body", { ...report(), description });
  const astral = "\u{1D4D0}";

  it("the description is 1 to 1000 code points with no lone surrogate", () => {
    expect(valid("a\uD800b")).toBe(false);
    expect(valid("a\uDC00b")).toBe(false);
    expect(valid("\uDC00\uD800")).toBe(false);
    expect(valid(`a${astral}b`)).toBe(true);
    expect(valid(astral.repeat(1000))).toBe(true);
    expect(valid("č".repeat(1000))).toBe(true);
    expect(valid("x".repeat(1001))).toBe(false);
    expect(valid(astral.repeat(1001))).toBe(false);
    expect(valid("")).toBe(false);
  });

  it("canonicalJson refuses a lone surrogate in a value or a key, never sends it", () => {
    expect(() => canonicalJson({ description: "a\uD800b" })).toThrow(/lone surrogate/u);
    expect(() => canonicalJson({ ["k\uDFFF"]: 1 })).toThrow(/lone surrogate/u);
    expect(() => canonicalJson(["\uD800"])).toThrow(/lone surrogate/u);
    expect(canonicalJson({ d: `a${astral}` })).toBe(`{"d":"a${astral}"}`);
  });
});
