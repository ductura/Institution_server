// SRV-1902 (plan P-D2): the ZIP of all submissions of one assignment for its
// teacher. The works come from the Merlin roster read (SRV-1109): the
// submitted revision of every student, rendered once as PDF and DOCX, with
// the SHA-256 of each file on its row; the roster throws when the
// submissions and the documents disagree. Here only the files of the chosen
// format are taken, each checked against its row, with the receipt PDF of
// the same student next to it and otisci.sha256 over everything. The ZIP
// writer is the export's (stored entries, fixed time), so the same reads give
// the same bytes. A student without a submission has no file.
import { createHash } from "node:crypto";

import { writeZip, type MerlinRosterRead } from "../../downloads/index.ts";

import type { BulkFormat } from "./link.ts";

export type BulkRoster = Extract<MerlinRosterRead, { status: "read" }>["roster"];

/** The name of the download. */
export const BULK_ZIP_FILENAME = "predaje.zip";
/** One line per file: SHA-256, two spaces, name (the sha256sum format). */
export const BULK_FINGERPRINTS = "otisci.sha256";
const RECEIPT_SUFFIX = "-potvrda.pdf";

export type BulkZip = {
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes`. */
  readonly sha256: string;
  /** The names in the ZIP, in order. */
  readonly names: readonly string[];
};

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The ids of the students with a submitted work, in roster order. */
export function submittedStudents(roster: BulkRoster): string[] {
  if (roster.studentIds.length !== roster.rows.length) throw new Error("roster disagrees");
  return roster.rows.flatMap((row, index) => (row.submitted ? [roster.studentIds[index]!] : []));
}

/**
 * The ZIP of the submitted works in `format` and the receipts by student id;
 * throws when a file is not the one its row names or a receipt belongs to a
 * student without a submitted work.
 */
export function buildSubmissionsZip(
  roster: BulkRoster,
  format: BulkFormat,
  receipts: ReadonlyMap<string, Uint8Array>,
): BulkZip {
  const files = new Map(roster.files.map((file) => [file.name, file.bytes]));
  const submitted = new Set(submittedStudents(roster));
  for (const studentId of receipts.keys()) {
    if (!submitted.has(studentId)) throw new Error("receipt without a submitted work");
  }
  const entries: { name: string; data: Uint8Array }[] = [];
  roster.rows.forEach((row, index) => {
    if (!row.submitted) return;
    const name = format === "pdf" ? row.pdfName : row.docxName;
    const sha256 = format === "pdf" ? row.pdfSha256 : row.docxSha256;
    const bytes = name === null ? undefined : files.get(name);
    if (name === null || bytes === undefined || sha256Hex(bytes) !== sha256) {
      throw new Error("roster and files disagree");
    }
    entries.push({ name, data: bytes });
    const receipt = receipts.get(roster.studentIds[index]!);
    if (receipt !== undefined) {
      entries.push({ name: name.replace(/\.(?:pdf|docx)$/u, RECEIPT_SUFFIX), data: receipt });
    }
  });
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length || names.includes(BULK_FINGERPRINTS)) {
    throw new Error("duplicate name in the submissions zip");
  }
  const fingerprints = entries.map((entry) => `${sha256Hex(entry.data)}  ${entry.name}\n`).join("");
  entries.push({ name: BULK_FINGERPRINTS, data: new TextEncoder().encode(fingerprints) });
  const bytes = writeZip(entries);
  return { bytes, sha256: sha256Hex(bytes), names: entries.map((entry) => entry.name) };
}
