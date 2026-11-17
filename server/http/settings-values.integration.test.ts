// S-1J-g (DAN-826-1b; contract Ductus#1836 c.6934961046): PUT
// /api/v1/settings/values on a real server with the real pipeline, over a
// fake SettingsWriter. Every vector a socket can reach is sent as its bytes,
// cookie included (its token is valid since DAN-826-2b). Every refusal before
// the port leaves it uncalled.
// All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { SettingsWriteOutcome, SettingsWriter, SettingWriteInput } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createSettingsValuesPutRoute } from "./settings-values.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/settings.values.put.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const GOOD = vectors.find((v) => v.name === "saved")!.request;
const ORIGIN = GOOD.headers.origin!;
/** The vectors' own cookie; the cases outside the vectors use it too. */
const COOKIE = GOOD.headers.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const BODY = GOOD.body as Record<string, unknown>;

/** What the fake writer answers for a vector that reaches it. */
function outcomeOf(v: Vector): SettingsWriteOutcome {
  if (v.response.status === 200) return { status: "saved", ...v.response.body } as never;
  const byCode = new Map<unknown, SettingsWriteOutcome>([
    ["not_found", { status: "not_found" }],
    ["bound_crossed", { status: "bound_crossed" }],
    ["unavailable", { status: "unavailable", reason: "db_down" }],
  ]);
  return byCode.get(v.response.body.code) ?? { status: "invalid" };
}

let server: Running | undefined;
const calls: { token: string; write: SettingWriteInput }[] = [];
let answer: (write: SettingWriteInput) => Promise<SettingsWriteOutcome>;

