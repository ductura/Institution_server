// SRV-KOD-POTVRDE (Ductus#2059, S-08): GET
// /api/v1/student/assignments/{assignmentId}/submission/confirmation-code over a
// fake port. Identity comes only from the session cookie; another's, an unknown
// or a malformed assignment is the same 404. Every id and token is invented.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_NOT_FOUND,
  type MySubmissionConfirmationCodeReader,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createStudentSubmissionConfirmationCodeRoute } from "./student-submission.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const token = "izmisljeni-token-koda-potvrde-".padEnd(43, "0");
const cookie = `__Host-ductus_session=${token}`;
const CODE = "DK7M-4Q9P-X2HT-R8VN";

let running: Running | undefined;
async function start(read: MySubmissionConfirmationCodeReader["read"]): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [
      createStudentSubmissionConfirmationCodeRoute({
        read,
        teacherRead: async () => ({ ok: true, value: null }),
      }),
    ],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignments`;
}
afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

describe("GET /api/v1/student/assignments/{id}/submission/confirmation-code", () => {
  it("answers the code and reads with the session token and the lower-case id", async () => {
    const read = vi
      .fn<MySubmissionConfirmationCodeReader["read"]>()
      .mockResolvedValue({ ok: true, value: CODE });
    const base = await start(read);
    const got = await fetch(`${base}/${A.toUpperCase()}/submission/confirmation-code`, {
      headers: { cookie },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual({ code: CODE });
    expect(read.mock.calls).toEqual([[token, A]]);
  });

  it("answers null before the receipt is bound", async () => {
    const read = vi
      .fn<MySubmissionConfirmationCodeReader["read"]>()
      .mockResolvedValue({ ok: true, value: null });
    const got = await fetch(`${await start(read)}/${A}/submission/confirmation-code`, {
      headers: { cookie },
    });
    expect(await got.json()).toEqual({ code: null });
  });

  it("answers 404 for another's assignment and for an id that is not a uuid, without reading the latter", async () => {
    const read = vi
      .fn<MySubmissionConfirmationCodeReader["read"]>()
      .mockResolvedValue({ ok: false, error: MY_SUBMISSION_STATE_NOT_FOUND });
    const base = await start(read);
    expect(
      (await fetch(`${base}/${A}/submission/confirmation-code`, { headers: { cookie } })).status,
    ).toBe(404);
    read.mockClear();
    expect(
      (await fetch(`${base}/nije-uuid/submission/confirmation-code`, { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 503 for a database error and for a code outside the contract", async () => {
    const read = vi
      .fn<MySubmissionConfirmationCodeReader["read"]>()
      .mockResolvedValueOnce({ ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR })
      .mockResolvedValueOnce({ ok: true, value: "DK7M-4Q9P-X2HT-R8VI" });
    const base = await start(read);
    const url = `${base}/${A}/submission/confirmation-code`;
    expect((await fetch(url, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(url, { headers: { cookie } })).status).toBe(503);
  });

  it("rejects a missing session and a cross-site request before reading", async () => {
    const read = vi.fn<MySubmissionConfirmationCodeReader["read"]>();
    const url = `${await start(read)}/${A}/submission/confirmation-code`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
