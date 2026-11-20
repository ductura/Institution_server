import { canonicalizeJcs } from "../forensics/index.ts";

import type { CanonicalDocument, VersionedDocument } from "./schema.ts";
import { validateDocument, validateVersionedDocument } from "./validate.ts";

/**
 * The cap of one document snapshot in UTF-8 bytes: 2 MiB, the same as the
 * live view (owner decision of 19 October 2026, issue 87 comment 6256655038;
 * BACKEND 4.10 t. 2 and 4.13 t. 2). The checkpoint column has the same bound.
 * It covers the whole document, v2 `sources` included (document v2 §1).
 */
export const MAX_DOCUMENT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type DocumentSnapshotVerification =
  | { ok: true; document: CanonicalDocument; text: string; sha256: string }
  | { ok: false; reason: "too_large" | "invalid" };

export type VersionedDocumentSnapshotVerification =
  | { ok: true; document: VersionedDocument; text: string; sha256: string }
  | { ok: false; reason: "too_large" | "invalid" };

/**
 * A snapshot is accepted only as the exact RFC 8785 JCS bytes of a valid
 * document (BACKEND 4.13 t. 3.4): strict UTF-8 with no byte order mark, a
 * document `validateDocument` accepts, and a canonical form identical to the
 * received text. The hash is the SHA-256 of the received bytes themselves.
 * Only v1: its readers (the live view, the teacher's fast path) do not show
 * a v2 citation yet (document v2 §9.1).
 */
export async function verifyDocumentSnapshot(
  bytes: Uint8Array,
): Promise<DocumentSnapshotVerification> {
  return verify(bytes, validateDocument) as Promise<DocumentSnapshotVerification>;
}

/**
 * The same check for a document of any accepted version (SRV-33): v1 by the
 * rules of v1, v2 with its sources and citations (`validateVersionedDocument`).
 * Unknown fields are still refused (B-8), and the JCS form and the hash are
 * the same as for v1. Which version a work may take is not decided here: the
 * database keeps every revision at the version of its revision 0 (document v2
 * §7 t. 4).
 */
export async function verifyVersionedDocumentSnapshot(
  bytes: Uint8Array,
): Promise<VersionedDocumentSnapshotVerification> {
  return verify(bytes, validateVersionedDocument);
}

async function verify(
  bytes: Uint8Array,
  validate: (
    doc: unknown,
  ) => { ok: true; doc: VersionedDocument } | { ok: false; errors: readonly unknown[] },
): Promise<VersionedDocumentSnapshotVerification> {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "invalid" };
  if (bytes.byteLength > MAX_DOCUMENT_SNAPSHOT_BYTES) return { ok: false, reason: "too_large" };
  // Copied once, so the bytes that are checked are the bytes that are hashed.
  const received = new Uint8Array(bytes);
  let text: string;
  let parsed: unknown;
  try {
    // ignoreBOM keeps a mark as a character, which then fails the JCS check.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(received);
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const valid = validate(parsed);
  if (!valid.ok) return { ok: false, reason: "invalid" };
  let canonical: string;
  try {
    canonical = canonicalizeJcs(parsed);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (canonical !== text) return { ok: false, reason: "invalid" };
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", received));
  return {
    ok: true,
    document: valid.doc,
    text,
    sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
