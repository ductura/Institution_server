// DAN-1568: the client error route on a real server with the real pipeline
// and router, as client-context.integration.test.ts does for its route. Every
// vector of client.error.post is sent as its bytes; every class of input
// outside the closed lists is 400 and records nothing; the session is never
// read; a failing log never changes the 204; step 4 limits it like any route.
// All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { createFakeClock } from "@ductura/test-fakes";
import { afterEach, describe, expect, it } from "vitest";

import { CLIENT_ERROR_VALUES } from "../contracts/index.ts";
import { checkEvent, EVENT_CATALOG, type LogWriter } from "../log/index.ts";
import { createRateLimiter, type RateLimits } from "../traffic/index.ts";

import { createClientErrorRoute } from "./client-error.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body?: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/client.error.post.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const GOOD = vectors.find((v) => v.name === "recorded")!.request;
const ORIGIN = GOOD.headers.origin!;
const BODY = GOOD.body as Record<string, string>;

/** The JCS text of a flat object of strings: keys in code point order, no white space. */
const jcs = (value: Record<string, unknown>) =>
  `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
    .join(",")}}`;

let server: Running | undefined;
const records: unknown[] = [];
const recording: LogWriter = async (input) => {
  records.push(input);
  return { ok: false, error: { code: "LOG_STORE_FAILED", messageKey: "x" } };
};

