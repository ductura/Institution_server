import { readFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudentSubmissionAnswer } from "../institution/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createReceiptPdfRoutes } from "./receipt-pdf.ts";
import { type Running, startServer } from "./start.ts";

type AnswerBody = Extract<StudentSubmissionAnswer, { status: 200 }>["body"];
type Confirmed = Extract<AnswerBody, { state: "potvrdeno" }>;
const vectors = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/student.submission.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { response: { body: AnswerBody } }[] };
const CONFIRMED = vectors.vectors.find(({ response }) => response.body.state === "potvrdeno")
  ?.response.body as Confirmed;
const { assignmentId, principalId } = CONFIRMED.receipt.payload;
const STUDENT = `/api/v1/student/assignments/${assignmentId}/submission/pdf`;
const TEACHER = `/api/v1/teacher/assignments/${assignmentId}/submissions/${principalId}/pdf`;
const ORIGIN = "https://demo-fakultet.invalid";
const TOKEN = "a".repeat(43);
const SESSION = { cookie: `__Host-ductus_session=${TOKEN}` };

type Read = Parameters<typeof createReceiptPdfRoutes>[0];
let running: Running | undefined;

async function start(read: Read, origin: string | null = ORIGIN): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createReceiptPdfRoutes(read, origin),
  });
  return `http://127.0.0.1:${running.port}`;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("receipt PDF downloads", () => {
  it("uses the session for each read and returns the same private PDF for both readers", async () => {
    const read = vi.fn<Read>().mockResolvedValue({ status: 200, body: CONFIRMED });
    const host = await start(read);
    const student = await fetch(host + STUDENT, { headers: SESSION });
    const teacher = await fetch(host + TEACHER, { headers: SESSION });
    expect(read.mock.calls).toEqual([
      [TOKEN, assignmentId, undefined],
      [TOKEN, assignmentId, principalId],
    ]);
    for (const response of [student, teacher]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    const pdf = (await student.json()) as { filename: string; pdfBase64: string };
    expect(await teacher.json()).toEqual(pdf);
    expect(pdf.filename).toBe("potvrda-predaje.pdf");
    expect((await PDFDocument.load(Buffer.from(pdf.pdfBase64, "base64"))).getPageCount()).toBe(1);
  });

  it.each([
    [STUDENT, {}, 401],
    [TEACHER, { ...SESSION, "sec-fetch-site": "cross-site" }, 403],
    [STUDENT.replace(assignmentId, "nije-uuid"), SESSION, 404],
    [TEACHER.replace(principalId, "nije-uuid"), SESSION, 404],
  ] as const)("refuses invalid requests before reading (%s)", async (path, headers, status) => {
    const read = vi.fn<Read>();
    const response = await fetch((await start(read)) + path, { headers });
    expect(response.status).toBe(status);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 401 }, 401],
    [{ status: 404 }, 404],
    [{ status: 503 }, 503],
    [{ status: 200, body: { state: "none" } }, 404],
    [
      { status: 200, body: { state: "ceka", revision: 7, requestedAt: "2026-11-20T10:00:00Z" } },
      404,
    ],
  ] as const satisfies readonly [StudentSubmissionAnswer, number][])(
    "answers a refusal without PDF data (%j)",
    async (result, status) => {
      const read = vi.fn<Read>().mockResolvedValue(result);
      const response = await fetch((await start(read)) + TEACHER, { headers: SESSION });
      expect(response.status).toBe(status);
      expect(await response.json()).not.toHaveProperty("pdfBase64");
    },
  );

  it("refuses a receipt for the wrong student", async () => {
    const read = vi.fn<Read>().mockResolvedValue({ status: 200, body: CONFIRMED });
    const other = TEACHER.replace(principalId, "00000000-0000-4000-8000-0000000000ff");
    const response = await fetch((await start(read)) + other, { headers: SESSION });
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("pdfBase64");
  });

  it("refuses to derive the verification origin from request headers", async () => {
    const read = vi.fn<Read>();
    const response = await fetch((await start(read, null)) + STUDENT, {
      headers: { ...SESSION, "x-forwarded-host": "druga-ustanova.invalid" },
    });
    expect(response.status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
});
