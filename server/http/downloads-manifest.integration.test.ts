// DAN-932 (S-1H.5-b; UGOVOR Ductus#2028 c.6968257133): GET
// /api/v1/downloads/manifest on a real server with the real pipeline meets
// every vector of S-1H.5; other methods are the router's 405. All values are
// invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { createDownloadsManifestRoute } from "./downloads-manifest.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = { name: string; response: { status: number; body: Record<string, unknown> } };
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/downloads.manifest.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
const vector = (name: string) => vectors.find((v) => v.name === name)!;
const PATH = "/api/v1/downloads/manifest";

let server: Running | undefined;
async function start(releases?: () => unknown): Promise<string> {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createDownloadsManifestRoute(releases)],
  });
  return `http://127.0.0.1:${server.port}${PATH}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

/** The configuration that answers each vector: the body itself, or one the service refuses. */
const RELEASES: Record<string, unknown> = {
  ready: vector("ready").response.body,
  "ready-empty": vector("ready-empty").response.body,
  unavailable: { packages: [{ system: "linux" }] },
};

describe("the vectors of downloads.manifest.get", () => {
  it("every vector has a configuration here", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(Object.keys(RELEASES).sort());
  });

  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (name, v) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const got = await fetch(await start(() => RELEASES[name]));
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    const body = (await got.json()) as Record<string, unknown>;
    if (got.status === 200) {
      expect(body).toEqual(v.response.body);
      expect(errors).not.toHaveBeenCalled();
      return;
    }
    expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    // The refusal is logged by its code and request id, never by a configuration value.
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      JSON.stringify({
        event: "downloads_manifest_refused",
        route: "downloads.manifest.get",
        code: "DOWNLOADS_RELEASES_INVALID",
        requestId: got.headers.get("x-request-id"),
      }),
    ]);
  });
});

describe("the route as mounted", () => {
  it("answers the built-in configuration: no desktop release yet", async () => {
    const got = await fetch(await start());
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(vector("ready-empty").response.body);
  });

  it("never answers a partial list, and never logs a value: one bad row of four is 503", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ready = vector("ready").response.body as { packages: Record<string, string>[] };
    const [first, ...rest] = ready.packages;
    const sentinel = "/preuzimanje/SENTINEL-c0ffee/x.dmg";
    const releases = { packages: [{ ...first, url: sentinel, sha256: "A".repeat(64) }, ...rest] };
    const got = await fetch(await start(() => releases));
    expect(got.status).toBe(503);
    const text = await got.text();
    expect((JSON.parse(text) as { code: string }).code).toBe("unavailable");
    const logged = errors.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("DOWNLOADS_RELEASES_INVALID");
    for (const seen of [logged, text]) {
      expect(seen).not.toContain("SENTINEL");
      expect(seen).not.toContain("A".repeat(64));
    }
  });

  it.each(["POST", "PUT", "DELETE"])("%s is 405 from the router", async (method) => {
    const headers = { origin: "https://ductura.example.invalid", "sec-fetch-site": "same-origin" };
    const got = await fetch(await start(), { method, headers });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("GET");
  });
});
