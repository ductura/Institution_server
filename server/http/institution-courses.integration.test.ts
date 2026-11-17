// DAN-852-4a (contract Ductus#1836 c.6947710352): POST
// /api/v1/institution/courses on a real server with the real pipeline, over
// the real institution service and a fake InstitutionCourses port. Every
// vector a socket can reach is sent as its bytes; every refusal before the
// port leaves it uncalled. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CourseCreateOutcome, CourseInput, InstitutionCourses } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionCourseRoutes } from "./institution-courses.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/institution.courses.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const CREATED = VECTORS.find((v) => v.name === "created")!;
const ORIGIN = CREATED.request.headers.origin!;
const COOKIE = CREATED.request.headers.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const ID = CREATED.response.body.id as string;
const GOOD = CREATED.request.body as CourseInput;

let server: Running | undefined;
const calls = { port: [] as [string, CourseInput][], activity: [] as string[] };
let answer: () => Promise<CourseCreateOutcome> = async () => ({ status: "created", id: ID });
let activity: () => Promise<unknown> = async () => undefined;

async function start() {
  const courses = {
    createCourse: async (token: string, course: CourseInput) => {
      calls.port.push([token, course]);
      return answer();
    },
  } as unknown as InstitutionCourses;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInstitutionCourseRoutes({
      courses,
      recordActivity: (token) => {
        calls.activity.push(token);
        return activity();
      },
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.port.length = 0;
  calls.activity.length = 0;
  answer = async () => ({ status: "created", id: ID });
  activity = async () => undefined;
  vi.restoreAllMocks();
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

/** One request as bytes; `headers` is a list so a header can be sent twice. */
function raw(headers: [string, string][], body: string | Buffer = ""): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST /api/v1/institution/courses HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}
const headers = (cookie = COOKIE, type = "application/json"): [string, string][] => [
  ["origin", ORIGIN],
  ["sec-fetch-site", "same-origin"],
  ["content-type", type],
  ["cookie", cookie],
];
const post = (body: string | Buffer, list = headers()) => send(raw(list, body));
const good = (change: Record<string, unknown> = {}) => JSON.stringify({ ...GOOD, ...change });
const codeOf = (got: Answer) => [got.status, (JSON.parse(got.body) as { code: string }).code];

// A short body under a longer Content-Length is a wait (408) or a client gone
// on a real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const REACHES_PORT = new Set(["created", "forbidden", "conflict", "unavailable"]);
const OUTCOME: Record<string, CourseCreateOutcome> = {
  forbidden: { status: "forbidden" },
  conflict: { status: "conflict" },
  unavailable: { status: "unavailable", reason: "database_error" },
};

describe("every vector a socket can reach", () => {
  it.each(VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (_name, v) => {
      const outcome = OUTCOME[v.name];
      if (outcome !== undefined) answer = async () => outcome;
      await start();
      const body = v.request.rawBody ?? JSON.stringify(v.request.body);
      const got = await send(raw(Object.entries(v.request.headers), body));
      expect(got.status).toBe(v.response.status);
      if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
      expect(got.head["content-type"]?.split(";")[0]).toBe("application/json");
      expect(got.head["cache-control"]).toBe("no-store");
      const json = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 200) expect(json).toEqual(v.response.body);
      else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      expect(calls.port).toEqual(REACHES_PORT.has(v.name) ? [[TOKEN, GOOD]] : []);
      expect(calls.activity).toEqual(got.status === 200 ? [TOKEN] : []);
    },
  );
});

describe("refusals before the port", () => {
  it("the token comes before the media type and the declared length", async () => {
    await start();
    const bare = headers().filter(([k]) => k !== "cookie");
    const typed = bare.map(([k, v]): [string, string] => [
      k,
      k === "content-type" ? "text/plain" : v,
    ]);
    expect(codeOf(await post(good(), typed))).toEqual([401, "unauthorized"]);
    const long = await send(raw([...bare, ["content-length", "99999999"]], good()));
    expect(codeOf(long)).toEqual([401, "unauthorized"]);
    expect(calls.port).toEqual([]);
  });

  it("an ended session, two cookies or a token of the wrong length is 401", async () => {
    const { sessionTag } = await import("../session/index.ts");
    await start();
    for (const list of [
      headers(`${COOKIE}; ductus-ended-${sessionTag(TOKEN)!}=1`),
      [...headers(), ["cookie", COOKIE]] as [string, string][],
      headers(`__Host-ductus_session=${TOKEN.slice(1)}`),
      headers(`${COOKIE}A`),
    ]) {
      expect(codeOf(await post(good(), list))).toEqual([401, "unauthorized"]);
    }
    expect(calls.port).toEqual([]);
  });

  it("only the media type application/json, sent once, is accepted", async () => {
    await start();
    for (const type of [
      "",
      "application/json, application/json",
      "application/jsonx",
      "text/json",
    ]) {
      expect(codeOf(await post(good(), headers(COOKIE, type)))).toEqual([
        415,
        "unsupported_media_type",
      ]);
    }
    const twice = [...headers(), ["content-type", "application/json"]] as [string, string][];
    expect(codeOf(await post(good(), twice))).toEqual([415, "unsupported_media_type"]);
    expect(calls.port).toEqual([]);
    for (const type of [
      "application/json;charset=utf-8",
      "APPLICATION/JSON ; x=y",
      "application/json\t;q",
    ]) {
      expect((await post(good(), headers(COOKIE, type))).status).toBe(200);
    }
    expect(calls.port).toHaveLength(3);
  });

  it("a byte order mark, broken UTF-8 or an empty body is invalid_json", async () => {
    await start();
    for (const body of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good())]),
      Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')]),
      "",
    ]) {
      expect(codeOf(await post(body))).toEqual([400, "invalid_json"]);
    }
    expect(calls.port).toEqual([]);
  });

  it("a chunked body past 2048 bytes is cut off with 413; 2048 bytes reach the parser", async () => {
    await start();
    const big = `${"x".repeat(2049)}`;
    const chunked = [...headers(), ["transfer-encoding", "chunked"]] as [string, string][];
    const got = await send(raw(chunked, `${(2049).toString(16)}\r\n${big}\r\n0\r\n\r\n`));
    expect(codeOf(got)).toEqual([413, "body_too_large"]);
    const exact = good({ name: "a".repeat(2048 - good({ name: "" }).length) });
    expect(Buffer.byteLength(exact)).toBe(2048);
    expect(codeOf(await post(exact))).toEqual([422, "invalid_input"]); // name over 160: the parser
    expect(calls.port).toEqual([]);
  });
});

