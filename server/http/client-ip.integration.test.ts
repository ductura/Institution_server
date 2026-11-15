// The client IP layer on a real node:http server (S-1C.1, DAN-790). The test
// client connects from the loopback, so the loopback is the proxy here; the
// forwarded addresses are documentation addresses.
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clientIpOf, parseTrustedProxies } from "../traffic/index.ts";
import { createDatabases } from "./databases.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const seen: (string | null)[] = [];

async function start(trusted: string): Promise<Running> {
  const list = parseTrustedProxies(trusted);
  if (list === null) throw new Error("bad list");
  return startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null, trustedProxies: list }),
    routes: [
      {
        ...HEALTH_ROUTE,
        handle: async (request, response) => {
          seen.push(clientIpOf(request));
          await HEALTH_ROUTE.handle(request, response);
        },
      },
    ],
    databases: createDatabases(),
  });
}

function get(port: number, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
    socket.on("error", reject);
    socket.on("close", () => resolve(Number(text.split(" ")[1])));
    socket.end(
      [
        "GET /api/v1/health HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
        ...lines,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

describe("client IP on a real server", () => {
  let trusting: Running;
  let closed: Running;
  beforeAll(async () => {
    trusting = await start("127.0.0.1, 198.51.100.0/24");
    closed = await start("");
  });
  afterAll(async () => {
    await trusting.close();
    await closed.close();
  });

  it("reads X-Forwarded-For only from a trusted proxy", async () => {
    seen.length = 0;
    const lines = ["X-Forwarded-For: 203.0.113.200", "X-Forwarded-For: 203.0.113.7, 198.51.100.1"];
    expect(await get(trusting.port, lines)).toBe(200);
    expect(await get(closed.port, lines)).toBe(200);
    expect(await get(trusting.port, ["X-Real-IP: 203.0.113.9", "Forwarded: for=203.0.113.9"])).toBe(
      200,
    );
    expect(await get(trusting.port, ["X-Forwarded-For: [garbage"])).toBe(200);
    expect(seen).toEqual(["203.0.113.7", "127.0.0.1", "127.0.0.1", "127.0.0.1"]);
  });

  it("drops no header, so a forged XFF before filler never wins (Codex on DAN-790)", async () => {
    seen.length = 0;
    const filler = Array.from({ length: 2100 }, () => "a:b");
    const lines = ["X-Forwarded-For: 203.0.113.66", ...filler, "X-Forwarded-For: 203.0.113.7"];
    expect(await get(trusting.port, lines)).toBe(200);
    expect(seen).toEqual(["203.0.113.7"]);
  });
});
