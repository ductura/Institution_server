import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeServer,
  FAKE_VECTOR_HEADER,
  ROUTE_TABLE,
  VECTORS,
  type FakeVector,
} from "./generated/fake-server/index.ts";
import { createClient } from "./generated/index.ts";

const server = createFakeServer();
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** A raw HTTP request, so every header a vector names is sent as it is. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sendVector(v: FakeVector): Promise<Reply> {
  const route = ROUTE_TABLE[v.route as keyof typeof ROUTE_TABLE];
  const params = v.request.params ?? {};
  let path = route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const query = new URLSearchParams(v.request.query ?? {}).toString();
  if (query) path += `?${query}`;
  const { body, rawBody } = v.request;
  const text =
    rawBody ??
    (body === undefined
      ? ""
      : route.body === "application/x-www-form-urlencoded"
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body));
  return send(route.method, path, { ...v.request.headers, [FAKE_VECTOR_HEADER]: v.name }, text);
}

// A content-length the body does not have (invalid, mismatched, cut short) is
// refused or waited on by Node itself; fake-server.test.ts covers those vectors.
const overHttp = VECTORS.filter((v) => v.request.headers?.["content-length"] === undefined);

describe("fake server over HTTP", () => {
  it("sends all but the framing vectors over the wire", () => {
    expect(VECTORS.length - overHttp.length).toBe(9);
  });

  it.each(overHttp.map((v) => [`${v.route} ${v.name}`, v] as const))(
    "%s: exactly the vector",
    async (_, v) => {
      const res = await sendVector(v);
      const { status, contentType, headers = {}, body } = v.response;
      expect(res.status).toBe(status);
      for (const [name, value] of Object.entries(headers)) expect(res.headers[name]).toEqual(value);
      expect(res.headers["content-type"]).toBe(contentType);
      if (body === undefined) expect(res.body).toBe("");
      else if (contentType === "application/json") expect(JSON.parse(res.body)).toEqual(body);
      else expect(res.body).toBe(body);
    },
  );

  it.each([
    ["GET", "/api/v1/health?x=1", 501, "not_implemented"],
    ["POST", "/api/v1/profile/interface-locale", 501, "not_implemented"],
    ["DELETE", "/api/v1/health", 405, "method_not_allowed"],
    ["GET", "/api/v1/evidence/replay", 404, "not_found"],
    ["GET", "/api/v1/evidence/commit", 405, "method_not_allowed"],
    ["GET", "/api/v1/health/extra", 404, "not_found"],
    ["GET", "/health", 404, "not_found"],
  ])("%s %s -> %i %s", async (method, path, status, code) => {
    const res = await send(method, path);
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ error: code });
  });

  it("405 lists the allowed methods", async () => {
    const res = await send("PUT", "/api/v1/profile/interface-locale");
    expect(res.headers.allow).toBe("GET, POST");
  });

  it("answers 500 internal when it is picked, and the generated client knows the code", async () => {
    const pick = (async (url: URL, init: RequestInit) =>
      fetch(url, { ...init, headers: { [FAKE_VECTOR_HEADER]: "internal" } })) as typeof fetch;
    const call = createClient(`http://127.0.0.1:${port}`, pick);
    const none = { params: undefined, query: undefined, body: undefined };
    expect(await call("platform.health.get", none)).toEqual({
      ok: false,
      status: 500,
      code: "internal",
    });
  });

  it("a health check without a pick gets its success vector", async () => {
    const res = await send("GET", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });
});
