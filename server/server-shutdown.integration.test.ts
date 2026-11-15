// Graceful shutdown over real processes (S-1B-c, DAN-778; contract
// c.6893332476, decision c.6893347945 (0) A): `node server/server.ts` for the
// wiring of the real entry, and test-support/shutdown-entry for a request that
// takes time, which the real entry has no route for. Invented values only.
import { type ChildProcess, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

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
  const child = spawn(process.execPath, [entry, ...args], {
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

describe("server/server.ts shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s: closes an idle kept-alive connection, stops listening and exits 0",
    async (signal) => {
      const server = await start(SERVER);
      const idle = await open(server.port);
      idle.socket.write(GET("/api/v1/health"));
      await until(() => idle.text().includes('{"status":"ok"}'));

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
      const child = spawn(process.execPath, [SERVER], {
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
      expect(bodyOf(slow.text())).toBe('{"status":"ok"}');
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
    expect(bodyOf(racing.text())).toBe('{"error":"unavailable"}');
    await slow.closed;
    expect(bodyOf(slow.text())).toBe('{"status":"ok"}');
    expect(await server.exit).toBe(0);
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
