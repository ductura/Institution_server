// SRV-8E: POST /api/v1/teacher/fast-path on a real server with the real
// pipeline, over a fake reader: every vector of the contract a socket can
// reach, the order of the checks, the exact body {assignmentId} and the
// reader's answer written as it is. The reader itself is
// server/teacher/fast-path.test.ts. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createTeacherFastPathRoute, type ReadTeacherFastPath } from "./teacher-fast-path.ts";

type FastPathRead = Awaited<ReturnType<NonNullable<ReadTeacherFastPath>>>;

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/teacher.fast-path.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const PATH = "/api/v1/teacher/fast-path";
const SUMMARY = VECTORS.find((v) => v.name === "students")!;
const HEADERS = SUMMARY.request.headers;
const TOKEN = HEADERS.cookie!.slice("__Host-ductus_session=".length);

let server: Running | undefined;
const calls: [string, string][] = [];
let result: FastPathRead | (() => never) = { kind: "ok", students: [] };

async function start(read?: ReadTeacherFastPath) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createTeacherFastPathRoute({
        read:
          read === undefined
            ? async (token, assignmentId) => {
                calls.push([token, assignmentId]);
                return typeof result === "function" ? result() : result;
              }
            : read,
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  result = { kind: "ok", students: [] };
  calls.length = 0;
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
      if (!text.includes("\r\n\r\n")) return;
      const got = finish();
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function post(body: string, headers: Record<string, string> = HEADERS): Promise<Answer> {
  const all: [string, string][] = [["host", "127.0.0.1"], ...Object.entries(headers)];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${PATH} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return send(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]));
}

const OK = SUMMARY.response.body as { kind: "ok"; students: unknown[] };
const EMPTY = VECTORS.find((v) => v.name === "none-or-not-the-teacher")!;
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const REACHES_READER: Record<string, FastPathRead> = {
  students: OK as FastPathRead,
  "none-or-not-the-teacher": { kind: "ok", students: [] },
  unavailable: { kind: "unavailable" },
};

describe("teacher.fast-path.post: every reachable vector", () => {
  const vectors = VECTORS.filter((v) => !UNREACHABLE.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (name, v) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const arranged = REACHES_READER[name];
    if (arranged !== undefined) result = arranged;
    await start();
    const got = await post(v.request.rawBody ?? JSON.stringify(v.request.body), v.request.headers);
    expect(got.status).toBe(v.response.status);
    if (name === "content-length-invalid") return; // Node's parser answers it itself.
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status === 200) expect(json).toEqual(v.response.body);
    else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
    const sent = (v.request.body as { assignmentId?: string } | undefined)?.assignmentId;
    expect(calls).toEqual(arranged === undefined ? [] : [[TOKEN, sent]]);
  });

  it("the empty vector names no student", () => {
    expect(EMPTY.response.body).toEqual({ kind: "ok", students: [] });
  });
});

describe("the body and the reader's outcomes", () => {
  it("reads the id in lowercase whatever case it came in", async () => {
    await start();
    const got = await post('{"assignmentId":"3A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C01"}');
    expect(got.status).toBe(200);
    expect(calls).toEqual([[TOKEN, "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01"]]);
  });

  const ID = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
  it.each([
    ["a role", `{"assignmentId":"${ID}","role":"teacher"}`],
    ["a student", `{"assignmentId":"${ID}","studentId":"${ID}"}`],
    ["a window", `{"assignmentId":"${ID}","window":"P-03"}`],
    ["a malformed id", '{"assignmentId":"nije-uuid"}'],
    ["a number id", '{"assignmentId":1}'],
    ["no id", "{}"],
    ["an array", `["${ID}"]`],
    ["null", "null"],
  ])("%s is 422 invalid_input without a read", async (_name, text) => {
    await start();
    const got = await post(text);
    expect(got.status).toBe(422);
    expect(JSON.parse(got.body)).toMatchObject({ code: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("checks the cookie before the media type and the media type before the body", async () => {
    await start();
    const anonymous = Object.fromEntries(Object.entries(HEADERS).filter(([k]) => k !== "cookie"));
    expect((await post("nije json", { ...anonymous, "content-type": "text/plain" })).status).toBe(
      401,
    );
    expect((await post("nije json", { ...HEADERS, "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect(calls).toEqual([]);
  });

  it("an unauthorized read is 401; a reader that throws is 503 without the text", async () => {
    result = { kind: "unauthorized" };
    await start();
    const body = `{"assignmentId":"${ID}"}`;
    const expired = await post(body);
    expect([expired.status, JSON.parse(expired.body).code]).toEqual([401, "unauthorized"]);
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    result = () => {
      throw new Error("izmišljeno: tekst rada");
    };
    const thrown = await post(body);
    expect([thrown.status, JSON.parse(thrown.body).code]).toEqual([503, "unavailable"]);
    expect(reported.mock.calls.flat().join(" ")).not.toContain("tekst rada");
  });

  it("invalid thresholds are 503 for every reader, after the body check", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(null);
    expect((await post('{"assignmentId":"x","y":1}')).status).toBe(422);
    const got = await post(`{"assignmentId":"${ID}"}`);
    expect([got.status, JSON.parse(got.body).code]).toEqual([503, "unavailable"]);
    expect(logged.mock.calls.flat().join(" ")).toContain("thresholds_invalid");
    expect(logged.mock.calls.flat().join(" ")).not.toContain(ID);
  });
});