async function start(outcome: () => Promise<SettingsWriteOutcome> | SettingsWriteOutcome) {
  answer = async () => outcome();
  const writer: SettingsWriter = {
    setValue: async (token, write) => {
      calls.push({ token, write });
      return answer(write);
    },
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createSettingsValuesPutRoute({ writer, timeoutMs: 300 })],
  });
}
afterEach(async () => {
  calls.length = 0;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
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
      const got = finish();
      if (!text.includes("\r\n\r\n")) return;
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function request(headers: Record<string, string>, body: string | Buffer): Buffer {
  const all = { host: "127.0.0.1", "content-length": String(Buffer.byteLength(body)), ...headers };
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
  const head = `PUT /api/v1/settings/values HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}
const put = (body: string | Buffer, headers: Record<string, string> = {}) =>
  send(request({ ...GOOD.headers, cookie: COOKIE, ...headers }, body));
const refusal = (got: Answer) => JSON.parse(got.body) as { code: string; messageKey: string };

// A short body under a longer Content-Length is a wait (408) or a client gone
// on a real socket; the reader's own 400 is mutation-request.test.ts and
// "a client that stops mid-body" below.
const SOCKET_UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const REACHES_PORT = new Set(["not-callers-level", "bound-crossed", "unavailable"]);

describe("every vector of settings.values.put a socket can reach", () => {
  it.each(vectors.filter((v) => !SOCKET_UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (_name, v) => {
      await start(() => outcomeOf(v));
      const headers = v.request.headers;
      const got = await send(request(headers, v.request.rawBody ?? JSON.stringify(v.request.body)));
      expect(got.status).toBe(v.response.status);
      if (v.name === "content-length-invalid") return; // Node's parser answers -1 itself.
      expect(got.head["content-type"]?.split(";")[0]).toBe("application/json");
      expect(got.head["cache-control"]).toBe("no-store");
      expect(got.head["set-cookie"]).toBeUndefined();
      const body = JSON.parse(got.body) as Record<string, unknown>;
      if (v.response.status === 200) expect(body).toEqual(v.response.body);
      else expect(body).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      const reached = v.response.status === 200 || REACHES_PORT.has(v.name);
      expect(calls).toEqual(reached ? [expect.objectContaining({ token: TOKEN })] : []);
      if (v.response.status === 401 || v.response.status === 415) {
        expect(got.head.connection).toBe("close");
      }
    },
  );
});

const saved = () => outcomeOf(vectors[0]!);

describe("refusals before the port leave it uncalled", () => {
  it.each([
    ["two Content-Type", { "content-type": "application/json\r\ncontent-type: application/json" }],
    ["text/json", { "content-type": "text/json" }],
    ["application/jsonx", { "content-type": "application/jsonx" }],
  ])("%s is 415", async (_name, headers) => {
    await start(saved);
    const got = await put(JSON.stringify(BODY), headers);
    expect([got.status, refusal(got).code, calls.length]).toEqual([
      415,
      "unsupported_media_type",
      0,
    ]);
  });

  it.each([
    ["no cookie", "other=1"],
    ["two session cookies", `${COOKIE}; ${COOKIE}`],
    ["42 characters", `__Host-ductus_session=${"A".repeat(42)}`],
    ["a space inside", `__Host-ductus_session=${"A".repeat(21)} ${"A".repeat(21)}`],
    ["a tab inside", `__Host-ductus_session=${"A".repeat(21)}\t${"A".repeat(21)}`],
    ["NBSP", `__Host-ductus_session=${"A".repeat(42)}\u00a0`],
    ["percent-encoded", `__Host-ductus_session=${"A".repeat(40)}%41`],
  ])("cookie with %s is 401", async (_name, cookie) => {
    await start(saved);
    const got = await put(JSON.stringify(BODY), { cookie });
    expect([got.status, refusal(got).code, calls.length]).toEqual([401, "unauthorized", 0]);
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
    ["a byte order mark", `\ufeff${JSON.stringify(BODY)}`],
    ["NBSP between tokens", `{\u00a0${JSON.stringify(BODY).slice(1)}`],
  ])("%s is 400 invalid_json", async (_name, body) => {
    await start(saved);
    const got = await put(body);
    expect([got.status, refusal(got).code, calls.length]).toEqual([400, "invalid_json", 0]);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "1"],
    ["a string", '"x"'],
    ["an eighth key", JSON.stringify({ ...BODY, extra: 1 })],
    ...["__proto__", "constructor", "toString"].map((key) => [
      `own key ${key}`,
      `${JSON.stringify(BODY).slice(0, -1)},"${key}":1}`,
    ]),
    ["a boolean as text", JSON.stringify({ ...BODY, value: "true" })],
    ...[14, 121].map((value) => [
      `idle minutes ${value}`,
      JSON.stringify({
        ...BODY,
        level: "network_security",
        key: "network.session_idle_minutes",
        value,
      }),
    ]),
    ...["\r\n", "\t", "\u00a0", "\u007f"].map((mark) => [
      `key with ${JSON.stringify(mark)}`,
      JSON.stringify({ ...BODY, key: `notifications.email${mark}` }),
    ]),
    ["a Windows path key", JSON.stringify({ ...BODY, key: "C:\\x" })],
    [
      "a duplicate key whose last value is wrong",
      `${JSON.stringify(BODY).slice(0, -1)},"value":"x"}`,
    ],
  ])("%s is 422 invalid_input", async (_name, body) => {
    await start(saved);
    const got = await put(body as string);
    expect([got.status, refusal(got).code, calls.length]).toEqual([422, "invalid_input", 0]);
    expect(refusal(got).messageKey).toBe("errors.invalidInput");
  });

  it("a client that stops mid-body never reaches the port", async () => {
    await start(saved);
    const got = await send(
      request({ ...GOOD.headers, cookie: COOKIE, "content-length": "113" }, "{"),
    );
    expect(got.status).toBe(408);
    expect(calls).toEqual([]);
  });
});

describe("the port's outcome", () => {
  it.each([
    ["unauthenticated", () => ({ status: "unauthenticated" }), 401, "unauthorized"],
    ["invalid", () => ({ status: "invalid" }), 422, "invalid_input"],
    ["an unknown status", () => ({ status: "other" }), 503, "unavailable"],
    ["a throw", () => Promise.reject(new Error("izmišljena tajna poruka")), 503, "unavailable"],
  ])("%s", async (_name, outcome, status, code) => {
    await start(outcome as () => Promise<SettingsWriteOutcome>);
    const got = await put(JSON.stringify(BODY));
    expect([got.status, refusal(got).code, calls.length]).toEqual([status, code, 1]);
    expect(got.body).not.toContain("izmišljena");
  });

  it("a duplicate key reaches the port with its last value (JSON.parse)", async () => {
    await start(saved);
    await put(`${JSON.stringify(BODY).slice(0, -1)},"value":true}`);
    expect(calls.map((c) => c.write.value)).toEqual([true]);
  });

  it("answers only key, value, bound and changed", async () => {
    await start(() => ({ ...saved(), secret: "x" }) as never);
    const got = await put(JSON.stringify(BODY));
    expect(JSON.parse(got.body)).toEqual({
      key: "notifications.email",
      value: false,
      bound: null,
      changed: true,
    });
  });
});
