// The owner's write of the ranges of origin of a revision
// (work.origin-segments.post, SRV-KARTA-RASPON-RUTA) on a real server with the
// real pipeline, over a fake withActor: the success vector, the values handed to
// app.work_origin_segments_record, a body refused before the database, and the
// answers to the refusals of the database (another's work and the teacher 404, a
// second write of the revision 409). All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createOriginCompositionRoutesFor } from "./index.ts";

type Vector = {
  name: string;
  request: { params: Record<string, string>; headers: Record<string, string>; body?: unknown };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/work.origin-segments.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const RECORDED = VECTORS.find((v) => v.name === "recorded")!;
const HEADERS = RECORDED.request.headers;
const BLOCK = "1b0c2d3e-4f50-4a61-8b72-0c1d2e3f4a51";
const BODY = { revision: 4, segments: [{ blockId: BLOCK, start: 0, end: 9, kind: "typed" }] };

let running: Running | undefined;
const seen: (readonly unknown[] | undefined)[] = [];
let answer: () => unknown = () => [];

const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

async function start(): Promise<string> {
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(_text, values) {
        seen.push(values);
        const rows = answer();
        if (rows instanceof Error) throw rows;
        return { rows: rows as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: createOriginCompositionRoutesFor({ withActor }),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  seen.length = 0;
  answer = () => [];
  await running?.close();
  running = undefined;
});

const post = (base: string, body: unknown, documentId = "izmisljeni-rad-0001") =>
  fetch(`${base}/works/${documentId}/origin-segments`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

describe("work.origin-segments.post", () => {
  it("records the ranges of the vector and answers 201 with their number", async () => {
    const segments = (RECORDED.request.body as { segments: unknown[] }).segments;
    answer = () => [{ recorded: segments.length }];
    const base = await start();
    const got = await post(base, RECORDED.request.body, RECORDED.request.params.documentId);
    expect(got.status).toBe(201);
    expect(await got.json()).toEqual(RECORDED.response.body);
    expect(seen).toEqual([[RECORDED.request.params.documentId, "7", JSON.stringify(segments)]]);
  });

  it.each([
    ["an empty range", { ...BODY, segments: [{ ...BODY.segments[0], start: 9, end: 9 }] }],
    [
      "a range that ends before it starts",
      { ...BODY, segments: [{ ...BODY.segments[0], start: 9, end: 3 }] },
    ],
    ["no range", { ...BODY, segments: [] }],
    ["a kind outside the list", { ...BODY, segments: [{ ...BODY.segments[0], kind: "dictated" }] }],
    [
      "a block that is not a node id",
      { ...BODY, segments: [{ ...BODY.segments[0], blockId: "odlomak-1" }] },
    ],
    ["a key outside the range", { ...BODY, segments: [{ ...BODY.segments[0], author: "x" }] }],
    ["a key outside the body", { ...BODY, documentId: "izmisljeni-rad-0002" }],
    ["a negative revision", { ...BODY, revision: -1 }],
    ["a fractional start", { ...BODY, segments: [{ ...BODY.segments[0], start: 0.5 }] }],
    [
      "a changeId that is not a uuid",
      { ...BODY, segments: [{ ...BODY.segments[0], changeId: "x" }] },
    ],
  ])("%s is 422 and the database is not asked", async (_name, body) => {
    const base = await start();
    const got = await post(base, body);
    expect(got.status).toBe(422);
    expect(seen).toEqual([]);
  });

  it.each([
    ["another's work, the teacher and an unknown work (ZD403)", "ZD403", 404, "not_found"],
    ["a second write of the revision (ZD409)", "ZD409", 409, "conflict"],
    ["a second write that raced the first (the key)", "23505", 409, "conflict"],
    ["a revision the student did not save (ZD422)", "ZD422", 422, "invalid_input"],
    ["no session in the database (ZD401)", "ZD401", 401, "unauthorized"],
    ["anything else", "XX000", 503, "unavailable"],
  ])("%s answers %s", async (_name, code, status, error) => {
    answer = () => sqlError(code);
    const base = await start();
    const got = await post(base, BODY);
    expect(got.status).toBe(status);
    expect(((await got.json()) as { error: string }).error).toBe(error);
  });

  it("a malformed work is 404 without asking the database", async () => {
    const base = await start();
    const got = await post(base, BODY, "%00");
    expect(got.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("a count that is not the number of ranges sent is 503, never 201", async () => {
    answer = () => [{ recorded: 2 }];
    const base = await start();
    const got = await post(base, BODY);
    expect(got.status).toBe(503);
  });
});
