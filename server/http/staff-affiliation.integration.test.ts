// GET /api/v1/me/staff-affiliation (SRV-1403) on a real server with the real
// pipeline, over a fake reader: every contract vector, 503 for an answer the
// contract does not accept, and the closed sets of the three layers held
// together. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { STAFF_AFFILIATION_SOURCES as CONTRACT_SOURCES } from "../contracts/index.ts";
import {
  STAFF_AFFILIATION_MISSING_CODE,
  STAFF_AFFILIATION_SOURCE_NAMES,
  type MyStaffAffiliationResult,
} from "../database/index.ts";
import {
  STAFF_AFFILIATION_MISSING,
  STAFF_AFFILIATION_SOURCES,
} from "../external/srce-auth/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createStaffAffiliationRoute } from "./staff-affiliation.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/profile.staff-affiliation.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const COOKIE = VECTORS[0]!.request.headers!.cookie!;

let running: Running | undefined;
const calls: string[] = [];
let answer: () => Promise<MyStaffAffiliationResult> = async () => ({
  ok: false,
  reason: "unauthenticated",
});

async function start(): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStaffAffiliationRoute((token) => (calls.push(token), answer()))],
  });
  return `http://127.0.0.1:${running.port}/api/v1/me/staff-affiliation`;
}

afterEach(async () => {
  calls.length = 0;
  answer = async () => ({ ok: false, reason: "unauthenticated" });
  await running?.close();
  running = undefined;
});

describe("profile.staff-affiliation.get", () => {
  it("one closed set of sources and one code in the claims, the database and the contract", () => {
    expect([...STAFF_AFFILIATION_SOURCE_NAMES]).toStrictEqual([...STAFF_AFFILIATION_SOURCES]);
    expect([...CONTRACT_SOURCES]).toStrictEqual([...STAFF_AFFILIATION_SOURCES]);
    expect(STAFF_AFFILIATION_MISSING_CODE).toBe(STAFF_AFFILIATION_MISSING);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    answer = async () => {
      if (v.response.status === 503) throw new Error("izmisljena greska baze");
      if (v.response.status === 200) return { ok: true, value: v.response.body as never };
      return { ok: false, reason: "unauthenticated" };
    };
    const base = await start();
    const got = await fetch(
      base,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status === 200) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    const reached = [200, 503].includes(v.response.status);
    expect(calls).toEqual(reached ? [v.request.headers!.cookie!.split("=")[1]] : []);
  });

  it("acceptance 2: without an affiliation the answer is the closed code", async () => {
    answer = async () => ({
      ok: true,
      value: { confirmed: false, code: STAFF_AFFILIATION_MISSING_CODE },
    });
    const got = await fetch(await start(), { headers: { cookie: COOKIE } });
    expect(await got.json()).toEqual({ confirmed: false, code: "staff_affiliation_missing" });
  });

  it("a session the database does not know is 401", async () => {
    const got = await fetch(await start(), { headers: { cookie: COOKIE } });
    expect(got.status).toBe(401);
  });

  it("an answer outside the contract is 503", async () => {
    answer = async () => ({
      ok: true,
      value: {
        confirmed: true,
        source: "student",
        confirmedAt: "2026-11-20T08:30:00.000Z",
      } as never,
    });
    const got = await fetch(await start(), { headers: { cookie: COOKIE } });
    expect(got.status).toBe(503);
  });
});
