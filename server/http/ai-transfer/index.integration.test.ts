// SRV-1809: POST /api/v1/works/{documentId}/ai-transfers on a real server
// with the real pipeline, over a stubbed database answer: the success and
// refusal vectors of the contract, a body refused before the database, the
// text passed on byte for byte, and 503 for a record that does not read back
// (another id, another hash, not ductus-ai-transfer-v1). The framing vectors
// (origin, size, stream) belong to the shared layers and their own tests. All
// values are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AiTransferRecordV1, canonicalAiTransferRecordV1 } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createAiTransferRoutesFor } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: {
    params: { documentId: string };
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/work.ai-transfer.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "izmisljeni-token-rada-000000000000000000001";
const FRAMING = new Set([
  "origin-missing",
  "origin-mismatch",
  "cross-site",
  "body-too-large",
  "body-timeout",
  "content-length-invalid",
  "content-length-mismatch",
  "body-stream-error",
]);
const RECORDED = VECTORS.find((v) => v.name === "recorded")!;
const RECORD = RECORDED.response.body.record as AiTransferRecordV1;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const rowOf = (record: AiTransferRecordV1) => {
  const recordText = canonicalAiTransferRecordV1(record);
  return { transferId: record.transferId, recordSha256: sha256(recordText), recordText };
};
const dbError = (code: string) => Object.assign(new Error(code), { code });

// The database answer of the next request, and every call that reached it.
let answer: () => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });
const calls: unknown[][] = [];
const withActor: WithActor = (token, run) =>
  run({
    query: (sql: string, params: unknown[]) => (calls.push([token, sql, params]), answer()),
  } as unknown as ActorTransaction);
const rows = (list: unknown[]) => async () => ({ rows: list });
const fails = (code: string) => async (): Promise<never> => {
  throw dbError(code);
};
let server: Running;
let base: string;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createAiTransferRoutesFor({ withActor }),
  });
  base = `http://127.0.0.1:${server.port}/api/v1`;
});
afterAll(async () => server.close());
beforeEach(() => {
  calls.length = 0;
  answer = rows([]);
});

const send = (v: Vector["request"]) =>
  fetch(`${base}/works/${v.params.documentId}/ai-transfers`, {
    method: "POST",
    headers: v.headers ?? {},
    ...(v.rawBody !== undefined || v.body !== undefined
      ? { body: v.rawBody ?? JSON.stringify(v.body) }
      : {}),
  });

function databaseAnswer(v: Vector): void {
  const { status } = v.response;
  if (status === 201) answer = rows([rowOf(RECORD)]);
  else if (status === 401) answer = fails("ZD401");
  else if (status === 404) answer = fails("ZD403");
  else if (status === 422) answer = fails("ZD422");
  else answer = fails("57014");
}

describe("vectors", () => {
  const vectors = VECTORS.filter((v) => !FRAMING.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    databaseAnswer(v);
    const got = await send(v.request);
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    if (
      ["unauthorized", "unsupported-media-type", "invalid-json", "invalid-input"].includes(v.name)
    ) {
      expect(calls).toEqual([]);
    }
  });
});

describe("the text and the record", () => {
  const request = RECORDED.request;

  it("passes the text on byte for byte, never normalized, and never answers it", async () => {
    const decomposed = "Lorem café o gradskom vijeću.";
    answer = rows([rowOf(RECORD)]);
    const got = await send({
      ...request,
      body: { responseId: RECORD.responseId, text: decomposed },
    });
    expect(got.status).toBe(201);
    expect(calls).toHaveLength(1);
    const [token, sql, args] = calls[0]!;
    expect(token).toBe(TOKEN);
    expect(sql).toContain("assistant.create_ai_transfer($1, $2::uuid, $3)");
    expect(args).toEqual([request.params.documentId, RECORD.responseId, decomposed]);
    expect(await got.text()).not.toContain("Lorem");
  });

  it.each([
    ["a text over 40000 characters", { responseId: RECORD.responseId, text: "a".repeat(40_001) }],
    ["a response id that is not a uuid", { responseId: "nije-uuid", text: "Lorem" }],
    [
      "a key outside the contract",
      { responseId: RECORD.responseId, text: "Lorem", phaseId: "drafting" },
    ],
  ])("a body with %s is 422 and the database is not asked", async (_name, body) => {
    const got = await send({ ...request, body });
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a lone high surrogate", '{"responseId":"RID","text":"Lorem \\ud800 vijeće"}'],
    ["a lone low surrogate", '{"responseId":"RID","text":"\\udc00"}'],
    ["a reversed pair", '{"responseId":"RID","text":"a\\udc00\\ud800b"}'],
  ])("a text with %s is 422 and the database is not asked", async (_name, raw) => {
    const got = await send({
      ...request,
      body: undefined,
      rawBody: raw.replace("RID", RECORD.responseId),
    });
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed work is 404 and never reaches the database", async () => {
    const got = await send({ ...request, params: { documentId: "nije%00rad" } });
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each([
    [
      "another id",
      () => ({ ...rowOf(RECORD), transferId: "00000000-0000-4000-8000-0000000000a2" }),
    ],
    ["another hash", () => ({ ...rowOf(RECORD), recordSha256: "0".repeat(64) })],
    [
      "a record outside ductus-ai-transfer-v1",
      () => {
        const recordText = JSON.stringify({ ...RECORD, extra: 1 });
        return { transferId: RECORD.transferId, recordSha256: sha256(recordText), recordText };
      },
    ],
    ["no row", () => undefined],
  ])("a record with %s is 503, never a 201", async (_name, row) => {
    const found = row();
    answer = rows(found === undefined ? [] : [found]);
    const got = await send(request);
    expect(got.status).toBe(503);
  });
});
