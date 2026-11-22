// SRV-1308 (M10.5; D-271 MQ02): one pass of the student data export job in
// the worker. For each approved export, oldest first: read the person's
// contents, build the deterministic package, store it, then make a one-time
// token of 32 random bytes, mark the export ready with its SHA-256 (the
// token itself is never stored) and hand the token to the delivery port. The
// package is stored before the export is ready, so a ready link always has a
// package; a crash in between leaves the export approved and the next pass
// writes the same bytes again. Then every ready link past its 24 hours
// expires (the expiry step returns a count only, so the package of an expired
// link is left for the storage sweep; the download removes its own).
//
// One export failing does not stop the others; the pass reports closed
// reasons only, never an id, a token or content.
import { createHash, randomBytes } from "node:crypto";

import {
  buildStudentDataExportPackage,
  type PackageContents,
  type StudentDataExportLabels,
} from "./package.ts";

/** Where the packages are kept, keyed by export id (the adapter is server/http/student-data-export/storage.ts). */
export type StudentDataExportStorage = {
  put(exportId: string, bytes: Uint8Array): Promise<void>;
};

export type StudentDataExportJobPort = {
  toPrepare(): Promise<
    | { status: "ok"; jobs: readonly { exportId: string; jobRef: string }[] }
    | { status: "unavailable" }
  >;
  contents(
    exportId: string,
  ): Promise<{ status: "ok"; contents: PackageContents } | { status: "unavailable" }>;
  markReady(
    exportId: string,
    tokenHash: Uint8Array,
  ): Promise<{ status: "ok"; expiresAt: string } | { status: "conflict" | "unavailable" }>;
  expire(): Promise<{ status: "ok"; expired: number } | { status: "unavailable" }>;
};

/** The link of a ready export: the token the person uses once, and when it expires. */
export type StudentDataExportLink = {
  readonly exportId: string;
  readonly token: string;
  readonly expiresAt: string;
};

export type StudentDataExportJobDeps = {
  readonly exports: StudentDataExportJobPort;
  readonly storage: StudentDataExportStorage;
  /** Hands the one-time link to the person; the token goes nowhere else. */
  readonly deliver: (link: StudentDataExportLink) => Promise<void>;
  /** The configured origin of the institution, for the QR of the receipt PDFs. */
  readonly origin: string;
  readonly labels: StudentDataExportLabels;
  /** For tests: the 32 bytes of a token. */
  readonly randomToken?: () => Uint8Array;
};

export type StudentDataExportFailure =
  | "list_unavailable"
  | "contents_unavailable"
  | "package_refused"
  | "storage_failed"
  | "mark_conflict"
  | "mark_unavailable"
  | "delivery_failed"
  | "expire_unavailable";

export type StudentDataExportPass = {
  readonly ready: number;
  readonly expired: number;
  readonly failures: readonly StudentDataExportFailure[];
};

/** The SHA-256 of a link token as the database keeps it (its UTF-8 bytes). */
export function studentDataExportTokenHash(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

export async function runStudentDataExportPass(
  deps: StudentDataExportJobDeps,
): Promise<StudentDataExportPass> {
  const failures: StudentDataExportFailure[] = [];
  let ready = 0;
  const list = await deps.exports.toPrepare();
  if (list.status !== "ok") {
    failures.push("list_unavailable");
  } else {
    for (const job of list.jobs) {
      const outcome = await prepare(deps, job.exportId);
      if (outcome === "ready") ready += 1;
      else failures.push(outcome);
    }
  }
  const expiry = await deps.exports.expire();
  if (expiry.status !== "ok") failures.push("expire_unavailable");
  return { ready, expired: expiry.status === "ok" ? expiry.expired : 0, failures };
}

async function prepare(
  deps: StudentDataExportJobDeps,
  exportId: string,
): Promise<"ready" | StudentDataExportFailure> {
  const read = await deps.exports.contents(exportId);
  if (read.status !== "ok") return "contents_unavailable";
  const built = await buildStudentDataExportPackage(read.contents, deps.origin, deps.labels);
  if (built.status !== "built") return "package_refused";
  try {
    await deps.storage.put(exportId, built.bytes);
  } catch {
    return "storage_failed";
  }
  const token = Buffer.from(deps.randomToken?.() ?? randomBytes(32)).toString("base64url");
  const marked = await deps.exports.markReady(exportId, studentDataExportTokenHash(token));
  if (marked.status === "conflict") return "mark_conflict";
  if (marked.status !== "ok") return "mark_unavailable";
  try {
    await deps.deliver({ exportId, token, expiresAt: marked.expiresAt });
  } catch {
    return "delivery_failed";
  }
  return "ready";
}
