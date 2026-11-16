// Functional check: a user can open their own document,
// and an attempt to open someone else's document is refused.
import { request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { APP_ERRORS, MAX_BODY_BYTES, createApp } from "./app.ts";
import { createStore } from "./store.ts";

const A = "student-a@primjer.invalid";
const B = "student-b@primjer.invalid";

let server: Server;
let base: string;

beforeAll(async () => {
  const store = createStore([
    { id: "a-1", ownerId: A, title: "Rad studenta A", content: "Uvod" },
    { id: "b-1", ownerId: B, title: "Rad studenta B", content: "Tajno" },
    { id: "a-2", ownerId: A, title: "Rad za odbijene izmjene", content: "Netaknuto" },
    { id: "a-3", ownerId: A, title: "Rad za prihvaćene izmjene", content: "Početak" },
  ]);
  server = createApp({ store }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const as = (userId: string) => ({ headers: { authorization: `Bearer ${userId}` } });

it("health answers without login", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("a user opens their own document", async () => {
  const res = await fetch(`${base}/api/documents/a-1`, as(A));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { title: string }).title).toBe("Rad studenta A");
});

it("access to someone else's document is refused", async () => {
  const res = await fetch(`${base}/api/documents/b-1`, as(A));
  expect(res.status).toBe(403);
  expect(await res.text()).not.toMatch(/Tajno/);
});

it("without login there is no access", async () => {
  const res = await fetch(`${base}/api/documents/a-1`);
  expect(res.status).toBe(401);
});

it("another user cannot change the document", async () => {
  const res = await fetch(`${base}/api/documents/b-1`, {
    method: "PUT",
    ...as(A),
    body: JSON.stringify({ content: "x" }),
  });
  expect(res.status).toBe(403);
  const check = await fetch(`${base}/api/documents/b-1`, as(B));
  expect(((await check.json()) as { content: string }).content).toBe("Tajno");
});

// DAN-782: every error answers {code, messageKey}, never a sentence.
it.each([
  ["no login", "/api/documents/a-1", {}, APP_ERRORS.loginRequired],
  ["unknown path", "/api/nepoznato/x/y", as(A), APP_ERRORS.notFound],
  ["unknown document", "/api/documents/nema-1", as(A), APP_ERRORS.documentNotFound],
  ["someone else's document", "/api/documents/b-1", as(A), APP_ERRORS.documentReadForbidden],
  [
    "change of someone else's document",
    "/api/documents/b-1",
    { method: "PUT", ...as(A), body: "{}" },
    APP_ERRORS.documentWriteForbidden,
  ],
  [
    "unsupported method",
    "/api/documents/a-1",
    { method: "DELETE", ...as(A) },
    APP_ERRORS.methodNotAllowed,
  ],
] as const)("answers %s with a code and a key", async (_name, route, init, expected) => {
  const res = await fetch(`${base}${route}`, init);
  expect(res.status).toBe(expected.status);
  const raw = await res.text();
  expect(JSON.parse(raw)).toEqual(expected.body);
  expect(raw).toMatch(/^[\x20-\x7e]*$/u);
  expect(raw).not.toMatch(/"error"/u);
});

// DAN-800: a body the server cannot use answers 400 or 413, quotes nothing of
// the body anywhere and never leaves an unhandled rejection behind.
describe("PUT body that the server cannot use (DAN-800)", () => {
  const SECRET = "TAJNA-izmisljena-800";
  const unhandled: unknown[] = [];
  const record = (e: unknown) => void unhandled.push(e);

  beforeAll(() => {
    process.on("unhandledRejection", record);
    process.on("uncaughtException", record);
  });
  afterAll(() => {
    process.off("unhandledRejection", record);
    process.off("uncaughtException", record);
  });

  const put = (id: string, body: string | Uint8Array) =>
    fetch(`${base}/api/documents/${id}`, { method: "PUT", ...as(A), body });

  /** Runs one exchange while every output the process has is watched. */
  async function silently<T>(run: () => Promise<T>): Promise<{ result: T; written: string }> {
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
      ...(["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];
    try {
      const result = await run();
      await sleep(20);
      return {
        result,
        written: spies
          .flatMap((s) => s.mock.calls)
          .map(String)
          .join("\n"),
      };
    } finally {
      for (const s of spies) s.mockRestore();
    }
  }

  async function expectUntouched(): Promise<void> {
    const res = await fetch(`${base}/api/documents/a-2`, as(A));
    expect(((await res.json()) as { content: string }).content).toBe("Netaknuto");
    expect(unhandled).toEqual([]);
  }

  it.each([
    ["cut-off JSON", `{"content":"${SECRET}`],
    ["text that is not JSON", `nije json ${SECRET}`],
    ["only whitespace", "   "],
    ["null", "null"],
    ["a list", `["${SECRET}"]`],
    ["a number", "5"],
    ["a string", `"${SECRET}"`],
    ["bytes that are not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
  ] as const)("answers %s with 400 and quotes nothing of it", async (_name, body) => {
    const { result: raw, written } = await silently(async () => {
      const res = await put("a-2", body);
      expect(res.status).toBe(400);
      return res.text();
    });
    expect(JSON.parse(raw)).toEqual(APP_ERRORS.invalidJson.body);
    expect(raw).not.toContain(SECRET);
    expect(written).toBe("");
    await expectUntouched();
  });

  /** One raw exchange: the full answer text, or "" when the server closed without one. */
  function raw(head: string, body: Buffer | string): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      let answer = "";
      socket.on("data", (d: Buffer) => (answer += d.toString("utf8")));
      socket.on("error", () => undefined);
      socket.on("close", () => resolve(answer));
      socket.write(head);
      socket.write(body);
    });
  }

  it.each([
    ["with its length announced", true],
    ["sent in chunks without a length", false],
  ])("answers a body over the limit %s with 413", async (_name, announced) => {
    const body = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
    const head = announced
      ? `content-length: ${body.length}\r\n`
      : `transfer-encoding: chunked\r\n`;
    const payload = announced
      ? body
      : Buffer.concat([
          Buffer.from(`${body.length.toString(16)}\r\n`),
          body,
          Buffer.from("\r\n0\r\n\r\n"),
        ]);
    const { result: answer, written } = await silently(() =>
      raw(
        `PUT /api/documents/a-2 HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${A}\r\n${head}\r\n`,
        payload,
      ),
    );
    expect(answer).toMatch(/^HTTP\/1\.1 413 /u);
    expect(answer.toLowerCase()).toContain("connection: close");
    expect(answer).toContain(JSON.stringify(APP_ERRORS.bodyTooLarge.body));
    expect(written).toBe("");
    await expectUntouched();
  });

  it("drops a request cut off in the middle of its body", async () => {
    const { written } = await silently(async () => {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      socket.on("error", () => undefined);
      socket.write(
        `PUT /api/documents/a-2 HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${A}\r\ncontent-length: 100\r\n\r\n{"content":"${SECRET}`,
      );
      await sleep(20);
      socket.destroy();
    });
    expect(written).toBe("");
    await expectUntouched();
  });

  it("keeps an empty body a change of nothing", async () => {
    const res = await put("a-3", "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe("Početak");
  });

  it("takes a body exactly at the limit", async () => {
    const shell = '{"content":""}';
    const content = "a".repeat(MAX_BODY_BYTES - shell.length);
    const res = await put("a-3", JSON.stringify({ content }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toHaveLength(content.length);
  });

  it("keeps a character split across two chunks", async () => {
    const bytes = Buffer.from('{"content":"Uvod č"}', "utf8");
    const cut = bytes.indexOf(Buffer.from("č", "utf8")) + 1;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${base}/api/documents/a-3`,
        { method: "PUT", headers: as(A).headers },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => req.end(bytes.subarray(cut)), 20);
    });
    expect(status).toBe(200);
    const res = await fetch(`${base}/api/documents/a-3`, as(A));
    expect(((await res.json()) as { content: string }).content).toBe("Uvod č");
    expect(unhandled).toEqual([]);
  });
});
