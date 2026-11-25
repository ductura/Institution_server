// The student data export routes (SRV-1308) on a real server with the real
// pipeline (origin layer, JSON reader), over a fake port and storage: the
// vectors of all four contracts (acceptance 4), the stored reference of the
// identity check, the 404 of a malformed export id before the port, the
// download once and then 410 (acceptance 2), a package that cannot be read
// leaving the link unused (503), and the package removed once sent. The
// framing vectors (origin, size, stream) belong to the shared layers and are
// covered by their own tests. All values are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { StudentDataExports } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createStudentDataExportRoutes } from "./index.ts";
import { linkTokenHash, type StudentDataExportStorage } from "./storage.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: {
    params?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    rawBody?: string;
  };
  response: { status: number; body?: Record<string, unknown>; headers?: Record<string, string> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as {
      vectors: Vector[];
    }
  ).vectors;
const LIST = vectorsOf("institution.student-data-exports.get");
const STUDENTS = vectorsOf("institution.student-data-export-students.get");
const REQUEST = vectorsOf("institution.student-data-exports.post");
const APPROVE = vectorsOf("institution.student-data-exports-approve.post");
const DOWNLOAD = vectorsOf("student.data-export.get");
const ORIGIN = "https://ductura.example.invalid";
const BASE = "/api/v1/institution/student-data-exports";
const STUDENTS_PATH = "/api/v1/institution/student-data-export-students";
const EXPORT = APPROVE[0]!.request.params!.exportId!;
const TOKEN = DOWNLOAD[0]!.request.params!.token!;
const ZIP = new TextEncoder().encode("PK izmisljeni paket");
/** Not sendable by fetch (own framing): the shared layers cover them. */
const lowLevel = (v: Vector) => v.request.headers?.["content-length"] !== undefined;
/** Refused by the origin layer or the reader before the port. */
const framed = (v: Vector) =>
  ["unsupported-media-type", "origin-missing", "origin-mismatch", "cross-site"].includes(v.name);

let running: Running | undefined;
const calls: unknown[][] = [];
type Answer = (...args: unknown[]) => Promise<unknown>;
let list: Answer;
let request: Answer;
let approve: Answer;
let consume: Answer;
let stored: Map<string, Uint8Array>;
const reset = () => {
  list = async () => ({ status: "ok", exports: [] });
  request = async () => ({ status: "not_found" });
  approve = async () => ({ status: "not_found" });
  consume = async () => ({ status: "gone" });
  stored = new Map();
};
reset();

/** The port's consume as the database does it: once for the known hash, then gone. */
function consumeOnce(hash: string, exportId: string): Answer {
  let used = false;
  return async (tokenHash, load) => {
    if (used || Buffer.from(tokenHash as Uint8Array).toString("hex") !== hash)
      return { status: "gone" };
    try {
      const value = await (load as (id: string) => Promise<unknown>)(exportId);
      used = true;
      return { status: "ok", exportId, value };
    } catch {
      return { status: "unavailable" };
    }
  };
}

async function start(): Promise<string> {
  const exports = {
    list: (...args: unknown[]) => (calls.push(["list", ...args]), list(...args)),
    request: (...args: unknown[]) => (calls.push(["request", ...args]), request(...args)),
    approve: (...args: unknown[]) => (calls.push(["approve", ...args]), approve(...args)),
    consume: (...args: unknown[]) => (calls.push(["consume"]), consume(...args)),
  } as unknown as StudentDataExports;
  const storage: StudentDataExportStorage = {
    put: async (id, bytes) => void stored.set(id, bytes),
    read: async (id) => stored.get(id) ?? Promise.reject(new Error("missing")),
    remove: async (id) => void stored.delete(id),
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createStudentDataExportRoutes({
      exports,
      storage,
      recordActivity: async () => undefined,
      timeoutMs: 300,
    }),
  });
  return `http://127.0.0.1:${running.port}`;
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
const answerFor =
  (v: Vector, ok: () => unknown): Answer =>
  async () =>
    v.kind === "success"
      ? ok()
      : v.code === "unavailable"
        ? Promise.reject(new Error("izmisljena greska"))
        : { status: REFUSALS.get(v.code ?? "") ?? "unavailable" };

const post = (url: string, v: Vector) =>
  fetch(url, {
    method: "POST",
    headers: v.request.headers ?? {},
    body: v.request.rawBody ?? JSON.stringify(v.request.body),
  });

