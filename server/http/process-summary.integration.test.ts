// SRV-23: POST /api/v1/process-summary on a real server with the real
// pipeline, over a fake reader: every vector of the contract a socket can
// reach, the order of the checks, the exact body {documentId} and the reader's
// JCS text written unchanged. The real reader over PostgreSQL is
// tests/db/process-summary-route.integration.test.ts. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import {
  createProcessSummaryRoute,
  type ProcessSummaryReadResult,
  type ReadProcessSummary,
} from "./process-summary.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/projection.process-summary.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const PATH = "/api/v1/process-summary";
const SUMMARY = VECTORS.find((v) => v.name === "summary")!;
const HEADERS = SUMMARY.request.headers;
const TOKEN = HEADERS.cookie!.slice("__Host-ductus_session=".length);

let server: Running | undefined;
const calls: [string, string][] = [];
let result: ProcessSummaryReadResult | (() => never) = { status: "not_found" };

async function start(read?: ReadProcessSummary) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createProcessSummaryRoute({
        read:
          read === undefined
            ? async (token, documentId) => {
                calls.push([token, documentId]);
                return typeof result === "function" ? result() : result;
              }
            : read,
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  result = { status: "not_found" };
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

/** Sorted keys, no spaces: the JCS text of the vector's summary (strings and integers only). */
const jcs = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(jcs).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`)
          .join(",")}}`;

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const REACHES_READER: Record<string, ProcessSummaryReadResult> = {
  summary: { status: "ok", body: jcs(SUMMARY.response.body) },
  "not-found": { status: "not_found" },
  unavailable: { status: "unavailable", reason: "segment_hash_mismatch" },
};

describe("projection.process-summary.post: every reachable vector", () => {
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
    const sent = (v.request.body as { documentId?: string } | undefined)?.documentId;
    expect(calls).toEqual(arranged === undefined ? [] : [[TOKEN, sent]]);
  });
});

describe("the body, the reader's text and its outcomes", () => {
  it("writes the reader's JCS text byte for byte", async () => {
    result = REACHES_READER.summary!;
    await start();
    const got = await post('{"documentId":"izmisljeni-rad-0001"}');
    expect(got.status).toBe(200);
    expect(got.body).toBe((REACHES_READER.summary as { body: string }).body);
    expect(got.head["content-type"]).toBe("application/json; charset=utf-8");
  });

  it.each([
    ["a role", '{"documentId":"rad","role":"teacher"}'],
    ["a threshold", '{"documentId":"rad","sessionBreakAboveMinutes":1}'],
    ["a time", '{"documentId":"rad","at":"2026-11-20T10:00:00Z"}'],
    ["a number id", '{"documentId":1}'],
    ["no id", "{}"],
    ["an array", '["rad"]'],
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

  it("an expired session is 401 as a missing cookie; a reader that throws is 503", async () => {
    result = { status: "unauthenticated" };
    await start();
    const expired = await post('{"documentId":"rad"}');
    expect([expired.status, JSON.parse(expired.body).code]).toEqual([401, "unauthorized"]);
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    result = () => {
      throw new Error("izmišljeno: tekst rada");
    };
    const thrown = await post('{"documentId":"rad"}');
    expect([thrown.status, JSON.parse(thrown.body).code]).toEqual([503, "unavailable"]);
    expect(reported.mock.calls.flat().join(" ")).not.toContain("tekst rada");
  });

  it("invalid thresholds are 503 for every reader, after the body check", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(null);
    expect((await post('{"documentId":"rad","x":1}')).status).toBe(422);
    const got = await post('{"documentId":"rad"}');
    expect([got.status, JSON.parse(got.body).code]).toEqual([503, "unavailable"]);
    expect(logged.mock.calls.flat().join(" ")).toContain("thresholds_invalid");
    expect(logged.mock.calls.flat().join(" ")).not.toContain('"rad"');
  });
});
