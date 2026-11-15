// readBodyWithLimit on a real node:http server (DAN-777, part a2): a refused
// body is not read to its end, the refusal closes the connection, and a
// client that goes away leaves body_stream_error. Raw sockets, so the test
// controls exactly which body bytes are sent. Origins are invented.
import { spawnSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { createDatabases } from "./databases.ts";
import { type LimitedBodyResult, readBodyWithLimit } from "./mutation-request.ts";
import { createLayers } from "./pipeline.ts";
import { sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.invalid";
const PATH = "/api/v1/profile/interface-locale";
const LIMIT = 16;
const contract = ROUTES.find((route) => route.id === "profile.interface-locale.post");
if (contract === undefined) throw new Error("no contract");

const results: LimitedBodyResult[] = [];
let calls = 0;

function open(port: number, lines: string[]): Socket {
  const socket = connect(port, "127.0.0.1");
  const head = [`POST ${PATH} HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${ORIGIN}`, ...lines];
  socket.write(`${head.join("\r\n")}\r\n\r\n`);
  return socket;
}

/** Everything the server sends until it closes the connection. */
function answer(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
}

describe("readBodyWithLimit on a real server", () => {
  let server: Running;
  beforeAll(async () => {
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: [
        {
          contract,
          handle: async (request, response) => {
            calls += 1;
            const result = await readBodyWithLimit(request, LIMIT, 300);
            results.push(result);
            if (result.ok) sendJson(response, 200, { size: result.bytes.byteLength });
            else refuse(response, result.status, result.reason);
          },
        },
      ],
    });
  });
  afterAll(async () => server.close());

  it("reads a body of exactly the limit", async () => {
    const socket = open(server.port, ["Content-Length: 16", "Connection: close"]);
    socket.write("x".repeat(LIMIT));
    const text = await answer(socket);
    expect(text).toMatch(/^HTTP\/1\.1 200 /u);
    expect(text).toContain('{"size":16}');
  });

  it("refuses a declared 100 MB body at once and closes without reading it", async () => {
    const socket = open(server.port, ["Content-Length: 100000000"]);
    const started = Date.now();
    const text = await answer(socket);
    expect(text).toMatch(/^HTTP\/1\.1 413 /u);
    expect(text).toContain(
      '{"error":"body_too_large","code":"body_too_large","messageKey":"errors.body_too_large","status":413,"requestId":"',
    );
    expect(text).toContain("Connection: close");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cuts a chunked body at the first chunk past the limit and closes", async () => {
    const socket = open(server.port, ["Transfer-Encoding: chunked"]);
    socket.write("a\r\n0123456789\r\n");
    socket.write("a\r\n0123456789\r\n");
    const text = await answer(socket);
    expect(text).toMatch(/^HTTP\/1\.1 413 /u);
    expect(text).toContain("Connection: close");
  });

  it("answers 408 to a body that stops arriving", async () => {
    const socket = open(server.port, ["Content-Length: 10"]);
    socket.write("01234");
    const text = await answer(socket);
    expect(text).toMatch(/^HTTP\/1\.1 408 /u);
    expect(text).toContain(
      '{"error":"body_timeout","code":"body_timeout","messageKey":"errors.body_timeout","status":408,"requestId":"',
    );
  });

  it("gives body_stream_error when the client goes away mid-body", async () => {
    results.length = 0;
    const socket = open(server.port, ["Content-Length: 10"]);
    socket.write("01234", () => socket.destroy());
    const deadline = Date.now() + 2_000;
    while (results.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(results).toEqual([{ ok: false, status: 400, reason: "body_stream_error" }]);
  });
});

// Adversarial pass on 74ced6c: a pipelined request behind a refused body ran
// although its connection was closing and nobody got its answer.
describe("a pipelined request behind a refusal", () => {
  let server: Running;
  beforeAll(async () => {
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: [
        {
          contract,
          handle: async (request, response) => {
            calls += 1;
            const result = await readBodyWithLimit(request, LIMIT, 300);
            if (result.ok) sendJson(response, 200, { size: result.bytes.byteLength });
            else refuse(response, result.status, result.reason);
          },
        },
      ],
    });
  });
  afterAll(async () => server.close());

  it.each([
    ["a declared length over the limit", `Content-Length: 20\r\n\r\n${"x".repeat(20)}`],
    ["a malformed length", "Content-Length: 01\r\n\r\nx"],
  ])("never runs after %s", async (_, first) => {
    calls = 0;
    const socket = connect(server.port, "127.0.0.1");
    const head = (rest: string) =>
      `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\n${rest}`;
    socket.write(head(first) + head("Content-Length: 2\r\n\r\nZZ"));
    const text = await answer(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(text.match(/HTTP\/1\.1 /gu)).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

// Adversarial pass on 74ced6c: each kept chunk held its whole read buffer, so
// one-byte chunks cost far more memory than the limit. A child process with
// --expose-gc measures what stays alive while the body is being read.
// DAN-792: V8 frees the backing stores of dead ArrayBuffers on a background
// thread after a full GC, so arrayBuffers read right after one gc() can still
// count dead chunks under load (28 MB seen in CI). The next GC first finishes
// that sweep, so the probe collects until two readings agree.
const KEPT = 2000 * 64 * 1024;

function measure(keepParents: boolean): { alive: number; size: number } {
  const module = fileURLToPath(new URL("./mutation-request.ts", import.meta.url));
  const probe = `
    import { Readable } from "node:stream";
    import { readBodyWithLimit } from ${JSON.stringify(module)};
    const N = 2000;
    // The negative control: the probe itself keeps every parent buffer.
    const kept = ${JSON.stringify(keepParents)} ? [] : null;
    // Pushed from outside read(), so each chunk reaches the reader at once
    // and none waits in the stream's own buffer when memory is measured.
    const body = new Readable({ read() {} });
    body.headers = {};
    const pending = readBodyWithLimit(body, N);
    for (let sent = 0; sent < N; sent += 1) {
      const chunk = Buffer.alloc(64 * 1024).subarray(0, 1);
      kept?.push(chunk);
      body.push(chunk);
      if (sent % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    let alive = Infinity;
    for (let round = 0; round < 10; round += 1) {
      globalThis.gc();
      const now = process.memoryUsage().arrayBuffers;
      if (now === alive) break;
      alive = now;
    }
    body.push(null);
    const result = await pending;
    console.log(JSON.stringify({ alive, kept: kept?.length ?? 0, size: result.ok ? result.bytes.byteLength : -1 }));
  `;
  const run = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", probe], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return JSON.parse(run.stdout) as { alive: number; size: number };
}

describe("memory while reading", () => {
  it("keeps about the limit alive, not every chunk's parent buffer", () => {
    const { alive, size } = measure(false);
    expect(size).toBe(2000);
    // Kept chunks: 2000 x 64 KiB = 125 MiB.
    expect(alive).toBeLessThan(16 * 1024 * 1024);
  }, 30_000);

  it("sees the parent buffers when something keeps them", () => {
    const { alive, size } = measure(true);
    expect(size).toBe(2000);
    expect(alive).toBeGreaterThan(KEPT);
  }, 30_000);
});
