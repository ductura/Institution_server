// SRV-1308 (M10.5; D-271 MQ02): the package of a student data export, one
// deterministic ZIP (stored entries, a fixed timestamp, names in a fixed
// order): the same contents, origin and labels give the same bytes. It holds
// only what the worker read for one person (server/database
// student-data-export): the exact submitted texts, the receipt PDF of each
// signed submission (the same renderer and confirmation code as the
// student's own receipt), the
// person's notes, and who opened their works, by day of Europe/Zagreb. A
// manifest names every file with its SHA-256. Nothing here reads a clock, the
// network or a database.
import { createHash } from "node:crypto";

import {
  accessLogDaysOf,
  digestSubmissionReceiptPayloadV2,
  isSignedSubmissionReceiptV2,
  isSubmissionReceiptPayloadV2,
  type SignedSubmissionReceiptV2,
} from "../../domain/index.ts";
import { renderReceiptPdf, writeZip, type ZipEntry } from "../../downloads/index.ts";

/** The labels of the receipt PDF (the student's own receipt uses the same). */
export type StudentDataExportLabels = Parameters<typeof renderReceiptPdf>[2];

export const STUDENT_DATA_EXPORT_FORMAT = "ductura-student-data-export-v1";
export const STUDENT_DATA_EXPORT_FILENAME = "izvoz-mojih-podataka.zip";
export const MANIFEST_FILE = "manifest.json";
export const NOTES_FILE = "biljeske.json";
export const ACCESS_LOG_FILE = "dnevnik-pristupa.json";

export type PackageSubmission = {
  readonly submissionId: string;
  readonly assignmentId: string;
  readonly revision: number;
  readonly requestedAt: string;
  readonly body: string;
  readonly receipt: {
    readonly payload: string;
    readonly payloadDigestSha256: string;
    readonly signature: unknown;
  } | null;
  /**
   * Dizajn 1.1: the bound confirmation code of the receipt, so its PDF is the
   * bytes student.receipt-pdf.get gives; null while the receipt waits.
   */
  readonly confirmationCode: string | null;
};

export type PackageNote = {
  readonly noteId: string;
  readonly assignmentId: string;
  readonly createdAt: string;
  readonly text: string;
};

export type PackageContents = {
  readonly submissions: readonly PackageSubmission[];
  readonly notes: readonly PackageNote[];
  /** Rows as app.read_my_access_log gives them. */
  readonly accessLog: readonly Record<string, unknown>[];
};

export type PackageRefusal = "receipt_malformed" | "access_log_malformed";

export type PackageBuild =
  | {
      readonly status: "built";
      readonly bytes: Uint8Array;
      /** Lowercase hex SHA-256 of `bytes`. */
      readonly sha256: string;
      /** The names in the ZIP, in order. */
      readonly names: readonly string[];
    }
  | { readonly status: "refused"; readonly reason: PackageRefusal };

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
/** Code-point order, the same on every machine (no locale collation). */
const byKey =
  <T>(key: (value: T) => string) =>
  (a: T, b: T) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };

/** A stored receipt as the signed receipt the PDF renders, or null if it is not one of this submission. */
async function receiptOf(submission: PackageSubmission): Promise<SignedSubmissionReceiptV2 | null> {
  const stored = submission.receipt;
  if (stored === null) return null;
  try {
    const payload: unknown = JSON.parse(stored.payload);
    if (!isSubmissionReceiptPayloadV2(payload) || payload.submissionId !== submission.submissionId)
      return null;
    const digest = await digestSubmissionReceiptPayloadV2(payload);
    if (digest.canonical !== stored.payload || digest.sha256 !== stored.payloadDigestSha256)
      return null;
    const receipt = { payload, payloadDigestSha256: digest.sha256, signature: stored.signature };
    return isSignedSubmissionReceiptV2(receipt) ? structuredClone(receipt) : null;
  } catch {
    return null;
  }
}

/** The text's file: JSON when the stored body is a JSON object (the editor's document), plain text otherwise. */
function textFileOf(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return "predani-tekst.json";
  } catch {
    // plain text
  }
  return "predani-tekst.txt";
}

export async function buildStudentDataExportPackage(
  contents: PackageContents,
  origin: string,
  labels: StudentDataExportLabels,
): Promise<PackageBuild> {
  const entries: ZipEntry[] = [];
  const submissions = [...contents.submissions].sort(
    byKey((s) => `${s.requestedAt} ${s.submissionId}`),
  );
  const listed: unknown[] = [];
  for (const [index, submission] of submissions.entries()) {
    const folder = `predaje/${String(index + 1).padStart(3, "0")}-${submission.submissionId}`;
    const textName = `${folder}/${textFileOf(submission.body)}`;
    entries.push({ name: textName, data: encoder.encode(submission.body) });
    let receiptName: string | null = null;
    if (submission.receipt !== null) {
      const receipt = await receiptOf(submission);
      if (receipt === null) return { status: "refused", reason: "receipt_malformed" };
      receiptName = `${folder}/potvrda-predaje.pdf`;
      entries.push({
        name: receiptName,
        data: await renderReceiptPdf(receipt, origin, labels, submission.confirmationCode),
      });
    }
    listed.push({
      submissionId: submission.submissionId,
      assignmentId: submission.assignmentId,
      revision: submission.revision,
      requestedAt: submission.requestedAt,
      text: textName,
      // Null while the receipt waits for its signature; it is then not in the package.
      receipt: receiptName,
    });
  }

  const notes = [...contents.notes].sort(byKey((n) => `${n.createdAt} ${n.noteId}`)).map((n) => ({
    noteId: n.noteId,
    assignmentId: n.assignmentId,
    createdAt: n.createdAt,
    text: n.text,
  }));
  entries.push({ name: NOTES_FILE, data: json({ notes }) });

  const days = accessLogDaysOf(contents.accessLog);
  if (days === null) return { status: "refused", reason: "access_log_malformed" };
  entries.push({
    name: ACCESS_LOG_FILE,
    data: json({
      timeZone: "Europe/Zagreb",
      days: days.map((day) => ({
        date: day.key,
        openings: day.entries.map((entry) => ({
          from: entry.from,
          to: entry.to,
          role: entry.role,
          surface: entry.surface,
          reader: entry.reader,
        })),
      })),
    }),
  });

  entries.sort(byKey((entry) => entry.name));
  const manifest = {
    format: STUDENT_DATA_EXPORT_FORMAT,
    submissions: listed,
    files: entries.map((entry) => ({
      name: entry.name,
      bytes: entry.data.byteLength,
      sha256: sha256(entry.data),
    })),
  };
  const all = [{ name: MANIFEST_FILE, data: json(manifest) }, ...entries];
  const bytes = writeZip(all);
  return { status: "built", bytes, sha256: sha256(bytes), names: all.map((entry) => entry.name) };
}