describe("input classes the parser alone does not see", () => {
  it("a wire __proto__ key or CRLF or tab at an edge of the name is 422 without a call", async () => {
    await start();
    for (const body of [
      `{"__proto__":{},${good().slice(1)}`,
      good({ name: "\r\nIzmišljeni" }),
      good({ name: "Izmišljeni\t" }),
    ]) {
      expect(codeOf(await post(body))).toEqual([422, "invalid_input"]);
    }
    expect(calls.port).toEqual([]);
  });

  it("a duplicate key hands the port its last value; an inner DEL passes unchanged", async () => {
    await start();
    await post(`{"name":"Prvi",${good().slice(1)}`);
    await post(good({ name: "Izmišljeni\u007fkolegij" }));
    expect(calls.port.map(([, course]) => course.name)).toEqual([
      GOOD.name,
      "Izmišljeni\u007fkolegij",
    ]);
  });
});

describe("outcomes and activity", () => {
  it("invalid is 422; unavailable, an unknown status and a throw are 503 without detail", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const [outcome, expected] of [
      [async () => ({ status: "invalid" }), [422, "invalid_input"]],
      [async () => ({ status: "unavailable", reason: "secret-reason" }), [503, "unavailable"]],
      [async () => ({ status: "surprise" }), [503, "unavailable"]],
      [() => Promise.reject(new TypeError("secret-message")), [503, "unavailable"]],
    ] as const) {
      answer = outcome as () => Promise<CourseCreateOutcome>;
      await start();
      const got = await post(good());
      expect(codeOf(got)).toEqual(expected);
      expect(got.body).not.toMatch(/secret/);
      await server!.close();
      server = undefined;
    }
    expect(calls.activity).toEqual([]);
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/secret/);
  });

  it("activity that throws or never settles still answers 200", async () => {
    for (const next of [() => Promise.reject(new Error("x")), () => new Promise(() => undefined)]) {
      activity = next;
      await start();
      const got = await post(good());
      expect([got.status, JSON.parse(got.body)]).toEqual([200, { id: ID }]);
      await server!.close();
      server = undefined;
    }
    expect(calls.activity).toEqual([TOKEN, TOKEN]);
  });
});
