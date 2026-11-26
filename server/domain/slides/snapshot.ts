import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../forensics/index.ts";

import {
  MAX_SLIDES_SNAPSHOT_BYTES,
  type SlidesDocument,
  validateSlidesDocument,
} from "./model/index.ts";

export type SlidesSnapshotVerification =
  | { ok: true; document: SlidesDocument; text: string; sha256: string }
  | { ok: false; reason: "too_large" | "invalid" };

/** The JCS (RFC 8785) text of a slides document. */
export function slidesSnapshotText(doc: SlidesDocument): string {
  return canonicalizeJcs(doc);
}

/** SHA-256 (lowercase hex) of the UTF-8 bytes of the JCS text. */
export function slidesSnapshotSha256(doc: SlidesDocument): string {
  return createHash("sha256").update(slidesSnapshotText(doc), "utf8").digest("hex");
}

/**
 * A snapshot is accepted only as the exact JCS bytes of a valid slides
 * document: strict UTF-8 with no byte order mark, a document the validator
 * accepts, and a canonical form identical to the received text. The hash is
 * that of the received bytes. Same rules as the text snapshot.
 */
export function verifySlidesSnapshot(bytes: Uint8Array): SlidesSnapshotVerification {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "invalid" };
  if (bytes.byteLength > MAX_SLIDES_SNAPSHOT_BYTES) return { ok: false, reason: "too_large" };
  const received = new Uint8Array(bytes);
  let text: string;
  let parsed: unknown;
  try {
    // Strict UTF-8: invalid bytes decode to U+FFFD and would not encode back to the same bytes.
    const buffer = Buffer.from(received);
    text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) return { ok: false, reason: "invalid" };
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const valid = validateSlidesDocument(parsed);
  if (!valid.ok) return { ok: false, reason: "invalid" };
  let canonical: string;
  try {
    canonical = canonicalizeJcs(valid.doc);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (canonical !== text) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    document: valid.doc,
    text,
    sha256: createHash("sha256").update(received).digest("hex"),
  };
}

/**
 * Equality of two slides documents: same canonical bytes, so same slides in
 * the same order with the same ids, layouts, blocks and notes. Ids are
 * identity: the same text in differently identified blocks is another document.
 */
export function slidesDocumentsEqual(a: SlidesDocument, b: SlidesDocument): boolean {
  return slidesSnapshotText(a) === slidesSnapshotText(b);
}
