import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeServer, FAKE_VECTOR_HEADER, VECTORS } from "./generated/fake-server/index.ts";
import { createClient } from "./generated/index.ts";

// DAN-930-1 over the fake server (ugovor Ductus#2028 c.6961819901): the client
// itself sends origin and ductus-protocol; a request without them gets no vector.

const server = createFakeServer();
let port = 0;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const SITE = "https://ductura.example.invalid";
type Route = "evidence.open.post" | "evidence.commit.post";
const vector = (route: Route, name: string) => {
  const v = VECTORS.find((x) => x.route === route && x.name === name);
  if (v === undefined) throw new Error(`no vector ${name}`);
  return v;
};

/**
 * A browser on SITE: the fetch only moves the request to the fake server and
 * adds what a browser adds (cookie, sec-fetch-site) and the vector to pick,
 * never origin or ductus-protocol. `seen` keeps the headers the client gave.
 */
function browser(route: Route, name: string, seen: Record<string, string>[] = []) {
  const { cookie, "sec-fetch-site": site } = vector(route, name).request.headers ?? {};
  return createClient(SITE, (async (url: URL, init: RequestInit) => {
    const own = init.headers as Record<string, string>;
    seen.push({ ...own });
    const moved = new URL(url.pathname, `http://127.0.0.1:${port}`);
    return fetch(moved, {
      ...init,
      headers: {
        ...own,
        cookie: cookie ?? "",
        "sec-fetch-site": site ?? "",
        [FAKE_VECTOR_HEADER]: name,
      },
    });
  }) as typeof fetch);
}

const input = (route: Route, name: string, protocol: string) => ({
  params: undefined,
  query: undefined,
  body: vector(route, name).request.body as never,
  headers: { "ductus-protocol": protocol } as never,
});

const CASES: [Route, string, number, string][] = [
  ["evidence.commit.post", "stale-base", 409, "stale_base"],
  ["evidence.commit.post", "unavailable", 503, "unavailable"],
  ["evidence.open.post", "not-started", 409, "not_started"],
  ["evidence.open.post", "unavailable", 503, "unavailable"],
];

describe("a request without the declared headers gets no 409 or 503 vector", () => {
  it.each(CASES)("%s %s", async (route, name) => {
    const v = vector(route, name);
    const headers: Record<string, string> = { ...v.request.headers, [FAKE_VECTOR_HEADER]: name };
    const path =
      route === "evidence.open.post" ? "/api/v1/evidence/open" : "/api/v1/evidence/commit";
    const post = (h: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(v.request.body),
      });
    const noProtocol = Object.fromEntries(
      Object.entries(headers).filter(([key]) => key !== "ductus-protocol"),
    );
    expect((await post(noProtocol)).status).toBe(501);
    expect((await post({ ...headers, origin: "https://drugo.example.invalid" })).status).toBe(501);
    expect((await post(headers)).status).toBe(v.response.status);
  });
});

describe("the generated client sends them and reaches the vector", () => {
  it.each(CASES)("%s %s -> %i %s", async (route, name, status, code) => {
    const seen: Record<string, string>[] = [];
    expect(await browser(route, name, seen)(route, input(route, name, "1"))).toEqual({
      ok: false,
      status,
      code,
    });
    expect(seen).toEqual([
      { "content-type": "application/json", "ductus-protocol": "1", origin: SITE },
    ]);
  });

  it("a wrong protocol is sent as given: 426 for the vector that has it, no 409 or 503", async () => {
    const open = browser("evidence.open.post", "upgrade-required");
    expect(
      await open("evidence.open.post", input("evidence.open.post", "upgrade-required", "0")),
    ).toEqual({
      ok: false,
      status: 426,
      code: "upgrade_required",
    });
    const commit = browser("evidence.commit.post", "upgrade-required");
    expect(
      await commit("evidence.commit.post", input("evidence.commit.post", "upgrade-required", "3")),
    ).toEqual({ ok: false, status: 426, code: "upgrade_required" });
    for (const [route, name] of CASES) {
      const result = await browser(route, name)(route, input(route, name, "0"));
      expect(result).toMatchObject({ ok: false, status: 501 });
    }
  });
});