describe("institution.student-data-exports.get", () => {
  it.each(LIST.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    list = answerFor(v, () => ({ status: "ok", exports: v.response.body!.exports }));
    const base = await start();
    await expectAnswer(await fetch(`${base}${BASE}`, { headers: v.request.headers ?? {} }), v);
  });

  it("an answer outside the contract is 503, a cross-site read 403 before the port", async () => {
    list = async () => ({ status: "ok", exports: [{ exportId: "nije-uuid" }] });
    const base = await start();
    const headers = LIST[0]!.request.headers!;
    expect((await fetch(`${base}${BASE}`, { headers })).status).toBe(503);
    calls.length = 0;
    const cross = await fetch(`${base}${BASE}`, {
      headers: { ...headers, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

// SRV-NF7-IZVOZ-STUDENT: the person and state beside the list, from the same port read.
describe("institution.student-data-export-students.get", () => {
  it.each(STUDENTS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    list = answerFor(v, () => ({ status: "ok", exports: v.response.body!.exports }));
    const base = await start();
    await expectAnswer(
      await fetch(`${base}${STUDENTS_PATH}`, { headers: v.request.headers ?? {} }),
      v,
    );
  });

  it("sends only the person and the state, and the list never the person", async () => {
    const row = {
      exportId: "00000000-0000-4000-8000-0000000001f1",
      studentId: "00000000-0000-4000-8000-000000000201",
      state: "approved",
      requestedAt: "2026-11-21T09:15:00.000Z",
      expiresAt: null,
    };
    list = async () => ({ status: "ok", exports: [row] });
    const base = await start();
    const headers = STUDENTS[0]!.request.headers!;
    const students = await fetch(`${base}${STUDENTS_PATH}`, { headers });
    expect(students.headers.get("cache-control")).toBe("no-store");
    expect(await students.json()).toEqual({
      exports: [{ exportId: row.exportId, studentId: row.studentId, state: "approved" }],
    });
    const listed = await fetch(`${base}${BASE}`, { headers });
    expect(await listed.json()).toEqual({
      exports: [
        {
          exportId: row.exportId,
          state: "approved",
          requestedAt: row.requestedAt,
          expiresAt: null,
        },
      ],
    });
  });

  it("a person outside the contract is 503, a cross-site read 403 before the port", async () => {
    list = async () => ({
      status: "ok",
      exports: [
        {
          exportId: "00000000-0000-4000-8000-0000000001f1",
          studentId: "nije-uuid",
          state: "ready",
        },
      ],
    });
    const base = await start();
    const headers = STUDENTS[0]!.request.headers!;
    expect((await fetch(`${base}${STUDENTS_PATH}`, { headers })).status).toBe(503);
    calls.length = 0;
    const cross = await fetch(`${base}${STUDENTS_PATH}`, {
      headers: { ...headers, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("institution.student-data-exports.post", () => {
  it.each(REQUEST.filter((v) => !framed(v) && !lowLevel(v)).map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      request = answerFor(v, () => ({ status: "ok", ...v.response.body }));
      const base = await start();
      await expectAnswer(await post(`${base}${BASE}`, v), v);
    },
  );

  it.each(REQUEST.filter(framed).map((v) => [v.name, v] as const))(
    "framing vector %s never reaches the port",
    async (_name, v) => {
      const base = await start();
      const got = await post(`${base}${BASE}`, v);
      expect(got.status).toBeGreaterThanOrEqual(400);
      expect(got.status).toBeLessThan(500);
      expect(calls).toEqual([]);
    },
  );

  it("stores how the identity was checked with the reference, never more", async () => {
    request = async () => ({ status: "ok", exportId: EXPORT });
    const base = await start();
    const v = REQUEST.find((x) => x.name === "requested")!;
    expect((await post(`${base}${BASE}`, v)).status).toBe(201);
    expect(calls).toEqual([
      [
        "request",
        expect.any(String),
        {
          studentId: v.request.body!.studentId,
          identityCheckRef: "identity_card: IZMISLJENA-PROVJERA-2026-01",
        },
      ],
    ]);
  });
});

describe("institution.student-data-exports-approve.post", () => {
  it.each(APPROVE.filter((v) => !framed(v) && !lowLevel(v)).map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      approve = answerFor(v, () => ({ status: "ok", ...v.response.body }));
      const base = await start();
      await expectAnswer(await post(`${base}${BASE}/${v.request.params!.exportId}/approve`, v), v);
    },
  );

  it.each(APPROVE.filter(framed).map((v) => [v.name, v] as const))(
    "framing vector %s never reaches the port",
    async (_name, v) => {
      const base = await start();
      const got = await post(`${base}${BASE}/${v.request.params!.exportId}/approve`, v);
      expect(got.status).toBeGreaterThanOrEqual(400);
      expect(got.status).toBeLessThan(500);
      expect(calls).toEqual([]);
    },
  );

  it("sends the export id in lower case and a malformed one is 404 before the port", async () => {
    approve = async () => ({ status: "ok", exportId: EXPORT, state: "approved" });
    const base = await start();
    const v = APPROVE.find((x) => x.name === "approved")!;
    expect((await post(`${base}${BASE}/${EXPORT.toUpperCase()}/approve`, v)).status).toBe(200);
    expect(calls).toEqual([["approve", expect.any(String), EXPORT, "IZMISLJENI-POSAO-2026-01"]]);
    calls.length = 0;
    expect((await post(`${base}${BASE}/nije-uuid/approve`, v)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("student.data-export.get", () => {
  const hash = Buffer.from(linkTokenHash(TOKEN)).toString("hex");

  it("hands out the package once, then 410, and removes the package (acceptance 2)", async () => {
    stored.set(EXPORT, ZIP);
    consume = consumeOnce(hash, EXPORT);
    const base = await start();
    const first = await fetch(`${base}/api/v1/student/data-export/${TOKEN}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/zip");
    expect(first.headers.get("content-disposition")).toBe(
      DOWNLOAD[0]!.response.headers!["content-disposition"],
    );
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(ZIP))).toBe(true);
    expect(first.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(ZIP).digest("hex"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stored.has(EXPORT)).toBe(false);
    const second = await fetch(`${base}/api/v1/student/data-export/${TOKEN}`);
    await expectAnswer(
      second,
      DOWNLOAD.find((v) => v.name === "used")!,
    );
  });

  it("a package that cannot be read is 503 and leaves the link unused", async () => {
    consume = consumeOnce(hash, EXPORT);
    const base = await start();
    const missing = await fetch(`${base}/api/v1/student/data-export/${TOKEN}`);
    await expectAnswer(
      missing,
      DOWNLOAD.find((v) => v.name === "unavailable")!,
    );
    stored.set(EXPORT, ZIP);
    expect((await fetch(`${base}/api/v1/student/data-export/${TOKEN}`)).status).toBe(200);
  });

  it("an unknown or malformed link is the same 410, a malformed one before the port", async () => {
    consume = consumeOnce(hash, EXPORT);
    const base = await start();
    const other = "A".repeat(43);
    expect((await fetch(`${base}/api/v1/student/data-export/${other}`)).status).toBe(410);
    expect(calls).toEqual([["consume"]]);
    calls.length = 0;
    expect((await fetch(`${base}/api/v1/student/data-export/kratko`)).status).toBe(410);
    expect(calls).toEqual([]);
  });
});

// SRV-ADMIN-3 (NF-7 OA-6): a second open request for the same person is the
// request's 409 with its reason and the key of its text; the approval's 409
// (a request no longer waiting) stays the plain conflict.
describe("the reason of a 409", () => {
  it("the request names the open request for the person and the catalogue key", async () => {
    request = async () => ({ status: "conflict" });
    const base = await start();
    const v = REQUEST.find((x) => x.name === "requested")!;
    const got = await post(`${base}${BASE}`, v);
    expect(got.status).toBe(409);
    const body = (await got.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "conflict",
      code: "conflict",
      messageKey: "errors.conflict",
      reason: "export_already_open",
      reasonKey: "adminSettings.exportAlreadyOpen",
    });
  });

  it("the approval's 409 carries no reason", async () => {
    approve = async () => ({ status: "conflict" });
    const base = await start();
    const v = APPROVE.find((x) => x.name === "conflict")!;
    const got = await post(`${base}${BASE}/${EXPORT}/approve`, v);
    expect(got.status).toBe(409);
    const body = (await got.json()) as Record<string, unknown>;
    expect(body.error).toBe("conflict");
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("reasonKey");
  });
});
