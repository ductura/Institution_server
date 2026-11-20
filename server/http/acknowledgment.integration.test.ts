// POST /api/v1/institution/assignments/{assignmentId}/acknowledgment on a
// real server with the real pipeline, over a fake port: every vector a socket
// can reach, and the order of the checks before the body (Ductus
// acknowledgment-route.ts at 078c780, DAN-306). All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { NoticeAcknowledgmentOutcome } from "../database/index.ts";

import { createAcknowledgmentRoute } from "./acknowledgment.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/institution.acknowledgment.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const PATH = (id: string) => `/api/v1/institution/assignments/${id}/acknowledgment`;

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
let outcome: NoticeAcknowledgmentOutcome = { status: "unavailable", reason: "x" };

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createAcknowledgmentRoute({
        acknowledgments: {
          acknowledge: async (token, input) => {
            calls.push([token, input]);
            return outcome;
          },
        },
        templateVersion: 1,
        recordActivity: async (token) => activity.push(token),
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  calls.length = 0;
  activity.length = 0;
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

function raw(path: string, headers: [string, string][], body: string): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.

const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const OUTCOME: Record<string, (v: Vector) => NoticeAcknowledgmentOutcome> = {
  acknowledged: (v) => ({
    status: "acknowledged",
    acknowledgedAt: v.response.body.acknowledgedAt as string,
  }),
  forbidden: () => ({ status: "forbidden" }),
  conflict: () => ({ status: "conflict" }),
  "notice-changed": () => ({ status: "notice_changed" }),
  unavailable: () => ({ status: "unavailable", reason: "database_error" }),
};

describe("every vector a socket can reach", () => {
  it.each(VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (_name, v) => {
      const arrange = OUTCOME[v.name];
      if (arrange !== undefined) outcome = arrange(v);
      await start();
      const body = v.request.rawBody ?? JSON.stringify(v.request.body);
      const got = await send(
        raw(PATH(v.request.params.assignmentId!), Object.entries(v.request.headers), body),
      );
      expect(got.status).toBe(v.response.status);
      if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
      expect(got.head["cache-control"]).toBe("no-store");
      const json = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 200) expect(json).toEqual(v.response.body);
      else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      const token = v.request.headers.cookie?.slice("__Host-ductus_session=".length);
      if (arrange === undefined) expect(calls).toEqual([]);
      else {
        const sent = v.request.body as { versionNo: number; fingerprint: string };
        expect(calls).toEqual([
          [token, { assignmentId: v.request.params.assignmentId, ...sent, templateVersion: 1 }],
        ]);
      }
      expect(activity).toEqual(got.status === 200 ? [token] : []);
    },
  );
});

describe("before the port", () => {
  const v = VECTORS.find((x) => x.name === "acknowledged")!;
  const headers = Object.entries(v.request.headers);
  const body = JSON.stringify(v.request.body);
  const id = v.request.params.assignmentId!;
  const code = (got: Answer) => [got.status, (JSON.parse(got.body) as { code: string }).code];

  it("the assignment id is judged before the session, the session before the media type", async () => {
    await start();
    const bare = headers.filter(([k]) => k !== "cookie");
    expect(code(await send(raw(PATH("nije-uuid"), bare, body)))).toEqual([
      400,
      "invalid_assignment_id",
    ]);
    const typed = bare.map(([k, x]): [string, string] => [
      k,
      k === "content-type" ? "text/plain" : x,
    ]);
    expect(code(await send(raw(PATH(id), typed, body)))).toEqual([401, "unauthorized"]);
    expect(calls).toEqual([]);
  });

  it("only application/json with at most charset=utf-8 is accepted", async () => {
    outcome = { status: "acknowledged", acknowledgedAt: "2026-11-16T07:45:12.345Z" };
    await start();
    const typed = (type: string) =>
      headers.map(([k, x]): [string, string] => [k, k === "content-type" ? type : x]);
    for (const type of [
      "application/json; charset=latin1",
      "application/json; x=y",
      "application/jsonx",
      "text/json",
    ]) {
      expect(code(await send(raw(PATH(id), typed(type), body)))).toEqual([
        415,
        "unsupported_media_type",
      ]);
    }
    for (const type of ["application/json;charset=utf-8", "APPLICATION/JSON ; CHARSET = UTF-8"]) {
      expect((await send(raw(PATH(id), typed(type), body))).status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });

  it("a repeated or escaped key, a byte order mark or a third key never reach the port", async () => {
    await start();
    const FP = (v.request.body as { fingerprint: string }).fingerprint;
    for (const [text, status] of [
      [`{"versionNo":2,"fingerprint":"${"0".repeat(64)}","fingerprint":"${FP}"}`, 422],
      [`{"versionNo":2,"fingerpr\\u0069nt":"${FP}"}`, 422],
      [`\ufeff${body}`, 400],
      [`{"versionNo":2,"fingerprint":"${FP}","x":1}`, 422],
    ] as const) {
      expect((await send(raw(PATH(id), headers, text))).status).toBe(status);
    }
    expect(calls).toEqual([]);
  });
});
