// DAN-831-2, K2: the traffic recorder on a real node:http server, writing
// through the real log writer to the fake log database (PGlite). An invented
// canary goes into every part of a request; no stored row and no fallback line
// may hold it. Addresses are documentation addresses.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";

import { createFakeLogDatabase, type FakeLogDatabase } from "@ductura/test-fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger, createLogWriter } from "../log/index.ts";
import { clientIpLayer, parseTrustedProxies } from "./index.ts";
import { createTrafficRecorder } from "./traffic-record.ts";

const CANARY = "kanarinac-831c-Zq7";
const ROUTE = "/api/v1/health";

type StoredRow = { event: string; fields: Record<string, unknown> };
let db: FakeLogDatabase;
const lines: string[] = [];
const pending: Promise<unknown>[] = [];
let entered: () => void = () => {};

async function serve(trusted: string): Promise<{ server: Server; port: number }> {
  const write = createLogWriter({
    store: db,
    routes: new Set([ROUTE]),
    fallback: createLogger((_level, line) => lines.push(line)),
  });
  const { arm } = createTrafficRecorder({
    write: (input) => {
      const result = write(input);
      pending.push(result);
      return result;
    },
    routeOf: (request) => ((request.url ?? "").startsWith(ROUTE) ? ROUTE : null),
    requestIdOf: () => randomUUID(),
  });
  const layer = clientIpLayer(parseTrustedProxies(trusted) ?? []);
  const server = createServer(async (request, response) => {
    await layer(request);
    arm(request, response);
    if ((request.url ?? "").includes("hang")) return entered();
    request.resume();
    request.on("end", () => response.writeHead(204).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
}

/** Sends raw request text; resolves on close with the status of each answer. */
function send(port: number, text: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk: Buffer) => (answer += chunk.toString("latin1")));
    socket.on("error", reject);
    socket.on("close", () =>
      resolve([...answer.matchAll(/HTTP\/1\.1 (\d+)/g)].map((m) => Number(m[1]))),
    );
    socket.end(text);
  });
}

async function rowsAfter(work: () => Promise<unknown>) {
  const before = (await db.entries()).length;
  await work();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(pending);
  return (await db.entries()).slice(before).map((entry) => entry.payload as StoredRow);
}

let open: Server;
let openPort: number;
let proxied: Server;
let proxiedPort: number;
beforeAll(async () => {
  db = await createFakeLogDatabase();
  ({ server: open, port: openPort } = await serve(""));
  ({ server: proxied, port: proxiedPort } = await serve("127.0.0.1"));
});
afterAll(async () => {
  open.close();
  proxied.close();
  await db.close();
});

const head = (method: string, path: string, extra: string[] = [], body = "") =>
  [
    `${method} ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...extra,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");

describe("traffic record over real HTTP (K2)", () => {
  it("stores one row per request and never the canary from any part of it", async () => {
    const rows = await rowsAfter(() =>
      send(
        openPort,
        head(
          "POST",
          `${ROUTE}?q=${CANARY}`,
          [
            `Cookie: __Host-session=${CANARY}`,
            `Authorization: Bearer ${CANARY}`,
            `X-Request-Id: ${CANARY}`,
            `User-Agent: ${CANARY}`,
            `Referer: https://${CANARY}.invalid/`,
            `X-Forwarded-For: 192.0.2.9, ${CANARY}`,
          ],
          `{"text":"${CANARY}"}`,
        ) + head("GET", `/${CANARY}`, ["Connection: close"]),
      ),
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(rows[0]).toMatchObject({
      event: "traffic.request",
      fields: { method: "POST", route: ROUTE, ip: "127.0.0.1", status: 204 },
    });
    expect(rows[1]).toMatchObject({ fields: { method: "GET", route: "none", ip: "127.0.0.1" } });
  });

  it("reads X-Forwarded-For only from a trusted proxy, and never a canary in it", async () => {
    const rows = await rowsAfter(async () => {
      await send(
        proxiedPort,
        head("GET", ROUTE, ["X-Forwarded-For: 192.0.2.7", "Connection: close"]),
      );
      await send(
        proxiedPort,
        head("GET", ROUTE, [`X-Forwarded-For: ${CANARY}`, "Connection: close"]),
      );
    });
    expect(rows.map((row) => row.fields.ip)).toEqual(["192.0.2.7", "127.0.0.1"]);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });

  it("writes 499 when the client leaves before the headers, and OTHER for PROPFIND", async () => {
    const rows = await rowsAfter(async () => {
      const socket = connect(openPort, "127.0.0.1");
      const inside = new Promise<void>((resolve) => (entered = resolve));
      socket.write(head("GET", `${ROUTE}?hang`));
      await inside;
      const closed = new Promise((resolve) => socket.on("close", resolve));
      socket.destroy();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await send(openPort, head("PROPFIND", ROUTE, ["Connection: close"]));
    });
    expect(rows.map((row) => [row.fields.status, row.fields.method])).toEqual([
      [499, "GET"],
      [204, "OTHER"],
    ]);
  });
});
