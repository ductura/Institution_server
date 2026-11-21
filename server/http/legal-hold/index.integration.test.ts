// GET and POST /api/v1/institution/legal-holds and POST
// /api/v1/institution/legal-holds/{holdId}/release (SRV-1306) on a real server
// with the real pipeline (origin layer, JSON reader), over a fake port: the
// vectors of the contract, the 404 of a malformed hold id before the port, the
// lower-cased id and 503 for an answer outside the contract. The framing
// vectors (origin, size, stream) belong to the shared layers and are covered
// by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { LegalHolds } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createLegalHoldRoutes } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: {
    params?: { holdId: string };
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const LIST = vectorsOf("institution.legal-holds.get");
const PLACE = vectorsOf("institution.legal-holds.post");
const RELEASE = vectorsOf("institution.legal-hold-release.post");
const ORIGIN = "https://ductura.example.invalid";
const BASE = "/api/v1/institution/legal-holds";
const HOLD = RELEASE[0]!.request.params!.holdId;
/** Not sendable by fetch (own framing): the shared layers cover them. */
const lowLevel = (v: Vector) => v.request.headers?.["content-length"] !== undefined;
/** Refused by the origin layer or the reader before the port. */
const framed = (v: Vector) =>
  ["unsupported-media-type", "origin-missing", "origin-mismatch", "cross-site"].includes(v.name);

let running: Running | undefined;
const calls: unknown[][] = [];
type Answer = () => Promise<unknown>;
let list: Answer;
let place: Answer;
let release: Answer;
const reset = () => {
  list = async () => ({ status: "ok", holds: [] });
  place = async () => ({ status: "not_found" });
  release = async () => ({ status: "not_found" });
};
reset();

async function start(): Promise<string> {
  const holds = {
    list: (...args: unknown[]) => (calls.push(["list", ...args]), list()),
    place: (...args: unknown[]) => (calls.push(["place", ...args]), place()),
    release: (...args: unknown[]) => (calls.push(["release", ...args]), release()),
  } as unknown as LegalHolds;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createLegalHoldRoutes({
      holds,
      recordActivity: async () => undefined,
      timeoutMs: 300,
    }),
  });
  return `http://127.0.0.1:${running.port}${BASE}`;
}

afterEach(async () => {
  calls.length = 0;
  reset();
  await running?.close();
  running = undefined;
});

async function expectAnswer(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  const body = (await got.json()) as Record<string, unknown>;
  if (v.response.status < 300) expect(body).toEqual(v.response.body);
  else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
}

/** What the database says for the error a vector expects. */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ["unauthorized", "unauthenticated"],
  ["forbidden", "forbidden"],
  ["not_found", "not_found"],
  ["conflict", "conflict"],
  ["invalid_input", "invalid"],
]);
const refusalFor = (v: Vector): string => REFUSALS.get(v.code ?? "") ?? "unavailable";

