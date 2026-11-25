// DAN-1537: the smoke test of the real server that replaces the inherited
// skeleton (server/app.ts, server/access.ts, server/store.ts and their tests).
// The process is dist/server.js, built with the same function as `pnpm build`
// into a temporary folder, as in server.integration.test.ts. Each check of the
// old skeleton tests that is about the HTTP boundary is asked here of the real
// pipeline: health without login, no login without a session (a Bearer user id
// is no login, D-09), errors in the contract format, a path that is no URL,
// a body that is no JSON or too large, a body cut off, and nothing of a body
// ever written to the process output. All values are invented; the database
// host is .invalid and nothing connects to it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, SERVER_NODE_FLAGS } from "../scripts/build/index.ts";

import { CLIENT_CONTEXT_MAX_BYTES } from "./http/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANARY = "invented-canary-1537";
const SECRET = "TAJNA-izmisljena-1537";
const FORGED = "student-a@primjer.invalid";
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: Record<string, string> };
  response: { status: number; body?: unknown };
};
const HEALTH = readJson<{ vectors: Vector[] }>(
  "server/contracts/vectors/platform.health.get.json",
).vectors.find((v) => v.name === "degraded")!;
const CONTEXT = readJson<{ vectors: Vector[] }>(
  "server/contracts/vectors/client.context.post.json",
).vectors.find((v) => v.name === "recorded")!;
const ORIGIN = CONTEXT.request.headers.origin!;
const CONTEXT_PATH = "/api/v1/client-context";
// The JCS bytes of the recorded vector: keys in code point order, no white space.
const GOOD_BODY = JSON.stringify(
  Object.fromEntries(Object.entries(CONTEXT.request.body!).sort(([a], [b]) => (a < b ? -1 : 1))),
);

let dir: string | undefined;
let child: ChildProcess | undefined;
let port = 0;
const stdout: string[] = [];
const stderr: string[] = [];

async function listening(): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = stdout
      .join("")
      .split("\n")
      .find((l) => l.includes("server.listening"));
    if (line !== undefined) return (JSON.parse(line) as { port: number }).port;
    if (child?.exitCode !== null) throw new Error(`exited: ${stderr.join("")}`);
    await sleep(25);
  }
  throw new Error("server did not start");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ductura-smoke-"));
  const outfile = join(dir, "server.js");
  await buildServer(ROOT, outfile);
  // No inherited variables: only these (and PATH for node).
  child = spawn(process.execPath, [...SERVER_NODE_FLAGS, outfile], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      PORT: "0",
      APP_DATABASE_URL: `postgres://app:${CANARY}@db.invalid:5432/ductura`,
      APP_ORIGIN: ORIGIN,
      OIDC_CLIENT_SECRET: CANARY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  port = await listening();
}, 60_000);

afterAll(() => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** The problem body of a contract error (S-1L.3): a code and a key, never a sentence. */
const problem = (status: number, code: string) => ({
  error: code,
  code,
  messageKey: expect.stringMatching(/^errors\.[A-Za-z]+$/u),
  status,
  requestId: expect.stringMatching(UUID),
});

/** One raw exchange: the whole answer, or "" when the server closed without one. */
function raw(head: string, body: Buffer | string = ""): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (d: Buffer) => (answer += d.toString("utf8")));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(answer));
    socket.write(head);
    socket.write(body);
  });
}

const contextHead = (length: string) =>
  `POST ${CONTEXT_PATH} HTTP/1.1\r\nhost: x\r\norigin: ${ORIGIN}\r\n` +
  `content-type: application/json\r\n${length}\r\n`;

const postContext = (body: string | Uint8Array) =>
  fetch(url(CONTEXT_PATH), {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });

describe("the inherited skeleton is gone (DAN-1537)", () => {
  const SKELETON = ["server/app.ts", "server/access.ts", "server/store.ts"];

  function sources(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
      return entry.name.endsWith(".ts") ? [relative(ROOT, full).split(sep).join("/")] : [];
    });
  }

  it("has no skeleton file and no file in server/ imports one", () => {
    for (const file of SKELETON) expect(existsSync(join(ROOT, file)), file).toBe(false);
    const importing = sources(join(ROOT, "server")).filter((file) => {
      if (!/^server\/[^/]+$/u.test(file)) return false;
      return /from\s+["']\.\/(?:app|access|store)\.ts["']/u.test(
        readFileSync(join(ROOT, file), "utf8"),
      );
    });
    expect(importing).toEqual([]);
  });

  it("has no production file that reads a user id from a Bearer header", () => {
    const standIn = sources(join(ROOT, "server")).filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        /\bparseBearer\b|\/api\/documents\b/u.test(readFileSync(join(ROOT, file), "utf8")),
    );
    expect(standIn).toEqual([]);
  });

  it("keeps no text of the skeleton errors in locales/hr.json", () => {
    expect(Object.hasOwn(readJson<object>("locales/hr.json"), "app")).toBe(false);
  });
});

