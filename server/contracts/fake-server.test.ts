import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toPosix } from "../../scripts/index.ts";
import {
  answerFake,
  FAKE_VECTOR_HEADER,
  ROUTE_TABLE,
  VECTORS,
  type FakeVector,
  type FakeRequest,
} from "./generated/fake-server/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FAKE_DIR = fileURLToPath(new URL("./generated/fake-server/", import.meta.url));
const COOKIE = "__Host-ductus_session=izmisljeni-token-0001";
const SAME_ORIGIN = {
  cookie: COOKIE,
  origin: "https://ductura.example.invalid",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

/** The request a vector describes, as a client would send it. */
function requestOf(v: FakeVector, pick = true): FakeRequest {
  const route = ROUTE_TABLE[v.route as keyof typeof ROUTE_TABLE];
  const params = v.request.params ?? {};
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const query = new URLSearchParams(v.request.query ?? {}).toString();
  const { body, rawBody } = v.request;
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
    body: new TextEncoder().encode(text),
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
  const json = answer.headers["content-type"] === "application/json";
  return { ...answer, body: json ? (JSON.parse(answer.body) as unknown) : answer.body };
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

describe("the fake server stays out of production", () => {
  const specifiers = (file: string): string[] =>
    [
      ...readFileSync(file, "utf8").matchAll(
        /(?:^|\n)\s*(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? "");

  it("imports only node:http and node:fs, so U9 can move the folder as it is", () => {
    expect(readdirSync(FAKE_DIR).sort()).toEqual(["index.ts", "vectors.json"]);
    expect(specifiers(join(FAKE_DIR, "index.ts")).sort()).toEqual(["node:fs", "node:http"]);
    // The one file it reads is its sibling vectors.json.
    const reads = [
      ...readFileSync(join(FAKE_DIR, "index.ts"), "utf8").matchAll(/new URL\("([^"]+)"/g),
    ];
    expect(reads.map((m) => m[1])).toEqual(["./vectors.json"]);
  });

  it("is not reachable from the production entry point server/index.ts", () => {
    const seen = new Set<string>();
    const queue = [join(REPO_ROOT, "server", "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of specifiers(file)) {
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      }
    }
    const reached = [...seen].map((f) => toPosix(relative(REPO_ROOT, f)));
    expect(reached).toContain("server/app.ts");
    expect(reached.filter((f) => f.includes("fake-server") || f.endsWith(".test.ts"))).toEqual([]);
  });

  it("is not exported from generated/index.ts", () => {
    const index = readFileSync(join(FAKE_DIR, "..", "index.ts"), "utf8");
    expect(index).not.toContain("fake-server");
  });
});
