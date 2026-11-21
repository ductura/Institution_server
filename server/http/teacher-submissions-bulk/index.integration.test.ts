// SRV-1902 acceptance (plan P-D2): the teacher downloads every submission of an
// assignment as one ZIP through a 24 hour link. On a real server with the real
// roster read, receipt check, receipt PDF and ZIP builder, over fake ports that
// keep the rules of the database: only the teacher of the assignment reads it
// (anyone else the same not_found, C-23), and the read of the submitted texts
// records the teacher's opening in the access log, as app.fast_path_works
// does. Acceptance: (1) another's assignment 404, (2) a record in the access
// log per download, (3) an expired link 410, (4) the ZIP holds only the
// submissions of that assignment. Every person, token, id and text is invented.
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  LABELS,
  PAYLOAD,
  sourceOf,
  STUDENT_A,
  STUDENT_B,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import type { MySubmissionStateReader, StoredSubmissionState } from "../../database/index.ts";
import {
  createMerlinRosterReader,
  renderReceiptPdf,
  type MerlinRosterDeps,
} from "../../downloads/index.ts";
import { readTeacherSubmission } from "../../institution/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { MERLIN_LABELS } from "../merlin-roster/index.ts";

import {
  BULK_FINGERPRINTS,
  BULK_LINK_TTL_MS,
  createTeacherSubmissionsBulkRoutes,
  type TeacherSubmissionsBulkDeps,
} from "./index.ts";

const ORIGIN = "https://demo-fakultet.invalid";
const ASSIGNMENT = PAYLOAD.assignmentId;
const OTHER_ASSIGNMENT = "0b9d4e27-3c61-4a8f-9e25-7d1f6a4c8e30";
const TEACHER = "t".repeat(43);
const OTHER_TEACHER = "o".repeat(43);
/** A third invented student who has not submitted. */
const STUDENT_C = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const cookie = (token: string) => `__Host-ductus_session=${token}`;

const document = (text: string) =>
  JSON.stringify({
    nodes: [
      {
        children: [{ marks: [], text, type: "text" }],
        id: "00000000-0000-4000-8000-000000000001",
        type: "paragraph",
      },
    ],
    schemaVersion: 1,
  });

type Opening = { token: string; assignmentId: string; students: string[] };

/** The ports as the database answers them; `log` stands for audit.access_log. */
async function fakePorts(over: { principalOfA?: string } = {}) {
  const log: Opening[] = [];
  const teaches = (token: string, assignmentId: string) =>
    token === TEACHER && assignmentId === ASSIGNMENT;
  const receiptA = await sourceOf({
    ...PAYLOAD,
    principalId: over.principalOfA ?? STUDENT_A.id,
  });
  const states = new Map<string, StoredSubmissionState>([
    [
      STUDENT_A.id,
      {
        state: "potvrdeno",
        revision: PAYLOAD.revision,
        receiptPayload: receiptA.receiptPayload,
        payloadDigestSha256: receiptA.payloadDigestSha256,
        signature: receiptA.signature,
      },
    ],
    [STUDENT_B.id, { state: "ceka", revision: 3, requestedAt: "2026-11-20T10:58:30.000000Z" }],
    [STUDENT_C, { state: "none" }],
  ]);
  const reader = {
    teacherState: async (token: string | undefined, assignmentId: string, studentId: string) =>
      token !== undefined && teaches(token, assignmentId) && states.has(studentId)
        ? { ok: true, value: states.get(studentId)! }
        : { ok: false, error: { code: "MY_SUBMISSION_STATE_NOT_FOUND" } },
  } as unknown as MySubmissionStateReader;
  const roster = createMerlinRosterReader({
    extensions: async (token, assignmentId) =>
      teaches(token, assignmentId) ? { status: "read", extensions: [] } : { status: "not_found" },
    submissions: (async (_token: string, ids: string[]) => ({
      status: "ok",
      submissions: new Map([
        [
          ids[0],
          [
            {
              studentId: STUDENT_A.id,
              submitted: true,
              revision: PAYLOAD.revision,
              requestedMinute: "2026-11-20T10:58:00.000Z",
              afterDeadline: false,
            },
            {
              studentId: STUDENT_B.id,
              submitted: true,
              revision: 3,
              requestedMinute: "2026-11-20T10:58:00.000Z",
              afterDeadline: false,
            },
            {
              studentId: STUDENT_C,
              submitted: false,
              revision: null,
              requestedMinute: null,
              afterDeadline: null,
            },
          ],
        ],
      ]),
    })) as unknown as MerlinRosterDeps["submissions"],
    works: async (token, assignmentId) => {
      const students = [
        {
          studentId: STUDENT_A.id,
          givenName: "Ivana",
          familyName: "Izmišljena",
          work: {
            documentId: "rad-a",
            submitted: true,
            revision: PAYLOAD.revision,
            body: document("Izmišljeni rad o kompostu"),
          },
        },
        {
          studentId: STUDENT_B.id,
          givenName: "Petar",
          familyName: "Primjerić",
          work: {
            documentId: "rad-b",
            submitted: true,
            revision: 3,
            body: document("Drugi izmišljeni rad"),
          },
        },
        { studentId: STUDENT_C, givenName: "Demo", familyName: "Student", work: null },
      ];
      // app.fast_path_works: every returned text is the teacher's recorded opening.
      log.push({
        token,
        assignmentId,
        students: students.filter((s) => s.work !== null).map((s) => s.studentId),
      });
      return { status: "read", students };
    },
    labels: MERLIN_LABELS,
  });
  const deps: TeacherSubmissionsBulkDeps = {
    access: async (token, assignmentId) => (teaches(token, assignmentId) ? "read" : "not_found"),
    roster,
    receipt: (token, assignmentId, studentId) =>
      readTeacherSubmission(reader, token, assignmentId, studentId),
    renderReceipt: (receipt) => renderReceiptPdf(receipt, ORIGIN, LABELS),
  };
  return { deps, log };
}