describe("institution.legal-holds.get", () => {
  it.each(LIST.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    list = async () =>
      v.response.status === 200
        ? { status: "ok", holds: v.response.body.holds }
        : v.code === "unavailable"
          ? Promise.reject(new Error("izmisljena greska"))
          : { status: refusalFor(v) };
    const base = await start();
    // The route answers 401 before the port when there is no cookie.
    const got = await fetch(base, { headers: v.request.headers ?? {} });
    await expectAnswer(got, v);
  });

  it("an answer outside the contract is 503", async () => {
    list = async () => ({ status: "ok", holds: [{ holdId: "nije-uuid" }] });
    const base = await start();
    const got = await fetch(base, { headers: LIST[0]!.request.headers! });
    expect(got.status).toBe(503);
  });

  it("a cross-site request is 403 before the port", async () => {
    const base = await start();
    const got = await fetch(base, {
      headers: { ...LIST[0]!.request.headers!, "sec-fetch-site": "cross-site" },
    });
    expect(got.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("institution.legal-holds.post", () => {
  it.each(PLACE.filter((v) => !framed(v) && !lowLevel(v)).map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      place = async () =>
        v.response.status === 201
          ? { status: "ok", ...v.response.body }
          : v.code === "unavailable"
            ? Promise.reject(new Error("izmisljena greska"))
            : { status: refusalFor(v) };
      const base = await start();
      const got = await fetch(base, {
        method: "POST",
        headers: v.request.headers ?? {},
        body: v.request.rawBody ?? JSON.stringify(v.request.body),
      });
      await expectAnswer(got, v);
    },
  );

  it.each(PLACE.filter(framed).map((v) => [v.name, v] as const))(
    "framing vector %s never reaches the port",
    async (_name, v) => {
      const base = await start();
      const got = await fetch(base, {
        method: "POST",
        headers: v.request.headers ?? {},
        body: v.request.rawBody ?? JSON.stringify(v.request.body),
      });
      expect(got.status).toBeGreaterThanOrEqual(400);
      expect(got.status).toBeLessThan(500);
      expect(calls).toEqual([]);
    },
  );

  it("passes the three fields to the port", async () => {
    place = async () => ({ status: "ok", holdId: HOLD });
    const base = await start();
    const v = PLACE.find((x) => x.name === "placed")!;
    const got = await fetch(base, {
      method: "POST",
      headers: v.request.headers!,
      body: JSON.stringify(v.request.body),
    });
    expect(got.status).toBe(201);
    expect(calls).toEqual([["place", expect.any(String), v.request.body]]);
  });

  it("an answer outside the contract is 503", async () => {
    place = async () => ({ status: "ok", holdId: "nije-uuid" });
    const base = await start();
    const v = PLACE.find((x) => x.name === "placed")!;
    const got = await fetch(base, {
      method: "POST",
      headers: v.request.headers!,
      body: JSON.stringify(v.request.body),
    });
    expect(got.status).toBe(503);
  });
});

describe("institution.legal-hold-release.post", () => {
  it.each(RELEASE.filter((v) => !framed(v) && !lowLevel(v)).map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      release = async () =>
        v.response.status === 200
          ? { status: "ok", ...v.response.body }
          : v.code === "unavailable"
            ? Promise.reject(new Error("izmisljena greska"))
            : { status: refusalFor(v) };
      const base = await start();
      const got = await fetch(`${base}/${v.request.params!.holdId}/release`, {
        method: "POST",
        headers: v.request.headers ?? {},
        body: v.request.rawBody ?? JSON.stringify(v.request.body),
      });
      await expectAnswer(got, v);
    },
  );

  it.each(RELEASE.filter(framed).map((v) => [v.name, v] as const))(
    "framing vector %s never reaches the port",
    async (_name, v) => {
      const base = await start();
      const got = await fetch(`${base}/${v.request.params!.holdId}/release`, {
        method: "POST",
        headers: v.request.headers ?? {},
        body: v.request.rawBody ?? JSON.stringify(v.request.body),
      });
      expect(got.status).toBeGreaterThanOrEqual(400);
      expect(got.status).toBeLessThan(500);
      expect(calls).toEqual([]);
    },
  );

  it("sends the hold id in lower case and a malformed one is 404 before the port", async () => {
    release = async () => ({ status: "ok", holdId: HOLD, releasedAt: "2026-11-21T10:30:00.000Z" });
    const base = await start();
    const v = RELEASE.find((x) => x.name === "released")!;
    const send = (id: string) =>
      fetch(`${base}/${id}/release`, {
        method: "POST",
        headers: v.request.headers!,
        body: JSON.stringify(v.request.body),
      });
    expect((await send(HOLD.toUpperCase())).status).toBe(200);
    expect(calls).toEqual([["release", expect.any(String), HOLD, v.request.body!.reason]]);
    calls.length = 0;
    expect((await send("nije-uuid")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
