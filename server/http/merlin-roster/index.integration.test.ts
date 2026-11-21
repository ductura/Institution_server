// GET /api/v1/teacher/assignments/{assignmentId}/merlin/roster and .../merlin/csv
// (SRV-1109) on a real server with the real pipeline, over a fake roster read:
// the vectors of both contracts, the CSV bytes with the same rows and columns
// as the JSON, the 404 of a malformed id before the read and 503 for a row
// the contract does not accept. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  merlinRosterCsv,
  type MerlinRosterRead,
  type MerlinRosterRow,
} from "../../downloads/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createMerlinRosterRoutes, MERLIN_LABELS } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: { params: { assignmentId: string }; headers?: Record<string, string> };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: { rows: MerlinRosterRow[]; extensionReasons: [] } & Record<string, unknown>;
  };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const JSON_VECTORS = vectorsOf("teacher.merlin-roster.get");
const CSV_VECTORS = vectorsOf("teacher.merlin-roster-csv.get");
const ROSTER = JSON_VECTORS.find((v) => v.name === "roster")!.response.body!;
const ORIGIN = "https://ductura.example.invalid";
const A = "00000000-0000-4000-8000-0000000000a1";
const COOKIE = JSON_VECTORS[0]!.request.headers!;

let running: Running | undefined;
const calls: unknown[][] = [];
let read: () => Promise<MerlinRosterRead> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMerlinRosterRoutes(async (...args) => (calls.push(args), read())),
  });
  return `http://127.0.0.1:${running.port}/api/v1/teacher/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  read = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

/** The read a vector stands for. */
function readFor(v: Vector, body = v.response.body): () => Promise<MerlinRosterRead> {
  if (v.response.status === 503) return () => Promise.reject(new Error("izmisljena greska"));
  if (v.response.status === 401) return async () => ({ status: "unauthorized" });
  if (v.response.status !== 200) return async () => ({ status: "not_found" });
  return async () => ({
    status: "read",
    roster: { rows: body!.rows, files: [], studentIds: [] },
    extensionReasons: body!.extensionReasons,
  });
}

async function expectError(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  expect(await got.json()).toEqual({
    ...v.response.body,
    requestId: got.headers.get("x-request-id"),
  });
}

describe("teacher.merlin-roster.get", () => {
  it.each(JSON_VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    read = readFor(v);
    const base = await start();
    const got = await fetch(
      `${base}/${v.request.params.assignmentId}/merlin/roster`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    if (v.response.status !== 200) return expectError(got, v);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual(v.response.body);
  });

  it("asks with the id in lower case, and never for a malformed id", async () => {
    read = readFor(JSON_VECTORS[0]!);
    const base = await start();
    await fetch(`${base}/${A.toUpperCase()}/merlin/roster`, { headers: COOKIE });
    await fetch(`${base}/nije-uuid/merlin/roster`, { headers: COOKIE });
    expect(calls).toEqual([[expect.any(String), A]]);
  });

  it("a row outside the contract is 503, never a partial roster", async () => {
    read = async () => ({
      status: "read",
      roster: {
        rows: [{ ...ROSTER.rows[0]!, pdfSha256: "nije-otisak" }],
        files: [],
        studentIds: [],
      },
      extensionReasons: [],
    });
    const base = await start();
    const got = await fetch(`${base}/${A}/merlin/roster`, { headers: COOKIE });
    expect(got.status).toBe(503);
  });
});

describe("teacher.merlin-roster-csv.get", () => {
  it.each(CSV_VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    read = readFor(v, ROSTER);
    const base = await start();
    const got = await fetch(
      `${base}/${v.request.params.assignmentId}/merlin/csv`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    if (v.response.status !== 200) return expectError(got, v);
    expect(got.status).toBe(200);
    for (const [name, value] of Object.entries(v.response.headers ?? {})) {
      expect(got.headers.get(name)).toBe(value);
    }
    expect(got.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bytes = Buffer.from(await got.arrayBuffer());
    // The same rows and columns as the JSON answer, byte for byte, BOM included.
    expect(bytes.equals(Buffer.from(merlinRosterCsv(ROSTER.rows, MERLIN_LABELS), "utf8"))).toBe(
      true,
    );
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const lines = bytes.subarray(3).toString("utf8").trimEnd().split("\r\n");
    expect(lines).toHaveLength(ROSTER.rows.length + 1);
    expect(
      lines[1]!.startsWith("Anić,Demo,da,2026-12-20T21:14:00.000Z,ne,anic-demo-000000e1.pdf,"),
    ).toBe(true);
    expect(bytes.toString("utf8")).not.toContain("justified");
  });

  it("a row outside the contract is 503 here too", async () => {
    read = async () => ({
      status: "read",
      roster: {
        rows: [{ ...ROSTER.rows[0]!, docxName: "../izlaz.docx" }],
        files: [],
        studentIds: [],
      },
      extensionReasons: [],
    });
    const base = await start();
    const got = await fetch(`${base}/${A}/merlin/csv`, { headers: COOKIE });
    expect(got.status).toBe(503);
  });
});
