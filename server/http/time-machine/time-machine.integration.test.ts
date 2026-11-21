import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createWorkVersionRoute } from "./index.ts";
import type { TimeMachineStore } from "./store.ts";

const COOKIE = `__Host-ductus_session=${"H".repeat(43)}`;
const BLOCK_ID = "a0000000-0000-4000-8000-000000000001";
const snapshot = (text: string) => {
  const body = JSON.stringify({
    nodes: [{ children: [{ marks: [], text, type: "text" }], id: BLOCK_ID, type: "paragraph" }],
    schemaVersion: 1,
  });
  return { body, hash: createHash("sha256").update(body).digest("hex") };
};

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(read: TimeMachineStore["read"]) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createWorkVersionRoute(read)],
  });
  return (suffix: string, cookie = COOKIE, id = "doc-demo") =>
    fetch(`http://127.0.0.1:${running!.port}/api/v1/works/${id}/versions/${suffix}`, {
      headers: cookie === "" ? {} : { cookie },
    });
}

it("returns the exact verified revision and the same block operations as wave 9", async () => {
  const earlier = snapshot("Izmišljeni nacrt.");
  const later = snapshot("Izmišljena dorada.");
  const read = vi
    .fn<TimeMachineStore["read"]>()
    .mockResolvedValueOnce({
      status: "found",
      snapshots: [later],
    })
    .mockResolvedValueOnce({
      status: "found",
      snapshots: [earlier, later],
    });
  const get = await serve(read);
  const detail = await get("2");
  expect(detail.headers.get("cache-control")).toBe("no-store");
  expect(await detail.json()).toStrictEqual({ revision: 2, document: later.body });
  expect(await (await get("2?compareFrom=1")).json()).toStrictEqual({
    from: 1,
    to: 2,
    blocks: [
      { kind: "paragraph", text: "Izmišljeni nacrt.", change: "removed" },
      { kind: "paragraph", text: "Izmišljena dorada.", change: "added" },
    ],
  });
  expect(read.mock.calls.map((args) => args.slice(1))).toStrictEqual([
    ["doc-demo", [2]],
    ["doc-demo", [1, 2]],
  ]);
});

it("refuses malformed or ambiguous inputs before the store", async () => {
  const read = vi.fn<TimeMachineStore["read"]>();
  const get = await serve(read);
  expect((await get("2", "")).status).toBe(401);
  expect((await get("2", COOKIE, "%20doc")).status).toBe(404);
  for (const suffix of [
    "0",
    "01",
    "1.0",
    "-1",
    "%31",
    "9007199254740992",
    "2?compareFrom=2",
    "2?compareFrom=3",
    "2?compareFrom=0",
    "2?compareFrom=1&compareFrom=1",
    "2?compareFrom=1%0A",
    "2?role=owner",
  ]) {
    expect((await get(suffix)).status, suffix).toBe(422);
  }
  expect(read).not.toHaveBeenCalled();
});

it.each([
  [{ status: "unauthenticated" }, 401],
  [{ status: "not_found" }, 404],
  [{ status: "unavailable" }, 503],
  [{ status: "found", snapshots: [{ ...snapshot("Izmišljeno."), hash: "a".repeat(64) }] }, 503],
] as const)(
  "does not return document data on a refusal or a corrupt snapshot",
  async (result, status) => {
    const get = await serve(
      async () => structuredClone(result) as Awaited<ReturnType<TimeMachineStore["read"]>>,
    );
    const response = await get("2");
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("Izmišljeno.");
  },
);
