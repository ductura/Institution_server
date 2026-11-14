import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeServer } from "./generated/index.ts";

const server = createFakeServer();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("fake server from the contracts", () => {
  it.each([
    ["GET", "/api/v1/health", 501, "not_implemented"],
    ["POST", "/api/v1/profile/interface-locale", 501, "not_implemented"],
    ["DELETE", "/api/v1/health", 405, "method_not_allowed"],
    ["GET", "/api/v1/evidence/commit", 404, "not_found"],
    ["GET", "/api/v1/health/extra", 404, "not_found"],
    ["GET", "/health", 404, "not_found"],
  ])("%s %s -> %i %s", async (method, path, status, code) => {
    const res = await fetch(base + path, { method });
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: code });
  });

  it("405 lists the allowed methods", async () => {
    const res = await fetch(`${base}/api/v1/profile/interface-locale`, { method: "PUT" });
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});
