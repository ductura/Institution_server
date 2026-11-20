import { afterEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createTeacherMentorshipRequestRoutesFor } from "./teacher-mentorship-requests.ts";

const ORIGIN = "https://ductura.example.invalid";
const COOKIE = `__Host-ductus_session=${"a".repeat(43)}`;
const REQUEST_ID = "00000000-0000-4000-8000-0000000000B1";
const MENTORSHIP_ID = "00000000-0000-4000-8000-0000000000c1";
const ROOT = "/api/v1/teacher/mentorship-requests";
const APPROVE = { requestId: REQUEST_ID, decision: "approve" };
let server: Running | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(withActor: WithActor) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createTeacherMentorshipRequestRoutesFor({ withActor }),
  });
  return (suffix: string, options: RequestInit) =>
    fetch(`http://127.0.0.1:${server!.port}${ROOT}${suffix}`, options);
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { origin: ORIGIN, cookie: COOKIE, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

it.each([
  null,
  [],
  { ...APPROVE, requestId: "bad" },
  { ...APPROVE, studentId: REQUEST_ID },
  { ...APPROVE, decision: "withdraw" },
  { ...APPROVE, reason: "Razlog." },
  { ...APPROVE, decision: "decline", reason: null },
  { ...APPROVE, decision: "decline", reason: " \n" },
  { ...APPROVE, decision: "decline", reason: "📝".repeat(601) },
  { ...APPROVE, decision: "decline", reason: "\u0000" },
])("rejects invalid decision body %j before SQL", async (body) => {
  const withActor = vi.fn((): never => {
    throw new Error("refused body reached SQL");
  });
  const send = await start(withActor);
  expect((await send("/decision", post(body))).status).toBe(422);
  expect(withActor).not.toHaveBeenCalled();
});

it("applies the session, origin, content type and size guards before SQL", async () => {
  const withActor = vi.fn((): never => {
    throw new Error("refused request reached SQL");
  });
  const send = await start(withActor);
  expect((await send("", {})).status).toBe(401);
  expect(
    (await send("", { headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } })).status,
  ).toBe(403);
  expect((await send("/decision", post(APPROVE, { origin: "https://other.invalid" }))).status).toBe(
    403,
  );
  expect((await send("/decision", post(APPROVE, { "content-type": "text/plain" }))).status).toBe(
    415,
  );
  expect((await send("/decision", post({ ...APPROVE, reason: "a".repeat(8192) }))).status).toBe(
    413,
  );
  expect(withActor).not.toHaveBeenCalled();
});

it.each([null, { givenName: "Dora", familyName: "Izmišljena" }])(
  "lists the request projection with student %j and uses no-store",
  async (student) => {
    const request = {
      requestId: REQUEST_ID.toLowerCase(),
      student,
      workType: "bachelor_thesis",
      requestedAt: "2026-11-20T10:00:00.000Z",
    };
    const query = vi.fn().mockResolvedValue({ rows: [{ requests: [request] }], rowCount: 1 });
    const send = await start((_, run) => run({ query }));
    const result = await send("", { headers: { cookie: COOKIE } });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ requests: [request] });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await send("", { headers: { cookie: COOKIE } })).status).toBe(401);
  },
);

it("calls the atomic approval RPC and maps its repeat decision to 409", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ result: MENTORSHIP_ID }] })
    .mockRejectedValueOnce(
      Object.assign(new Error("simulated repeat decision"), { code: "ZD409" }),
    );
  const send = await start((_, run) => run({ query }));
  const first = await send("/decision", post(APPROVE));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ decision: "approve", mentorshipId: MENTORSHIP_ID });
  expect((await send("/decision", post(APPROVE))).status).toBe(409);
  expect(query.mock.calls).toEqual(
    Array.from({ length: 2 }, () => [
      expect.stringContaining("app.approve_mentorship_request_with_work"),
      [REQUEST_ID.toLowerCase()],
    ]),
  );
});

it("passes a 600-code-point decline reason and never reports success after a failed commit", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ result: true }] })
    .mockResolvedValueOnce({ rows: [{ result: false }] })
    .mockResolvedValueOnce({ rows: [{ result: true }] });
  let failCommit = false;
  const send = await start(
    async <T>(_: string | null | undefined, run: (tx: ActorTransaction) => Promise<T>) => {
      const result = await run({ query });
      if (failCommit) throw new Error("simulated commit failure");
      return result;
    },
  );
  const reason = "📝".repeat(600);
  const decline = post({ ...APPROVE, decision: "decline", reason });
  const result = await send("/decision", decline);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ decision: "decline" });
  expect(query.mock.calls[0]?.[1]).toEqual([REQUEST_ID.toLowerCase(), reason]);
  expect((await send("/decision", decline)).status).toBe(409);
  failCommit = true;
  expect((await send("/decision", decline)).status).toBe(503);
});

it.each([
  ["ZD401", 401],
  ["ZD403", 403],
  ["ZD409", 409],
  ["ZD422", 422],
])("maps database refusal %s to HTTP %s", async (code, status) => {
  const query = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("simulated RPC refusal"), { code }));
  const send = await start((_, run) => run({ query }));
  expect((await send("/decision", post({ ...APPROVE, decision: "decline" }))).status).toBe(status);
  expect(query.mock.calls[0]?.[1]).toEqual([REQUEST_ID.toLowerCase(), null]);
});
