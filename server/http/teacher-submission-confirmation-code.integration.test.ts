// Dizajn 27. 11., 1.1 (Ductus#2059): GET /api/v1/teacher/assignments/{assignmentId}/
// students/{studentId}/submission/confirmation-code over a fake port. Identity comes
// only from the session cookie; a refused, unknown or malformed id is the same 404.
// Every id and token is invented.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_NOT_FOUND,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
  type MySubmissionConfirmationCodeReader,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createTeacherSubmissionConfirmationCodeRoute } from "./teacher-submission-receipt.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000b1";
const token = "izmisljeni-token-koda-nastavnika-".padEnd(43, "0");
const cookie = `__Host-ductus_session=${token}`;
const CODE = "DK7M-4Q9P-X2HT-R8VN";
type TeacherRead = MySubmissionConfirmationCodeReader["teacherRead"];

let running: Running | undefined;
async function start(teacherRead: TeacherRead): Promise<string> {
  const read = vi.fn<MySubmissionConfirmationCodeReader["read"]>();
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createTeacherSubmissionConfirmationCodeRoute({ read, teacherRead })],
  });
  return `http://127.0.0.1:${running.port}/api/v1/teacher/assignments`;
}
afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});
const path = (assignment: string, student: string) =>
  `/${assignment}/students/${student}/submission/confirmation-code`;

describe("GET /api/v1/teacher/assignments/{a}/students/{s}/submission/confirmation-code", () => {
  it("answers the code and reads with the session token and the lower-case ids", async () => {
    const teacherRead = vi.fn<TeacherRead>().mockResolvedValue({ ok: true, value: CODE });
    const base = await start(teacherRead);
    const got = await fetch(base + path(A.toUpperCase(), S.toUpperCase()), {
      headers: { cookie },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual({ code: CODE });
    expect(teacherRead.mock.calls).toEqual([[token, A, S]]);
  });

  it("answers null while the submission waits for its receipt", async () => {
    const teacherRead = vi.fn<TeacherRead>().mockResolvedValue({ ok: true, value: null });
    const got = await fetch((await start(teacherRead)) + path(A, S), { headers: { cookie } });
    expect(await got.json()).toEqual({ code: null });
  });

  it("answers the same 404 for a refused read and for ids that are not uuids, reading neither of the latter", async () => {
    const teacherRead = vi
      .fn<TeacherRead>()
      .mockResolvedValue({ ok: false, error: MY_SUBMISSION_STATE_NOT_FOUND });
    const base = await start(teacherRead);
    expect((await fetch(base + path(A, S), { headers: { cookie } })).status).toBe(404);
    teacherRead.mockClear();
    expect((await fetch(base + path("nije-uuid", S), { headers: { cookie } })).status).toBe(404);
    expect((await fetch(base + path(A, "nije-uuid"), { headers: { cookie } })).status).toBe(404);
    expect(teacherRead).not.toHaveBeenCalled();
  });

  it("answers 401 for an ended session, 503 for a database error and for a code outside the contract", async () => {
    const teacherRead = vi
      .fn<TeacherRead>()
      .mockResolvedValueOnce({ ok: false, error: MY_SUBMISSION_STATE_UNAUTHENTICATED })
      .mockResolvedValueOnce({ ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR })
      .mockResolvedValueOnce({ ok: true, value: "DK7M-4Q9P-X2HT-R8VI" });
    const url = (await start(teacherRead)) + path(A, S);
    expect((await fetch(url, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(url, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(url, { headers: { cookie } })).status).toBe(503);
  });

  it("rejects a missing session and a cross-site request before reading", async () => {
    const teacherRead = vi.fn<TeacherRead>();
    const url = (await start(teacherRead)) + path(A, S);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    expect(teacherRead).not.toHaveBeenCalled();
  });
});