async function start(options: { log?: LogWriter; perIp?: number } = {}) {
  const limits: RateLimits = {
    login: { perIp: 30, perAccount: null },
    enroll: { perIp: 60, perAccount: 10 },
    save: { perIp: 1200, perAccount: 120 },
    default: { perIp: options.perIp ?? 3000, perAccount: 300 },
  };
  const clock = createFakeClock(0);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({
      expectedOrigin: ORIGIN,
      rateLimiter: createRateLimiter({ limits, now: clock.nowMs, sessionTokenOf: () => null }),
    }),
    databases: createDatabases(),
    routes: [
      createClientErrorRoute({
        log: options.log ?? recording,
        timeoutMs: 300,
        now: () => new Date(Date.UTC(2026, 10, 16, 8, 0, 0)),
      }),
    ],
  });
  return server;
}
afterEach(async () => {
  records.length = 0;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = () => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const answer = finish();
      if (!text.includes("\r\n\r\n")) return;
      if (Buffer.byteLength(answer.body) >= Number(answer.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function request(headers: Record<string, string>, body: string | Buffer): Buffer {
  const all = { host: "127.0.0.1", "content-length": String(Buffer.byteLength(body)), ...headers };
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
  const head = `POST /api/v1/client-error HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}
const post = (body: string | Buffer, headers: Record<string, string> = {}) =>
  send(request({ ...GOOD.headers, ...headers }, body) as unknown as string);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// A short body under a longer Content-Length is, on a real socket, a wait
// (408) or a client gone; the reader's own 400 for these two is
// mutation-request.test.ts, and "a client that stops mid-body" below.
const SOCKET_UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);

describe("every vector of client.error.post", () => {
  it.each(vectors.filter((v) => !SOCKET_UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (_name, v) => {
      await start();
      const body = v.request.rawBody ?? jcs(v.request.body as Record<string, unknown>);
      const answer = await send(request(v.request.headers, body) as unknown as string);
      expect(answer.status).toBe(v.response.status);
      if (v.name === "content-length-invalid") return; // Node's parser answers -1 itself.
      expect(answer.head["cache-control"]).toBe("no-store");
      expect(answer.head["set-cookie"]).toBeUndefined();
      if (v.response.status === 204) {
        expect(answer.body).toBe("");
        return;
      }
      expect(JSON.parse(answer.body)).toMatchObject(v.response.body ?? {});
    },
  );
});

describe("the closed lists", () => {
  const cases = Object.entries(CLIENT_ERROR_VALUES).flatMap(([field, values]) =>
    values.map((value) => [field, value] as const),
  );
  it.each(cases)("%s %s is 204 and exactly one record of the catalog", async (field, value) => {
    await start();
    const answer = await post(jcs({ ...BODY, [field]: value }));
    expect(answer.status).toBe(204);
    await settle();
    expect(records).toEqual([
      {
        time: "2026-11-16T08:00:00.000Z",
        event: "client.error_reported",
        requestId: answer.head["x-request-id"],
        accountKind: "anonymous",
        fields: { ...BODY, [field]: value },
      },
    ]);
    expect(checkEvent(records[0])).toMatchObject({ ok: true });
  });

  it("are the lists of the log catalog, so every accepted body is a valid record", () => {
    const fields = EVENT_CATALOG["client.error_reported"].fields;
    for (const [field, values] of Object.entries(CLIENT_ERROR_VALUES)) {
      expect(fields[field as keyof typeof fields]).toEqual({ kind: "code", values });
    }
    expect(Object.keys(fields).sort()).toEqual(Object.keys(BODY).sort());
  });
});

const BAD_VALUES: readonly (readonly [string, unknown])[] = [
  ["another case", "Error"],
  ["a leading space", " error"],
  ["a trailing tab", "error\t"],
  ["CRLF", "error\r\n"],
  ["NBSP", "error\u00a0"],
  ["DEL", "error\u007f"],
  ["an empty string", ""],
  ["toString", "toString"],
  ["__proto__", "__proto__"],
  ["constructor", "constructor"],
  ["a number", 1],
  ["null", null],
  ["true", true],
  ["an array", ["error"]],
  ["an object", { kind: "error" }],
  ["a Windows path", "C:\\Windows"],
  ["a user agent", "Mozilla/5.0 (X11; Linux x86_64)"],
];

describe("anything outside the lists is 400 invalid_input and records nothing", () => {
  const fields = Object.keys(BODY);
  it.each(fields.flatMap((field) => BAD_VALUES.map(([name, value]) => [field, name, value])))(
    "%s: %s",
    async (field, _name, value) => {
      await start();
      const answer = await post(jcs({ ...BODY, [field as string]: value }));
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ code: "invalid_input" });
      await settle();
      expect(records).toEqual([]);
    },
  );

  it.each([
    ["1.4"],
    ["v1.4.0"],
    ["01.4.0"],
    ["1.04.0"],
    ["1.4.0-beta"],
    ["1.4.0+abcdef0"],
    ["1.4.0\n"],
    ["1.4.0.1"],
    ["1234567.0.0"],
    ["１.4.0"],
    ["1.4.0 "],
  ])("appVersion %j", async (appVersion) => {
    await start();
    const answer = await post(jcs({ ...BODY, appVersion }));
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "invalid_input" });
  });

  const withoutKind = Object.fromEntries(Object.entries(BODY).filter(([key]) => key !== "kind"));
  it.each([
    ["an unknown field", jcs({ ...BODY, screenWidth: 1920 })],
    ["a user agent field", jcs({ ...BODY, userAgent: "x" })],
    ["toString as a field", jcs({ ...BODY, toString: "x" })],
    ["__proto__ as a field", jcs(BODY).replace("{", '{"__proto__":{"kind":"error"},')],
    ["constructor as a field", jcs({ ...BODY, constructor: "x" })],
    ["a missing field", jcs(withoutKind)],
    ["an empty object", "{}"],
    ["a duplicate key", jcs(BODY).replace('"kind":"error"', '"kind":"error","kind":"error"')],
    ["keys out of order", JSON.stringify({ kind: "error", ...BODY })],
    ["white space", JSON.stringify(BODY, null, 1)],
    ["an escaped letter", jcs(BODY).replace('"error"', '"\\u0065rror"')],
    ["an array", `[${jcs(BODY)}]`],
    ["a string", '"error"'],
    ["null", "null"],
    ["a trailing newline", `${jcs(BODY)}\n`],
    ["CRLF after the body", `${jcs(BODY)}\r\n`],
  ])("%s", async (_name, body) => {
    await start();
    const answer = await post(body);
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "invalid_input" });
    await settle();
    expect(records).toEqual([]);
  });

  it.each([
    ["not JSON", Buffer.from("{kind: error}")],
    ["an empty body", Buffer.from("")],
    ["a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(jcs(BODY))])],
    ["bytes that are not UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
  ])("%s is 400 invalid_json", async (_name, body) => {
    await start();
    const answer = await post(body);
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "invalid_json" });
    expect(records).toEqual([]);
  });

  it.each([["text/plain"], ["application/jsonx"], [""], ["multipart/form-data"]])(
    "content type %j is 415",
    async (type) => {
      await start();
      const answer = await post(jcs(BODY), { "content-type": type });
      expect(answer.status).toBe(415);
      expect(answer.head.connection).toBe("close");
    },
  );

  it("a client that stops mid-body is never recorded", async () => {
    await start();
    const whole = jcs(BODY);
    await new Promise<void>((resolve) => {
      const socket = connect(server!.port, "127.0.0.1", () => {
        socket.end(request(GOOD.headers, whole).subarray(0, -10));
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      socket.resume();
    });
    await settle();
    expect(records).toEqual([]);
  });

  it("a body over 256 bytes is 413", async () => {
    await start();
    const answer = await post(jcs({ ...BODY, padding: "x".repeat(300) }));
    expect(answer.status).toBe(413);
  });
});

describe("no login, no access decision", () => {
  it("answers the same with no cookie, a session cookie or a forged one, and records anonymous", async () => {
    await start();
    for (const cookie of [
      undefined,
      "__Host-ductus_session=izmisljeni-token-0001",
      "__Host-ductus_session=%00",
    ]) {
      const answer = await post(jcs(BODY), cookie === undefined ? {} : { cookie });
      expect(answer.status).toBe(204);
      expect(answer.head["set-cookie"]).toBeUndefined();
    }
    await settle();
    expect(records.map((r) => (r as { accountKind: string }).accountKind)).toEqual([
      "anonymous",
      "anonymous",
      "anonymous",
    ]);
  });

  it("a log that refuses, throws or never settles does not change the 204", async () => {
    for (const log of [
      (() => {
        throw new Error("kanarinac");
      }) as LogWriter,
      (() => Promise.reject(new Error("kanarinac"))) as LogWriter,
      (() => new Promise(() => undefined)) as LogWriter,
    ]) {
      await start({ log });
      const answer = await post(jcs(BODY));
      expect(answer.status).toBe(204);
      expect(answer.body).not.toContain("kanarinac");
      await server!.close();
      server = undefined;
    }
  });

  it("without a log service the report is one line of closed codes, and a refused body writes none", async () => {
    const lines: unknown[][] = [];
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: [createClientErrorRoute({ line: (...line) => void lines.push(line) })],
    });
    expect((await post(jcs(BODY))).status).toBe(204);
    expect((await post(jcs({ ...BODY, kind: "haiku" }))).status).toBe(400);
    expect((await post(jcs({ ...BODY, message: "Izmišljena poruka" }))).status).toBe(400);
    expect(lines).toEqual([["warn", "client.error_reported", BODY]]);
  });
});

describe("the pipeline", () => {
  it("refuses a foreign origin before the body (403) and records nothing", async () => {
    await start();
    const answer = await post(jcs(BODY), { origin: "https://drugo.example.invalid" });
    expect(answer.status).toBe(403);
    await settle();
    expect(records).toEqual([]);
  });

  it("limits it per address under the default class (429) without a login", async () => {
    await start({ perIp: 2 });
    expect((await post(jcs(BODY))).status).toBe(204);
    expect((await post(jcs(BODY))).status).toBe(204);
    const limited = await post(jcs(BODY));
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toMatchObject({ code: "too_many_requests" });
    await settle();
    expect(records).toHaveLength(2);
  });

  it("GET is 405", async () => {
    await start();
    const answer = await send(
      `GET /api/v1/client-error HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n`,
    );
    expect(answer.status).toBe(405);
  });
});
