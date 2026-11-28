// F4-1.1-4-6-SRV: the worker's read of a package carries the bound
// confirmation code of each signed submission, read in the same statement as
// the submissions (app.worker_student_data_export_confirmation_codes), and
// refuses a row where the receipt and its code do not go together. The
// database answers are faked; every value is invented.
import { describe, expect, it } from "vitest";

import { createStudentDataExportWorker } from "./index.ts";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const SIGNED = "c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69";
const WAITING = "0b8a6f3e-2d1c-4e5f-9a7b-6c5d4e3f2a1b";
const ASSIGNMENT = "6f5e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f";
const CODE = "DK7M-4Q9P-X2HT-R8VN";

function row(submissionId: string, receipt: boolean, confirmationCode: unknown) {
  return {
    submissionId,
    assignmentId: ASSIGNMENT,
    revision: "2",
    requestedAt: new Date("2026-11-20T10:58:00.123Z"),
    body: "Izmisljeni predani tekst.",
    payload: receipt ? '{"izmisljeno":true}' : null,
    digest: receipt ? "a".repeat(64) : null,
    signature: receipt ? { algorithm: "Ed25519" } : null,
    confirmationCode,
  };
}

function worker(submissionRows: Record<string, unknown>[]) {
  const asked: string[] = [];
  const port = createStudentDataExportWorker({
    query: async (text: string) => {
      asked.push(text);
      return {
        rows: text.includes("worker_student_data_export_submissions") ? submissionRows : [],
      };
    },
  } as never);
  return { port, asked };
}

describe("createStudentDataExportWorker contents", () => {
  it("carries the code of a signed submission and none while the receipt waits", async () => {
    const { port, asked } = worker([row(SIGNED, true, CODE), row(WAITING, false, null)]);
    const read = await port.contents(EXPORT_ID);
    if (read.status !== "ok") throw new Error("unavailable");
    expect(read.contents.submissions.map((s) => [s.submissionId, s.confirmationCode])).toEqual([
      [SIGNED, CODE],
      [WAITING, null],
    ]);
    // The codes come from the worker's own read, joined by submission in one statement.
    const sql = asked.find((text) => text.includes("worker_student_data_export_submissions"))!;
    expect(sql).toContain("LEFT JOIN app.worker_student_data_export_confirmation_codes($1::uuid)");
    expect(sql).toContain("c.submission_id = s.submission_id");
  });

  it("refuses a receipt without its code, a code without a receipt and a malformed code", async () => {
    for (const bad of [
      row(SIGNED, true, null),
      row(WAITING, false, CODE),
      row(SIGNED, true, "dk7m-4q9p-x2ht-r8vn"),
      row(SIGNED, true, "DK7M-4Q9P-X2HT-R8VU"),
      row(SIGNED, true, undefined),
    ]) {
      expect(await worker([bad]).port.contents(EXPORT_ID)).toEqual({ status: "unavailable" });
    }
  });
});
