// GET /api/v1/student/assignments/{assignmentId}/submission-reconstruction
// (F4-PM2-R01) through the real pipeline, over a fake port: the vectors of the
// contract, the port asked only with the token and a lowercase id, a malformed
// id and a cross-site read refused before the port, another's or a missing
// submission read as 404, and 503 for an answer outside the contract or a
// failing port. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { SubmissionReconstructionPort } from "../database/index.ts";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import { createSubmissionReconstructionRoutes } from "./submission-reconstruction.ts";

type Vector = {
  name: string;
  request: { params: Record<string, string>; headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const ID_OF_ROUTE = "student.assignment-submission-reconstruction.get";
const vectors = (
  JSON.parse(
    readFileSync(new URL(`../contracts/vectors/${ID_OF_ROUTE}.json`, import.meta.url), "utf8"),
  ) as { vectors: Vector[] }
).vectors.filter((v) => !["origin-missing", "origin-mismatch", "cross-site"].includes(v.name));

const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = { cookie: "__Host-ductus_session=izmisljeni-token-predaje-000000000000000000" };
const path = (id: string) => `/student/assignments/${id}/submission-reconstruction`;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = {
    read: (...args: unknown[]) => (calls.push(args), reply()),
  } as unknown as SubmissionReconstructionPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createSubmissionReconstructionRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}
const get = (base: string, id: string, headers: Record<string, string> = STUDENT) =>
  fetch(base + path(id), { headers });

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

describe.each(vectors.map((v) => [v.name, v] as const))("vector %s", (_name, v) => {
  it("is answered as the contract says", async () => {
    const { status, body } = v.response;
    reply = async () =>
      status === 200
        ? { status: "read", ...body }
        : status === 401
          ? { status: "unauthorized" }
          : status === 404
            ? { status: "not_found" }
            : Promise.reject(new Error("izmišljen kvar baze"));
    const base = await start();
    const got = await get(base, v.request.params.assignmentId!, v.request.headers ?? {});
    expect(got.status).toBe(status);
    const answer = (await got.json()) as Record<string, unknown>;
    if (status < 300) expect(answer).toEqual(body);
    else expect(answer).toEqual({ ...body, requestId: got.headers.get("x-request-id") });
  });
});

describe("the student reads the state of the own submission", () => {
  it("asks the port with the token and the id in lowercase", async () => {
    reply = async () => ({ status: "read", state: "verified" });
    const base = await start();
    const got = await get(base, ID.toUpperCase());
    expect(await got.json()).toEqual({ state: "verified" });
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([["izmisljeni-token-predaje-000000000000000000", ID]]);
  });

  it("another student's, an unknown and a missing submission read the same 404", async () => {
    const base = await start();
    const got = await get(base, ID);
    expect(got.status).toBe(404);
    expect(((await got.json()) as { code: string }).code).toBe("not_found");
  });

  it("a malformed id is 404 and a cross-site read 403, both without the port", async () => {
    const base = await start();
    expect((await get(base, "nije-uuid")).status).toBe(404);
    expect((await get(base, ID, { ...STUDENT, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("without a session cookie it is 401 and the port is not asked", async () => {
    const base = await start();
    expect((await get(base, ID, {})).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("a state outside the contract or a failing port is 503, never sent", async () => {
    reply = async () => ({ status: "read", state: "gotovo" });
    const base = await start();
    expect((await get(base, ID)).status).toBe(503);
    reply = async () => {
      throw new Error("izmišljen kvar baze");
    };
    expect((await get(base, ID)).status).toBe(503);
  });
});
