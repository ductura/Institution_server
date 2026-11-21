// SRV-1807 (plan M8.6, R-05, R-06, D-173): what a link to a submission package
// hands out. Both kinds come from one checked build of the portable record
// (SRV-1312), so they use the same stored values of the submission and are
// vouched for by the same checks; nothing is generated anew per download.
//
//   package   the portable record ZIP itself: its manifest.json is the one
//             manifest of D-173 and the unpacked folder is checked offline by
//             scripts/evidence-verify --record (SRV-1311, SRV-1312)
//   referada  the receipt PDF alone, for the registrar: the submission id, the
//             times, the hash of the work and the QR; the text of the work is
//             not in it (R-06)
import { createHash } from "node:crypto";

import {
  buildPortableRecord,
  PORTABLE_RECORD_FILENAME,
  type PortableRecordInput,
  type PortableRecordRefusal,
} from "../portable-record/index.ts";

import type { PackageKind } from "./link.ts";

export const REFERADA_CONFIRMATION_FILENAME = "potvrda-za-referadu.pdf";

export type SubmissionPackageBuild =
  | {
      readonly status: "built";
      readonly kind: PackageKind;
      readonly bytes: Uint8Array;
      /** Lowercase hex SHA-256 of `bytes`. */
      readonly sha256: string;
      readonly filename: string;
      readonly contentType: "application/zip" | "application/pdf";
    }
  | { readonly status: "refused"; readonly reason: PortableRecordRefusal };

export async function buildSubmissionPackage(
  kind: PackageKind,
  input: PortableRecordInput,
): Promise<SubmissionPackageBuild> {
  const record = await buildPortableRecord(input);
  if (record.status === "refused") return record;
  if (kind === "package") {
    return {
      status: "built",
      kind,
      bytes: record.bytes,
      sha256: record.sha256,
      filename: PORTABLE_RECORD_FILENAME,
      contentType: "application/zip",
    };
  }
  return {
    status: "built",
    kind,
    bytes: record.receiptPdf,
    sha256: createHash("sha256").update(record.receiptPdf).digest("hex"),
    filename: REFERADA_CONFIRMATION_FILENAME,
    contentType: "application/pdf",
  };
}
