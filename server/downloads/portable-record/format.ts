// SRV-1312 (plan M7.10; D-49, A-07, D-173, D-263 Q24): the portable record
// of one submission. The names of its files, its manifest and the one entry
// the submission has in the evidence log, shared by the builder (the route)
// and the offline check (scripts/evidence-verify), so the two never disagree.
import { createHash } from "node:crypto";

import type { SignedSubmissionReceiptV2 } from "../../domain/index.ts";

export const PORTABLE_RECORD_FORMAT = "ductura.portable-record.v1";

/** The download name of the ZIP. */
export const PORTABLE_RECORD_FILENAME = "prenosivi-zapis.zip";

/** Every name a portable record may hold, all at the root of the ZIP. */
export const PORTABLE_RECORD_FILES = {
  /** JCS of { format, submissionId, dailyRoot, files }: every other file with its SHA-256. */
  manifest: "manifest.json",
  /** JCS of the signed submission receipt V2, as the student got it. */
  receipt: "potvrda.json",
  /** JCS of the public key the receipt is signed with, with its validity. */
  receiptKey: "kljuc-potvrde.json",
  /** The exact bytes of the submitted text (JCS of the document); its SHA-256 is the receipt's. */
  text: "rad.json",
  /** The receipt PDF; its QR carries only the submission id and the SHA-256, in the fragment. */
  pdf: "potvrda-predaje.pdf",
  /** The stored signed daily root of the day the receipt was signed (SRV-1311). */
  dailyRoot: "dnevni-korijen.json",
  /** The Ed25519 public key of the daily root, SPKI PEM. */
  dailyRootKey: "kljuc-dnevnog-korijena.pem",
  /** JCS of { entry, index, treeSize, proof }: the receipt's entry in that day's tree. */
  proof: "merkle-dokaz.json",
} as const;

export type PortableRecordFileName =
  (typeof PORTABLE_RECORD_FILES)[keyof typeof PORTABLE_RECORD_FILES];

/** The files present only when the day of the receipt has a signed root. */
export const DAILY_ROOT_FILES: readonly PortableRecordFileName[] = [
  PORTABLE_RECORD_FILES.dailyRoot,
  PORTABLE_RECORD_FILES.dailyRootKey,
  PORTABLE_RECORD_FILES.proof,
];

/** Upper bounds of each file, asked before a file is read or parsed. */
export const MAX_PORTABLE_RECORD_FILE_BYTES: Readonly<Record<PortableRecordFileName, number>> = {
  "manifest.json": 4096,
  "potvrda.json": 16 * 1024,
  "kljuc-potvrde.json": 4096,
  // evidence.document_checkpoint keeps at most 2 MiB of text.
  "rad.json": 2 * 1024 * 1024,
  "potvrda-predaje.pdf": 4 * 1024 * 1024,
  "dnevni-korijen.json": 4096,
  "kljuc-dnevnog-korijena.pem": 4096,
  "merkle-dokaz.json": 16 * 1024,
};

/** One line of the manifest. */
export type PortableRecordManifestFile = {
  readonly name: PortableRecordFileName;
  readonly sha256: string;
  readonly bytes: number;
};

export type PortableRecordManifest = {
  readonly format: typeof PORTABLE_RECORD_FORMAT;
  readonly submissionId: string;
  /** `pending` until the day of the receipt is closed and signed. */
  readonly dailyRoot: "included" | "pending";
  /** Every file but the manifest, by name in code point order. */
  readonly files: readonly PortableRecordManifestFile[];
};

/**
 * An entry of the evidence log as SRV-1311 reads it: { receiptId, acceptedAt, digest }.
 */
export type PortableLogEntry = {
  readonly receiptId: string;
  readonly acceptedAt: string;
  readonly digest: string;
};

/**
 * The entry of a submission receipt in the log: the submission id, the signing
 * time cut to the millisecond (a canonical UTC instant, as the log orders
 * entries) and D, the SHA-256 of the receipt's JCS payload (D-92).
 */
export function submissionLogEntry(receipt: SignedSubmissionReceiptV2): PortableLogEntry {
  const { submissionId, signedAt } = receipt.payload;
  return {
    receiptId: submissionId,
    acceptedAt: `${signedAt.slice(0, 23)}Z`,
    digest: receipt.payloadDigestSha256,
  };
}

/** The UTC day of an entry, as the daily root names it. */
export function logEntryDay(entry: PortableLogEntry): string {
  return entry.acceptedAt.slice(0, 10);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function bytesHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * The signed daily root of the day of one receipt, from a source that has
 * already checked the record with its key (SRV-1311 verifyDailyRoot) over
 * exactly `entries`. The builder checks again that `entries` give `root`.
 */
export type PortableDailyRoot = {
  /** The stored bytes of the record { day, root, count, keyId, signature }. */
  readonly record: Uint8Array;
  readonly day: string;
  readonly root: string;
  readonly count: number;
  readonly publicKeyPem: string;
  /** Every entry of that day, in any order. */
  readonly entries: readonly PortableLogEntry[];
};

export type PortableDailyRootRead =
  | { readonly status: "included"; readonly dailyRoot: PortableDailyRoot }
  /** The day is not closed yet, or no root of it is reachable. */
  | { readonly status: "pending" }
  | { readonly status: "unavailable" };

/** Where the route finds the signed root of the day of a receipt's entry. */
export type PortableDailyRootSource = (entry: PortableLogEntry) => Promise<PortableDailyRootRead>;

/**
 * The source until the worker stores daily roots and a reader of the day's
 * entries exists (SRV-1311 left both open): every record says `pending`.
 */
export const PENDING_DAILY_ROOT: PortableDailyRootSource = async () => ({ status: "pending" });
