// SRV-NF1-PREDANO (Ductus#2055 c.7145546227): GET /api/v1/student/assignment-submissions
// over a fake port. The 200 vectors are built from receipts that bind (each
// payload's own JCS and digest), so the route answers exactly the vector body;
// identity comes only from the session cookie.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
  type MyAssignmentSubmissionsReader,
  type StoredAssignmentSubmission,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createStudentAssignmentSubmissionsRoute } from "./student-submission.ts";

type Row = { assignmentId: string; submittedAt: string | null; afterDeadline: boolean | null };
type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/student.assignment-submissions.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
const { vectors: receiptVectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/student.submission.get.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    response: { body: { receipt?: { payload: Record<string, unknown>; signature: object } } };
  }[];
};
const RECEIPT = receiptVectors.find((v) => v.name === "potvrdeno")!.response.body.receipt!;
// JCS of a flat payload of ASCII strings, integers and booleans is JSON with sorted
// keys (this area may not import domain, docs/server-map.md §2).
const jcs = (payload: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1))));
const token = "izmisljeni-token-popisa-predaja-00000000001";
const cookie = `__Host-ductus_session=${token}`;

/** A stored row that binds and gives exactly `row`. */
function storedOf(row: Row): StoredAssignmentSubmission {
  if (row.submittedAt === null)
    return { assignmentId: row.assignmentId, stored: { state: "none" } };
  const payload = {
    ...RECEIPT.payload,
    assignmentId: row.assignmentId,
    requestedAt: row.submittedAt,
    afterDeadline: row.afterDeadline,
    // afterDeadline is requestedAt > dueAt in the receipt; keep the payload consistent.
    dueAt: row.afterDeadline ? "2026-11-01T00:00:00.000000Z" : "2026-12-20T22:59:00.000000Z",
  };
  const text = jcs(payload);
  return {
    assignmentId: row.assignmentId,
    stored: {
      state: "potvrdeno",
      revision: RECEIPT.payload["revision"] as number,
      receiptPayload: text,
      payloadDigestSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      signature: structuredClone(RECEIPT.signature) as Record<string, unknown>,
    },
  };
}

let running: Running | undefined;
async function start(read: MyAssignmentSubmissionsReader["read"]): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStudentAssignmentSubmissionsRoute({ read })],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignment-submissions`;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

describe("GET /api/v1/student/assignment-submissions", () => {
  it.each(vectors)("matches the $name contract vector", async ({ request, response }) => {
    const read = vi
      .fn<MyAssignmentSubmissionsReader["read"]>()
      .mockResolvedValue(
        response.status === 503
          ? { ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR }
          : { ok: true, value: ((response.body.assignments ?? []) as Row[]).map(storedOf) },
      );
    const url = await start(read);
    const got = await fetch(url, request.headers === undefined ? {} : { headers: request.headers });
    expect(got.status).toBe(response.status);
    expect(got.headers.get("content-type")).toMatch(/^application\/json\b/u);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    if (response.status === 200) {
      expect(await got.json()).toEqual(response.body);
    } else {
      expect(await got.json()).toEqual({
        ...response.body,
        requestId: got.headers.get("x-request-id"),
      });
    }
    expect(read.mock.calls).toEqual(response.status === 401 ? [] : [[token]]);
  });

  it("rejects a malformed or duplicate session cookie before reading", async () => {
    const read = vi.fn<MyAssignmentSubmissionsReader["read"]>();
    const url = await start(read);
    for (const header of ["__Host-ductus_session=wrong", `${cookie}; ${cookie}`]) {
      expect((await fetch(url, { headers: { cookie: header } })).status).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before reading", async () => {
    const read = vi.fn<MyAssignmentSubmissionsReader["read"]>();
    const got = await fetch(await start(read), {
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(got.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("takes identity only from the session cookie and rejects an expired session", async () => {
    const read = vi.fn<MyAssignmentSubmissionsReader["read"]>().mockResolvedValue({
      ok: false,
      error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
    });
    const url = await start(read);
    const got = await fetch(`${url}?studentId=demo-other`, {
      headers: { cookie: `${cookie}; ductus_session=demo-other`, "x-student-id": "demo-other" },
    });
    expect(got.status).toBe(401);
    expect(read.mock.calls).toEqual([[token]]);
  });

  it("returns a generic 503 when the reader rejects or a receipt does not bind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = vi
      .fn<MyAssignmentSubmissionsReader["read"]>()
      .mockRejectedValue(new Error("invented error"));
    const first = await fetch(await start(rejected), { headers: { cookie } });
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: "unavailable" });
    await running?.close();
    const row = storedOf({
      assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02",
      submittedAt: "2026-11-20T09:15:42.123456Z",
      afterDeadline: false,
    });
    const unbound = { ...row, assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e03" };
    const second = await fetch(await start(async () => ({ ok: true, value: [unbound] })), {
      headers: { cookie },
    });
    expect(second.status).toBe(503);
    const body: unknown = await second.json();
    expect(body).toMatchObject({ code: "unavailable" });
    expect(body).not.toHaveProperty("assignments");
  });
});