describe("smoke test of dist/server.js (DAN-1537)", () => {
  it("answers health without login, as its contract vector", async () => {
    const res = await fetch(url("/api/v1/health"));
    expect(res.status).toBe(HEALTH.response.status);
    expect(((await res.json()) as { status: unknown }).status).toBe(
      (HEALTH.response.body as { status: unknown }).status,
    );
  });

  it.each([
    ["no login", {}],
    ["a user id as a Bearer token", { authorization: `Bearer ${FORGED}` }],
    ["a user id as a Bearer token in other case", { authorization: `bearer ${FORGED}` }],
  ])("refuses %s on a route that needs a session", async (_name, headers) => {
    for (const path of ["/api/v1/me", "/api/v1/student/assignments"]) {
      const res = await fetch(url(path), { headers });
      const text = await res.text();
      expect([res.status, JSON.parse(text)]).toEqual([401, problem(401, "unauthorized")]);
      expect(text).not.toContain("primjer");
    }
  });

  it.each([
    ["an unknown path", "/api/v1/nepoznato/x/y"],
    ["the skeleton's document route", "/api/documents/a-1"],
    ["the skeleton's document list", "/api/documents"],
  ])("answers %s with 404 in the contract format", async (_name, path) => {
    const res = await fetch(url(path), { headers: { authorization: `Bearer ${FORGED}` } });
    const text = await res.text();
    expect([res.status, JSON.parse(text)]).toEqual([404, problem(404, "not_found")]);
    expect(text).toMatch(/^[\x20-\x7e]*$/u);
  });

  it.each(["//", "//a:b", "//["])("answers the path %s that is no URL with 404", async (path) => {
    const answer = await raw(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 404 /u);
    expect(answer).toContain('"code":"not_found"');
  });

  it.each([
    ["cut-off JSON", `{"app":"${SECRET}`, "invalid_json"],
    ["text that is not JSON", `nije json ${SECRET}`, "invalid_json"],
    ["only whitespace", "   ", "invalid_json"],
    ["an empty body", "", "invalid_json"],
    ["bytes that are not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d]), "invalid_json"],
    [
      "a byte that is not UTF-8 inside a string",
      new Uint8Array([...Buffer.from('{"app":"'), 0xff, ...Buffer.from('"}')]),
      "invalid_json",
    ],
    ["null", "null", "invalid_input"],
    ["a list", `["${SECRET}"]`, "invalid_input"],
    ["a number", "5", "invalid_input"],
    ["a string", `"${SECRET}"`, "invalid_input"],
  ] as const)("answers %s with 400 and quotes nothing of it", async (_name, body, code) => {
    const res = await postContext(body);
    const text = await res.text();
    expect([res.status, JSON.parse(text)]).toEqual([400, problem(400, code)]);
    expect(text).not.toContain(SECRET);
  });

  it("reads a body exactly at the limit and refuses one byte more with 413", async () => {
    const padded = `{"app":"${"a".repeat(CLIENT_CONTEXT_MAX_BYTES - 10)}"}`;
    expect(Buffer.byteLength(padded)).toBe(CLIENT_CONTEXT_MAX_BYTES);
    // At the limit the body is read and parsed: a 400 of its content, not 413.
    const at = await postContext(padded);
    expect([at.status, ((await at.json()) as { code: string }).code]).toEqual([
      400,
      "invalid_input",
    ]);
    const over = await raw(contextHead(`content-length: ${padded.length + 1}\r\n`), `${padded} `);
    expect(over).toMatch(/^HTTP\/1\.1 413 /u);
    expect(over.toLowerCase()).toContain("connection: close");
  });

  it("refuses a body over the limit sent in chunks without a length with 413", async () => {
    const body = Buffer.alloc(CLIENT_CONTEXT_MAX_BYTES + 1, 0x61);
    const answer = await raw(
      contextHead("transfer-encoding: chunked\r\n"),
      Buffer.concat([
        Buffer.from(`${body.length.toString(16)}\r\n`),
        body,
        Buffer.from("\r\n0\r\n\r\n"),
      ]),
    );
    expect(answer).toMatch(/^HTTP\/1\.1 413 /u);
    expect(answer.toLowerCase()).toContain("connection: close");
    expect(answer).not.toContain("aaaa");
  });

  it("takes a valid body split across two chunks", async () => {
    const bytes = Buffer.from(GOOD_BODY, "utf8");
    const cut = Math.floor(bytes.length / 2);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url(CONTEXT_PATH),
        { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => req.end(bytes.subarray(cut)), 20);
    });
    expect(status).toBe(CONTEXT.response.status);
  });

  it("survives a request cut off in the middle of its body", async () => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.write(`${contextHead("content-length: 100\r\n")}{"app":"${SECRET}`);
    await sleep(50);
    socket.destroy();
    await sleep(50);
    const res = await fetch(url("/api/v1/health"));
    expect(res.status).toBe(HEALTH.response.status);
  });

  // Last: every exchange above has been answered by the same process.
  it("is still running and wrote nothing of any body, secret or error", async () => {
    await sleep(50);
    expect(child?.exitCode).toBeNull();
    const output = stdout.join("") + stderr.join("");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("primjer");
    expect(stderr.join("")).toBe("");
  });
});
