// The ranges of origin of a revision (work.origin-segments.get, SRV-KARTA-RASPON)
// on a real server with the real pipeline, over a fake withActor: the vectors of
// the contract, the revision handed to the RPC, a query that is not exactly
// ?revision=n refused before the database, and 503 for a row the contract does
// not allow. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createOriginCompositionRoutesFor } from "./index.ts";

type Segment = {
  blockId: string;
  start: number;
  end: number;
  kind: string;
  segmentRef: string | null;
};
type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  };
  response: {
    status: number;
    body: { revision?: number | null; segments?: Segment[] } & Record<string, unknown>;
  };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/work.origin-segments.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const COOKIE = { cookie: "__Host-ductus_session=izmisljeni-token-rada-000000000000000000001" };
const BLOCK = "1b0c2d3e-4f50-4a61-8b72-0c1d2e3f4a51";

let running: Running | undefined;
const seen: (readonly unknown[] | undefined)[] = [];
let answer: () => unknown = () => [];

/** Rows as app.work_origin_segments returns them; the revision a bigint string. */
const rowsOf = (revision: number, segments: readonly Segment[]) =>
  segments.map((s) => ({
    revision: String(revision),
    blockId: s.blockId,
    start: s.start,
    end: s.end,
    kind: s.kind,
    segmentRef: s.segmentRef,
  }));
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

function answerOf(v: Vector): () => unknown {
  const { status, body } = v.response;
  if (status === 200) return () => (body.revision ? rowsOf(body.revision, body.segments!) : []);
  if (status === 404) return () => sqlError("ZD403");
  if (status === 422) return () => sqlError("ZD422");
  return () => sqlError("XX000");
}

const urlOf = (base: string, v: Vector) =>
  `${base}/works/${v.request.params.documentId}/origin-segments` +
  (v.request.query ? `?${new URLSearchParams(v.request.query).toString()}` : "");

describe("work.origin-segments.get", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    answer = answerOf(v);
    const base = await start();
    const got = await fetch(urlOf(base, v), { headers: v.request.headers ?? {} });
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  });

  it("hands the revision asked to the RPC, and null without one", async () => {
    const base = await start();
    await fetch(`${base}/works/izmisljeni-rad-0001/origin-segments?revision=12`, {
      headers: COOKIE,
    });
    await fetch(`${base}/works/izmisljeni-rad-0001/origin-segments`, { headers: COOKIE });
    expect(seen).toEqual([
      ["izmisljeni-rad-0001", "12"],
      ["izmisljeni-rad-0001", null],
    ]);
  });

  it.each([
    ["a negative revision", "revision=-1"],
    ["a fraction", "revision=1.5"],
    ["a leading zero", "revision=07"],
    ["a revision above 2^53-1", "revision=9999999999999999"],
    ["a second key", "revision=1&kind=typed"],
    ["another key", "from=1"],
    ["the revision twice", "revision=1&revision=2"],
  ])("%s is 422 and the database is not asked", async (_name, query) => {
    const base = await start();
    const got = await fetch(`${base}/works/izmisljeni-rad-0001/origin-segments?${query}`, {
      headers: COOKIE,
    });
    expect(got.status).toBe(422);
    expect(seen).toEqual([]);
  });

  it.each([
    ["a kind outside the list", { kind: "dictated" }],
    ["an empty range", { start: 5, end: 5 }],
    ["a block that is not a node id", { blockId: "odlomak-1" }],
    ["a revision that is not a number", { revision: "Izmisljeni" }],
  ])("a row with %s is 503, never sent", async (_name, change) => {
    answer = () => [
      {
        ...rowsOf(4, [{ blockId: BLOCK, start: 0, end: 9, kind: "typed", segmentRef: null }])[0],
        ...change,
      },
    ];
    const base = await start();
    const got = await fetch(`${base}/works/izmisljeni-rad-0001/origin-segments`, {
      headers: COOKIE,
    });
    expect(got.status).toBe(503);
    expect(await got.text()).not.toMatch(/dictated|Izmisljeni|odlomak/);
  });
});
