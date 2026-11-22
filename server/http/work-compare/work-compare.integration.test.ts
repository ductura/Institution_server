import { afterEach, expect, it, vi } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createWorkCompareRoute } from "./index.ts";

const COOKIE = `__Host-ductus_session=${"H".repeat(43)}`;
const DOC = "00000000-0000-4000-8000-0000000000d1";

type Compare = Parameters<typeof createWorkCompareRoute>[0];
type Result = Awaited<ReturnType<Compare>>;

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(compare: Compare) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createWorkCompareRoute(compare)],
  });
  return (query: string, cookie = COOKIE, id = DOC) =>
    fetch(`http://127.0.0.1:${running!.port}/api/v1/works/${id}/compare${query}`, {
      headers: cookie === "" ? {} : { cookie },
    });
}

it("answers the block difference of the comparison, unchanged blocks included", async () => {
  const compare = vi.fn<Compare>().mockResolvedValue({
    status: "ok",
    from: 1,
    to: 3,
    blocks: [
      { kind: "heading", level: 1, text: "Izmišljeni naslov", change: "unchanged" },
      { kind: "paragraph", text: "Izmišljeni stari odlomak.", change: "removed" },
      { kind: "paragraph", text: "Izmišljeni novi odlomak.", change: "added" },
    ],
  } as Result);
  const get = await serve(compare);
  const response = await get("?from=1&to=3");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toStrictEqual({
    from: 1,
    to: 3,
    blocks: [
      { kind: "heading", level: 1, text: "Izmišljeni naslov", change: "unchanged" },
      { kind: "paragraph", text: "Izmišljeni stari odlomak.", change: "removed" },
      { kind: "paragraph", text: "Izmišljeni novi odlomak.", change: "added" },
    ],
  });
  expect(compare).toHaveBeenCalledWith(COOKIE.split("=")[1], DOC, 1, 3);
});

it("refuses a missing cookie, a bad id and a bad query before the comparison", async () => {
  const compare = vi.fn<Compare>();
  const get = await serve(compare);
  expect((await get("?from=1&to=2", "")).status).toBe(401);
  expect((await get("?from=1&to=2", COOKIE, "%20doc")).status).toBe(404);
  for (const query of [
    "",
    "?from=1",
    "?to=2",
    "?from=2&to=2",
    "?from=3&to=2",
    "?from=0&to=2",
    "?from=01&to=2",
    "?from=1&to=9007199254740992",
    "?from=1&to=2&to=3",
    "?from=1&to=2&role=teacher",
    "?from=1&to=2%0A",
  ]) {
    expect((await get(query)).status, query).toBe(422);
  }
  expect(compare).not.toHaveBeenCalled();
});

it.each([
  [{ status: "unauthenticated" }, 401],
  [{ status: "not_found" }, 404],
  [{ status: "invalid_input" }, 422],
  [{ status: "too_large" }, 503],
  [{ status: "unavailable", reason: "record_break" }, 503],
] as const)("maps %j to %i with no document text", async (result, status) => {
  const get = await serve(async () => structuredClone(result) as Result);
  const response = await get("?from=1&to=2");
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("blocks");
});

it("answers 503 when the comparison throws", async () => {
  const get = await serve(async () => {
    throw new Error("izmisljena greska");
  });
  expect((await get("?from=1&to=2")).status).toBe(503);
});
