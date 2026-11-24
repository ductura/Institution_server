import { describe, expect, it } from "vitest";

import {
  answerFake,
  FAKE_VECTOR_HEADER,
  ROUTE_TABLE,
  VECTORS,
  type FakeVector,
  type FakeRequest,
} from "./generated/fake-server/index.ts";
import { ROUTES } from "./index.ts";

const COOKIE = "__Host-ductus_session=izmisljeni_token-jezika_sucelja_00000000001";
const SAME_ORIGIN = {
  cookie: COOKIE,
  origin: "https://ductura.example.invalid",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

/**
 * A multipart body (SRV-1102) with the boundary of the vector's content type:
 * a field the contract marks with contentMediaType is a file part, its bytes
 * written in Base64 in the vector.
 */
function multipartOf(v: FakeVector, body: Record<string, string>): Uint8Array {
  const boundary = /boundary=([^;]+)/u.exec(v.request.headers?.["content-type"] ?? "")?.[1];
  const schema = ROUTES.find((r) => r.id === v.route)?.request.body as
    { properties?: Record<string, { contentMediaType?: string }> } | undefined;
  const parts = Object.entries(body).map(([name, value]) => {
    const type = schema?.properties?.[name]?.contentMediaType;
    const head =
      type === undefined
        ? `Content-Disposition: form-data; name="${name}"`
        : `Content-Disposition: form-data; name="${name}"; filename="isjecak.jpg"\r\nContent-Type: ${type}`;
    const bytes = type === undefined ? Buffer.from(value) : Buffer.from(value, "base64");
    return Buffer.concat([
      Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`),
      bytes,
      Buffer.from("\r\n"),
    ]);
  });
  return Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
}

/** The request a vector describes, as a client would send it. */
function requestOf(v: FakeVector, pick = true): FakeRequest {
  const route = ROUTE_TABLE[v.route as keyof typeof ROUTE_TABLE];
  const params = v.request.params ?? {};
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const query = new URLSearchParams(v.request.query ?? {}).toString();
  const { body, rawBody } = v.request;
  const multipart =
    rawBody === undefined && body !== undefined && route.body === "multipart/form-data"
      ? multipartOf(v, body as Record<string, string>)
      : undefined;
  const text =
    rawBody ??
    (body === undefined
      ? ""
      : route.body === "application/x-www-form-urlencoded"
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(v.request.headers ?? {}))
    headers[name.toLowerCase()] = value;
  if (pick) headers[FAKE_VECTOR_HEADER] = v.name;
  return {
    method: route.method,
    url: query ? `${path}?${query}` : path,
    headers,
    body: multipart ?? new TextEncoder().encode(text),
  };
}

/** What the vector says the answer is, written out independently of the fake server. */
function expected(v: FakeVector) {
  const { status, contentType, headers = {}, body } = v.response;
  return {
    status,
    headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
    body: body === undefined ? "" : contentType === "application/json" ? body : (body as string),
  };
}

function parsed(answer: ReturnType<typeof answerFake>) {
  const type = answer.headers["content-type"];
  const { body } = answer;
  // A JPEG or DOCX answer is compared in Base64, as the vector writes it.
  if (
    type === "image/jpeg" ||
    String(type).startsWith("application/vnd.openxmlformats-officedocument.")
  )
    return { ...answer, body: Buffer.from(body).toString("base64") };
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return { ...answer, body: type === "application/json" ? (JSON.parse(text) as unknown) : text };
}

const named = (route: string, name: string): FakeVector => {
  const v = VECTORS.find((x) => x.route === route && x.name === name);
  if (!v) throw new Error(`no vector ${route}/${name}`);
  return v;
};

describe("fake server answers with the vectors", () => {
  it("embeds every vector of every route", () => {
    expect(new Set(VECTORS.map((v) => v.route))).toEqual(new Set(Object.keys(ROUTE_TABLE)));
    expect(VECTORS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(VECTORS.map((v) => [`${v.route} ${v.name}`, v] as const))(
    "%s: the named vector's request gets exactly its answer",
    (_, v) => {
      expect(parsed(answerFake(requestOf(v)))).toEqual(expected(v));
    },
  );

  it.each([
    ["platform.health.get", "alive", "alive"],
    ["profile.interface-locale.post", "saved", "saved"],
    ["profile.interface-locale.post", "unauthorized", "unauthorized"],
    ["profile.interface-locale.post", "invalid-input", "invalid-input"],
    ["profile.interface-locale.post", "origin-missing", "origin-missing"],
    ["profile.interface-locale.post", "unavailable", "saved"],
    ["auth.backchannel-logout.post", "sessions-closed", "sessions-closed"],
  ])("%s %s without a pick gets the first matching vector, %s", (route, name, first) => {
    const answer = parsed(answerFake(requestOf(named(route, name), false)));
    expect(answer).toEqual(expected(named(route, first)));
  });

  it("reads the caller's header names whatever their case, the pick among them", () => {
    const logout = requestOf(named("auth.backchannel-logout.post", "sessions-closed"), false);
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    expect(answerFake({ ...logout, headers }).status).toBe(200);
    const unavailable = named("auth.backchannel-logout.post", "unavailable");
    const picked = { ...headers, "X-Ductura-Fake-Vector": "unavailable" };
    expect(parsed(answerFake({ ...logout, headers: picked }))).toEqual(expected(unavailable));
  });

  it("matches JSON bodies whatever the key order and headers whatever their case", () => {
    const v = named("profile.interface-locale.post", "saved");
    const req = requestOf(v);
    const headers = { ...req.headers, "X-Extra": "izmisljeno" };
    expect(answerFake({ ...req, headers }).status).toBe(200);
  });
});

describe("a request without a vector answers 501", () => {
  const notImplemented = {
    status: 501,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: { error: "not_implemented" },
  };
  const post = (body: string, headers: Record<string, string> = SAME_ORIGIN): FakeRequest => ({
    method: "POST",
    url: "/api/v1/profile/interface-locale",
    headers,
    body: new TextEncoder().encode(body),
  });
  const get = (url: string, headers: Record<string, string> = {}): FakeRequest => ({
    method: "GET",
    url,
    headers,
    body: new Uint8Array(),
  });

  it.each([
    ["a query no vector has", get("/api/v1/health?x=1")],
    ["a repeated query field", get("/api/v1/health?x=1&x=2")],
    ["a query field named __proto__", get("/api/v1/health?__proto__=x")],
    ["a repeated query field named __proto__", get("/api/v1/health?__proto__=x&__proto__=y")],
    [
      "a form field named __proto__ next to a vector's fields",
      {
        method: "POST",
        url: "/api/v1/auth/backchannel-logout",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode("logout_token=izmisljeni.logout.token&__proto__=x"),
      },
    ],
    ["a body no vector has", post('{"locale":"fr"}')],
    ["a body that is not JSON", post("{")],
    ["a body that is not UTF-8", { ...post(""), body: new Uint8Array([0xff, 0xfe]) }],
    ["a body where the vector has none", { ...get("/api/v1/health"), body: new Uint8Array([1]) }],
    ["an unknown vector name", get("/api/v1/health", { [FAKE_VECTOR_HEADER]: "nema-ga" })],
    [
      "a named vector whose request does not match",
      post('{"locale":"en"}', { ...SAME_ORIGIN, cookie: "x=y", [FAKE_VECTOR_HEADER]: "saved" }),
    ],
    [
      "a vector of another route",
      get("/api/v1/health", { [FAKE_VECTOR_HEADER]: "session-opened" }),
    ],
  ])("%s", (_, req) => {
    expect(parsed(answerFake(req))).toEqual(notImplemented);
  });

  it("keeps 405 for another method and the fallback 404 for an unknown path", () => {
    expect(answerFake({ ...post(""), method: "PUT" })).toMatchObject({
      status: 405,
      headers: { allow: "GET, POST" },
    });
    expect(answerFake(get("/api/v1/nope")).status).toBe(404);
  });
});
