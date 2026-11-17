// Graceful shutdown over real processes (S-1B-c, DAN-778; contract
// c.6893332476, decision c.6893347945 (0) A): `node server/server.ts` for the
// wiring of the real entry, and test-support/shutdown-entry for a request that
// takes time, which the real entry has no route for. Invented values only.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../scripts/build/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "server/server.ts");
const SLOW_ENTRY = join(ROOT, "test-support/shutdown-entry/shutdown-entry.ts");
const CANARY = "invented-canary-91e4";
const DATABASE_URL = `postgres://app:${CANARY}@db.invalid:5432/ductura`;

type Started = {
  child: ChildProcess;
  port: number;
  out: () => string;
  err: () => string;
  exit: Promise<number | null>;
};
const children: ChildProcess[] = [];

async function start(
  entry: string,
  env: Record<string, string> = {},
  args: readonly string[] = [],
): Promise<Started> {
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, entry, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", PORT: "0", APP_DATABASE_URL: DATABASE_URL, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = stdout
      .join("")
      .split("\n")
      .find((l) => l.includes("server.listening"));
    if (line !== undefined) {
      const { port } = JSON.parse(line) as { port: number };
      return { child, port, out: () => stdout.join(""), err: () => stderr.join(""), exit };
    }
    if (child.exitCode !== null) throw new Error(`exited: ${stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not start");
}

afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
});

/** A raw connection: what it receives and when it closes. */
async function open(
  port: number,
): Promise<{ socket: Socket; text: () => string; closed: Promise<void> }> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) =>
    socket.once("connect", resolve).once("error", reject),
  );
  const chunks: string[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { socket, text: () => chunks.join(""), closed };
}

const GET = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const statusOf = (raw: string): string => raw.split("\r\n", 1)[0] ?? "";
/** The body, joined from its chunks when it is sent chunked. */
function bodyOf(raw: string): string {
  const [head = "", rest = ""] = [
    raw.slice(0, raw.indexOf("\r\n\r\n")),
    raw.slice(raw.indexOf("\r\n\r\n") + 4),
  ];
  if (!/transfer-encoding: chunked/iu.test(head)) return rest;
  let body = "";
  let at = 0;
  for (;;) {
    const end = rest.indexOf("\r\n", at);
    const size = Number.parseInt(rest.slice(at, end), 16);
    if (!(size > 0)) return size === 0 ? body : "<incomplete>";
    body += rest.slice(end + 2, end + 2 + size);
    at = end + 2 + size + 2;
  }
}

/** Health of test-support/shutdown-entry (main database a stub that is up): the alive-current vector. */
const HEALTH_BODY = JSON.stringify({
  ...(
    JSON.parse(
      readFileSync(new URL("contracts/vectors/platform.health.get.json", import.meta.url), "utf8"),
    ) as { vectors: { name: string; response: { body: object } }[] }
  ).vectors.find((v) => v.name === "alive-current")?.response.body,
  serverVersion: "0.0.0",
});

/** The problem body of 503 unavailable (S-1L.3), with a request id of the server's own. */
const UNAVAILABLE =
  /\{"error":"unavailable","code":"unavailable","messageKey":"errors\.unavailable","status":503,"requestId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}/u;

describe("server/server.ts shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s: closes an idle kept-alive connection, stops listening and exits 0",
    async (signal) => {
      const server = await start(SERVER);
      const idle = await open(server.port);
      idle.socket.write(GET("/api/v1/health"));
      // The main database is .invalid here, so health answers `degraded` (S-1M-a).
      await until(() => idle.text().includes('{"status":"ok","state":"degraded",'));

      server.child.kill(signal);
      await idle.closed;
      expect(await server.exit).toBe(0);
      await expect(open(server.port)).rejects.toThrow();
      expect(server.err()).toBe("");
      expect(server.out() + server.err()).not.toContain(CANARY);
    },
    20_000,
  );

  it.each([
    ["a word", "abc"],
    ["below the minimum", "99"],
    ["above the maximum", "30001"],
    ["a leading zero", "0100"],
    ["a trailing space", "100 "],
  ])(
    "does not start with SHUTDOWN_GRACE_MS as %s",
    async (_, value) => {
      const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, SERVER], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          PORT: "0",
          APP_DATABASE_URL: DATABASE_URL,
          SHUTDOWN_GRACE_MS: value,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(child);
      const stderr: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code).toBe(1);
      expect(stderr.join("")).toContain("startup refused: SHUTDOWN_GRACE_MS is not a whole number");
    },
    20_000,
  );
});

// DAN-834-5a: METRICS_INTERVAL_MS is checked with the rest of the environment,
// and the line names the variable, never the value (invented markers).
describe("server/server.ts metrics interval", () => {
  it.each([
    ["a word", "abc9137"],
    ["below the minimum", "4999"],
    ["above the maximum", "3600001"],
    ["CRLF", "19137\r\n"],
    ["a leading NBSP", "\u00a019137"],
    ["a trailing DEL", "19137\u007f"],
    ["a Windows path", "C:\\x9137"],
  ])(
    "does not start with METRICS_INTERVAL_MS as %s",
    async (_, value) => {
      const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, SERVER], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          PORT: "0",
          APP_DATABASE_URL: DATABASE_URL,
          METRICS_INTERVAL_MS: value,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      const output: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => output.push(String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => output.push(String(chunk)));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code).toBe(1);
      expect(output.join("")).toBe(
        "startup refused: METRICS_INTERVAL_MS is not a whole number from 5000 to 3600000\n",
      );
    },
    20_000,
  );

  it("stops on SIGTERM before the first round with exit 0 and nothing on stderr", async () => {
    const server = await start(SERVER, { METRICS_INTERVAL_MS: "5000" });
    server.child.kill("SIGTERM");
    expect(await server.exit).toBe(0);
    expect(server.err()).toBe("");
  }, 20_000);

  // Review on 869426c: the entry starts the collector. Without LOGS_DATABASE_URL
  // the first round after 5 s is skipped as write_failed, by its reason only.
  it("runs a round after the interval: write_failed without a logs database, then exit 0", async () => {
    const server = await start(SERVER, { METRICS_INTERVAL_MS: "5000" });
    await until(() => server.err().includes("metrics.round_skipped"), 12_000);
    server.child.kill("SIGTERM");
    expect(await server.exit).toBe(0);
    const lines = server
      .err()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as object);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "metrics.round_skipped",
        fields: { reason: "write_failed" },
      }),
    ]);
    expect(server.out() + server.err()).not.toContain(CANARY);
  }, 30_000);
});

describe("shutdown in the middle of a slow request", () => {
  it.each([
    ["SIGTERM", ["SIGTERM"]],
    ["SIGTERM twice", ["SIGTERM", "SIGTERM"]],
    ["SIGINT, then SIGTERM", ["SIGINT", "SIGTERM"]],
  ] as const)(
    "%s: the started request finishes whole, then exit 0",
    async (_, signals) => {
      const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["800"]);
      const slow = await open(server.port);
      slow.socket.write(GET("/api/v1/health?slow"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const signal of signals) server.child.kill(signal);
      await slow.closed;
      expect(statusOf(slow.text())).toBe("HTTP/1.1 200 OK");
      expect(bodyOf(slow.text())).toBe(HEALTH_BODY);
      expect(await server.exit).toBe(0);
      expect(server.err()).toBe("");
    },
    20_000,
  );

  it("a request that arrives at the signal gets 503 in the contract format and no route", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["800"]);
    const slow = await open(server.port);
    slow.socket.write(GET("/api/v1/health?slow"));
    // Headers half sent when the signal comes; the rest after it.
    const racing = await open(server.port);
    racing.socket.write("GET /api/v1/health HTTP/1.1\r\nHost: local");
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    racing.socket.write("host\r\n\r\n");
    await racing.closed;
    expect(statusOf(racing.text())).toBe("HTTP/1.1 503 Service Unavailable");
    expect(racing.text().toLowerCase()).toContain("connection: close");
    expect(racing.text().toLowerCase()).toContain("cache-control: no-store");
    expect(bodyOf(racing.text())).toMatch(UNAVAILABLE);
    await slow.closed;
    expect(bodyOf(slow.text())).toBe(HEALTH_BODY);
    expect(await server.exit).toBe(0);
  }, 20_000);

  // QA on c3862f3, F1: a response that is sent while draining tells the
  // client not to reuse the connection.
  it("a response sent while draining says Connection: close", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["400"]);
    const first = await open(server.port);
    first.socket.write(GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await open(server.port);
    second.socket.write(GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.child.kill("SIGTERM");
    await first.closed;
    expect(statusOf(first.text())).toBe("HTTP/1.1 200 OK");
    expect(first.text().toLowerCase()).toContain("connection: close");
    expect(first.text().toLowerCase()).not.toContain("keep-alive");
    await second.closed;
    expect(await server.exit).toBe(0);
  }, 20_000);

  // Codex review on 7c473c5: requests already accepted on one pipelined
  // connection all get their answer; only the last one closes it.
  it("pipelined requests accepted before the signal all get their answer, then exit 0", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["400"]);
    const piped = await open(server.port);
    piped.socket.write(GET("/api/v1/health?slow") + GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");
    await piped.closed;
    expect(piped.text().match(/HTTP\/1\.1 200 OK/gu)).toHaveLength(2);
    expect(await server.exit).toBe(0);
    expect(server.err()).toBe("");
  }, 20_000);

  // Review on 132af0a: a queued pipelined response gets no close event when
  // the client leaves; its ticket must still end with the socket.
  it("pipelined requests whose client leaves: the handlers finish, exit 0 well before the deadline", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "8000" }, ["800"]);
    const piped = await open(server.port);
    // A slow first and a fast second: the second answer waits queued, with no
    // socket of its own, behind the first.
    piped.socket.write(GET("/api/v1/health?slow") + GET("/api/v1/health"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    piped.socket.destroy();
    expect(await server.exit).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(4_000);
    expect(server.out().match(/"event":"route\.done"/gu)).toHaveLength(1);
    expect(server.err()).toBe("");
  }, 20_000);

  // QA on c4d4f62: a request sent on the same connection after the signal,
  // behind one still running, gets its 503 instead of a closed connection.
  it("a request on the same connection after the signal gets 503 after the running one", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    conn.socket.write(GET("/api/v1/health"));
    await conn.closed;
    const statuses = conn.text().match(/HTTP\/1\.1 \d{3}/gu);
    expect(statuses).toEqual(["HTTP/1.1 200", "HTTP/1.1 503"]);
    expect(conn.text()).toMatch(UNAVAILABLE);
    expect(await server.exit).toBe(0);
    expect(server.out().match(/"event":"route\.done"/gu)).toHaveLength(1);
  }, 20_000);

  // QA on c3862f3, F2: a body larger than the socket buffers reaches a slow
  // reader whole before the process exits 0.
  it("a large body to a client that reads late arrives whole, then exit 0", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" });
    const big = await open(server.port);
    big.socket.pause();
    big.socket.write(GET("/api/v1/health?big"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(server.child.exitCode).toBeNull();
    big.socket.resume();
    expect(await server.exit).toBe(0);
    await big.closed;
    expect(bodyOf(big.text())).toHaveLength(5 * 1024 * 1024);
  }, 20_000);

  // QA on c3862f3, F3: a client that leaves does not end the drain while its
  // handler still runs.
  it("a client that disconnects mid-request: the handler still finishes before exit 0", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["1000"]);
    const leaving = await open(server.port);
    leaving.socket.write(GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    leaving.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.child.exitCode).toBeNull();
    expect(await server.exit).toBe(0);
    expect(server.out()).toContain('"event":"route.done"');
  }, 20_000);

  it("a request longer than the deadline: exit 1 within the deadline, with the reason", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "300" }, ["60000"]);
    const slow = await open(server.port);
    slow.socket.write(GET("/api/v1/health?slow"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    expect(await server.exit).toBe(1);
    expect(Date.now() - signalled).toBeLessThan(3_000);
    await slow.closed;
    expect(slow.text()).toBe("");
    const line = JSON.parse(server.err().trim()) as { event: string; fields: unknown };
    expect([line.event, line.fields]).toEqual([
      "shutdown.deadline",
      { phase: "requests", requests: 1 },
    ]);
  }, 20_000);

  it.each([
    [
      "hangs",
      "hang",
      { event: "shutdown.deadline", fields: { phase: "hooks", hook: "databases", requests: 0 } },
    ],
    [
      "throws",
      "throw",
      { event: "shutdown.hook_failed", fields: { hook: "databases", error: "TypeError" } },
    ],
  ])(
    "a hook that %s: exit 1 with the reason and no message",
    async (_, hook, expected) => {
      const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "300" }, ["0", hook]);
      server.child.kill("SIGTERM");
      expect(await server.exit).toBe(1);
      const line = JSON.parse(server.err().trim()) as { event: string; fields: unknown };
      expect({ event: line.event, fields: line.fields }).toEqual(expected);
      expect(server.err()).not.toContain("invented-hook-secret");
    },
    20_000,
  );
});

// DAN-778 c3, contract Ductus#1836 c.6895155382 (point 5 and 6): every request
// parsed while draining gets its 503; only the last one on a connection closes it.
// T1 to T3 (the FAILs on #53) are the pipelined tests above.
describe("requests parsed while draining", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Status and Connection header of each response, in order. */
  const heads = (raw: string): string[] =>
    raw
      .split(/(?=HTTP\/1\.1 \d{3})/u)
      .filter((part) => part.startsWith("HTTP/1.1"))
      .map((part) => {
        const status = part.slice(9, 12);
        const connection = /\r\nconnection: ([^\r]+)/iu.exec(part)?.[1]?.toLowerCase() ?? "-";
        return `${status} ${connection}`;
      });
  const POST = "POST /api/v1/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n";

  it("T4: two requests in one write behind a running one get 503 each, the last closes", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    conn.socket.write(GET("/api/v1/health") + GET("/api/v1/health"));
    await conn.closed;
    expect(heads(conn.text())).toEqual(["200 keep-alive", "503 keep-alive", "503 close"]);
    expect(conn.text().match(new RegExp(UNAVAILABLE.source, "gu"))).toHaveLength(2);
    // Each refusal has an id of its own.
    const ids = [...conn.text().matchAll(/"requestId":"([^"]+)"/gu)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(conn.text().match(/retry-after: 1/giu)).toHaveLength(2);
    expect(await server.exit).toBe(0);
    expect(server.err()).toBe("");
  }, 20_000);

  it("T5: two requests in separate writes behind a running one get 503 each", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["800"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    conn.socket.write(GET("/api/v1/health"));
    await sleep(100);
    conn.socket.write(GET("/api/v1/health"));
    await conn.closed;
    expect(heads(conn.text())).toEqual(["200 keep-alive", "503 keep-alive", "503 close"]);
    expect(await server.exit).toBe(0);
  }, 20_000);

  it("T6: a connection never served gets 503 for each request sent after the signal", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const busy = await open(server.port);
    busy.socket.write(GET("/api/v1/health?slow"));
    const fresh = await open(server.port);
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    fresh.socket.write(GET("/api/v1/health") + GET("/api/v1/health"));
    await fresh.closed;
    expect(heads(fresh.text())).toEqual(["503 keep-alive", "503 close"]);
    await busy.closed;
    expect(statusOf(busy.text())).toBe("HTTP/1.1 200 OK");
    expect(await server.exit).toBe(0);
  }, 20_000);

  it("T7: a request whose headers end after the signal gets 503 and the connection closes", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const busy = await open(server.port);
    busy.socket.write(GET("/api/v1/health?slow"));
    const half = await open(server.port);
    half.socket.write("GET /api/v1/health HTTP/1.1\r\nHo");
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    half.socket.write("st: localhost\r\n\r\n");
    await half.closed;
    expect(heads(half.text())).toEqual(["503 close"]);
    expect(await server.exit).toBe(0);
  }, 20_000);

  it("T8: a flood of pipelined requests gets at most 16 answers, then the connection closes", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "8000" }, ["400"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await sleep(100);
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    await sleep(100);
    conn.socket.write(GET("/api/v1/health").repeat(100));
    await conn.closed;
    const answers = heads(conn.text());
    expect(answers[0]).toBe("200 keep-alive");
    expect(answers.slice(1)).toEqual([...Array(15).fill("503 keep-alive"), "503 close"]);
    expect(await server.exit).toBe(0);
    // Adversarial QA on 9d57162, F2: no MaxListenersExceededWarning on stderr.
    expect(server.err()).toBe("");
    expect(Date.now() - signalled).toBeLessThan(4_000);
  }, 20_000);

  it("T9: a refused request with a body closes the connection; nothing after it is read", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    conn.socket.write(POST + "0123456789" + GET("/api/v1/health"));
    await conn.closed;
    expect(heads(conn.text())).toEqual(["200 keep-alive", "503 close"]);
    expect(await server.exit).toBe(0);
  }, 20_000);

  // Adversarial QA on 9d57162, F3 and F4: an HTTP/1.0 keep-alive request and
  // Content-Length: 00 are refused without closing the connection.
  it("an HTTP/1.0 keep-alive request and an empty body of length 00 keep the connection for the next", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["600"]);
    const conn = await open(server.port);
    conn.socket.write(GET("/api/v1/health?slow"));
    await sleep(100);
    server.child.kill("SIGTERM");
    await sleep(100);
    conn.socket.write(
      "GET /api/v1/health HTTP/1.0\r\nConnection: keep-alive\r\n\r\n" +
        "POST /api/v1/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 00\r\n\r\n" +
        GET("/api/v1/health"),
    );
    await conn.closed;
    expect(heads(conn.text())).toEqual([
      "200 keep-alive",
      "503 keep-alive",
      "503 keep-alive",
      "503 close",
    ]);
    expect(await server.exit).toBe(0);
  }, 20_000);

  // Adversarial QA on 9d57162, F1: a client that reads late, with requests
  // still unread in the kernel, gets every body whole and both 503s; the
  // connection ends with FIN, not a reset that drops what the kernel holds.
  it("a slow reader with requests sent after the signal gets every body whole, then FIN", async () => {
    const server = await start(SLOW_ENTRY, { SHUTDOWN_GRACE_MS: "5000" }, ["0"]);
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const chunks: Buffer[] = [];
    let ending = "open";
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => (ending = error.code ?? "error"));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.pause();
    socket.write(GET("/api/v1/health?big") + GET("/api/v1/health?big"));
    await sleep(200);
    server.child.kill("SIGTERM");
    await sleep(50);
    socket.write(GET("/api/v1/health"));
    await sleep(50);
    socket.write(GET("/api/v1/health"));
    await sleep(100);
    socket.resume();
    await closed;
    const raw = Buffer.concat(chunks).toString("latin1");
    expect(ending).toBe("open");
    expect(heads(raw)).toEqual(["200 keep-alive", "200 keep-alive", "503 keep-alive", "503 close"]);
    expect(raw.match(/x{5242880}/gu)).toHaveLength(2);
    expect(await server.exit).toBe(0);
    expect(server.err()).toBe("");
  }, 20_000);
});