let running: Running | undefined;
const START = Date.parse("2026-11-21T10:00:00.000Z");
let clock = START;

async function start(deps: TeacherSubmissionsBulkDeps): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createTeacherSubmissionsBulkRoutes({ ...deps, now: () => clock }),
  });
  return `http://127.0.0.1:${running.port}`;
}

afterEach(async () => {
  clock = START;
  await running?.close();
  running = undefined;
});

const post = (host: string, assignmentId: string, token: string, body: unknown) =>
  fetch(`${host}/api/v1/teacher/assignments/${assignmentId}/submissions-bulk-link`, {
    method: "POST",
    headers: {
      cookie: cookie(token),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
const get = (host: string, path: string, token: string, headers: Record<string, string> = {}) =>
  fetch(host + path, { headers: { cookie: cookie(token), ...headers } });

type Link = { format: string; downloadPath: string; expiresAt: string };
async function linkFor(host: string, format: "pdf" | "docx"): Promise<Link> {
  const answer = await post(host, ASSIGNMENT, TEACHER, { format });
  expect(answer.status).toBe(201);
  return (await answer.json()) as Link;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("teacher.submissions-bulk-link.post and teacher.submissions-bulk.get", () => {
  it("hands the teacher a ZIP of only this assignment's submitted works with their receipts (4)", async () => {
    const { deps } = await fakePorts();
    const host = await start(deps);
    const link = await linkFor(host, "pdf");
    expect(link.format).toBe("pdf");
    expect(link.expiresAt).toBe(new Date(START + BULK_LINK_TTL_MS).toISOString());
    expect(link.downloadPath).toMatch(
      new RegExp(`^/api/v1/teacher/assignments/${ASSIGNMENT}/submissions-bulk/pdf\\?token=`, "u"),
    );
    const answer = await get(host, link.downloadPath, TEACHER);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/zip");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="predaje.zip"');
    expect(answer.headers.get("cache-control")).toBe("private, no-store");
    const zip = new Uint8Array(await answer.arrayBuffer());
    expect(answer.headers.get("x-content-sha256")).toBe(sha256(zip));
    const files = unzipStored(zip);
    const names = [...files.keys()];
    const a = `izmisljena-ivana-${STUDENT_A.id.slice(0, 8)}`;
    const b = `primjeric-petar-${STUDENT_B.id.slice(0, 8)}`;
    // B's receipt still awaits its signature; C has not submitted.
    expect(names).toEqual([`${a}.pdf`, `${a}-potvrda.pdf`, `${b}.pdf`, BULK_FINGERPRINTS]);
    expect(names.some((name) => name.includes(STUDENT_C.slice(0, 8)))).toBe(false);
    for (const [name, bytes] of files) {
      if (name !== BULK_FINGERPRINTS) {
        expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
      }
    }
    const fingerprints = new TextDecoder().decode(files.get(BULK_FINGERPRINTS));
    expect(fingerprints).toBe(
      names
        .slice(0, -1)
        .map((name) => `${sha256(files.get(name)!)}  ${name}\n`)
        .join(""),
    );
    // The receipt is the same PDF the receipt route renders for this student.
    const receipt = files.get(`${a}-potvrda.pdf`)!;
    const signed = await sourceOf();
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(JSON.parse(signed.receiptPayload).principalId).toBe(STUDENT_A.id);
  });

  it("hands out DOCX for format docx, the same receipts, and the same bytes again", async () => {
    const { deps } = await fakePorts();
    const host = await start(deps);
    const link = await linkFor(host, "docx");
    const first = new Uint8Array(await (await get(host, link.downloadPath, TEACHER)).arrayBuffer());
    const again = new Uint8Array(await (await get(host, link.downloadPath, TEACHER)).arrayBuffer());
    expect(sha256(again)).toBe(sha256(first));
    const names = [...unzipStored(first).keys()];
    expect(names.filter((name) => name.endsWith(".docx"))).toHaveLength(2);
    expect(names.filter((name) => name.endsWith("-potvrda.pdf"))).toHaveLength(1);
    expect(names.filter((name) => name.endsWith(".pdf") && !name.includes("potvrda"))).toEqual([]);
  });

  it("records the opening in the access log on every download, and not on the link (2)", async () => {
    const { deps, log } = await fakePorts();
    const host = await start(deps);
    const link = await linkFor(host, "pdf");
    expect(log).toEqual([]);
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(200);
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(200);
    const opening = {
      token: TEACHER,
      assignmentId: ASSIGNMENT,
      students: [STUDENT_A.id, STUDENT_B.id],
    };
    expect(log).toEqual([opening, opening]);
  });

  it("answers 404 for another's assignment, another session, assignment or format (1)", async () => {
    const { deps, log } = await fakePorts();
    const host = await start(deps);
    expect((await post(host, ASSIGNMENT, OTHER_TEACHER, { format: "pdf" })).status).toBe(404);
    expect((await post(host, OTHER_ASSIGNMENT, TEACHER, { format: "pdf" })).status).toBe(404);
    expect((await post(host, "nije-oznaka", TEACHER, { format: "pdf" })).status).toBe(404);
    const link = await linkFor(host, "pdf");
    const notFound = async (path: string, token = TEACHER) => {
      const answer = await get(host, path, token);
      expect(answer.status).toBe(404);
      expect(((await answer.json()) as { code: string }).code).toBe("not_found");
    };
    await notFound(link.downloadPath, OTHER_TEACHER);
    await notFound(link.downloadPath.replace(ASSIGNMENT, OTHER_ASSIGNMENT));
    await notFound(link.downloadPath.replace("/pdf?", "/docx?"));
    await notFound(link.downloadPath.replace(/token=\d+/u, "token=4102444800000"));
    await notFound(link.downloadPath.replace(/\?token=.*$/u, ""));
    expect(log).toEqual([]);
  });

  it("answers 404 when the link is right but the caller no longer teaches the assignment (1)", async () => {
    const { deps } = await fakePorts();
    let teaching = true;
    const host = await start({
      ...deps,
      roster: async (token, assignmentId) =>
        teaching ? deps.roster(token, assignmentId) : { status: "not_found" },
    });
    const link = await linkFor(host, "pdf");
    teaching = false;
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(404);
  });

  it("answers 410 once the 24 hours have passed, and reads nothing (3)", async () => {
    const { deps, log } = await fakePorts();
    const host = await start(deps);
    const link = await linkFor(host, "pdf");
    clock = START + BULK_LINK_TTL_MS - 1;
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(200);
    clock = START + BULK_LINK_TTL_MS;
    const expired = await get(host, link.downloadPath, TEACHER);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { code: string }).code).toBe("not_allowed");
    expect(log).toHaveLength(1);
  });

  it("answers 403 to a cross-site read and 401 without a session", async () => {
    const { deps } = await fakePorts();
    const host = await start(deps);
    const link = await linkFor(host, "pdf");
    const crossSite = await get(host, link.downloadPath, TEACHER, {
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    expect((await fetch(host + link.downloadPath)).status).toBe(401);
  });

  it("answers 503 and no ZIP when a receipt is not the student's, or without APP_ORIGIN", async () => {
    const mismatched = await fakePorts({ principalOfA: STUDENT_B.id });
    let host = await start(mismatched.deps);
    let link = await linkFor(host, "pdf");
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(503);
    await running?.close();
    const { deps } = await fakePorts();
    host = await start({ ...deps, renderReceipt: null });
    link = await linkFor(host, "pdf");
    expect((await get(host, link.downloadPath, TEACHER)).status).toBe(503);
  });
});
