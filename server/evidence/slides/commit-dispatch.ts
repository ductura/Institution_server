// SRV-V13-EVIDENCE-SLAJD: the branch of the commit preparation by the kind of
// the work (docs/contracts/slides-v1.md; WEB docs/nalazi/val13-razlika.md,
// task 5). A slides work is judged by the slides validator and the slide step
// format; a text work never reaches this code with a different outcome than
// before (server/evidence/service.ts keeps its own checks for it, untouched).
// Signature, chain and receipt are the same for both kinds: this only decides
// whether the received document is the right kind of document for the work.
import { SLIDE_STEP_FORMAT_V1, verifySlidesSnapshot } from "../../domain/index.ts";

/** The kind of a work, fixed at its start (revision 0). */
export type EvidenceWorkKind = "text" | "slides";

/**
 * The kind the commit context names. A context without `documentKind` is a
 * text work (every work before slides); any other value is no kind the server
 * knows, so the caller refuses the commit rather than guess.
 */
export function workKindOfContext(context: object): EvidenceWorkKind | null {
  const kind: unknown = "documentKind" in context ? context.documentKind : undefined;
  if (kind === undefined || kind === "text") return "text";
  return kind === "slides" ? "slides" : null;
}

export type SlidesCommitInput = {
  /** `captureContext.transactionFormat` of the verified segment. */
  transactionFormat: string;
  /** The document bytes as received (JCS of the document after the last event). */
  document: Uint8Array;
  /** `finalDocumentHash` of the verified segment. */
  finalDocumentHash: string;
};

export type SlidesCommitVerdict =
  | { status: "ok"; text: string; sha256: string }
  | { status: "invalid" | "too_large" | "document_mismatch" };

/**
 * Judges a commit to a slides work. A step format other than
 * `ductus-slide-steps-v1` (a text format on slides) and a document whose hash
 * is not the segment's final hash are `document_mismatch` (422); a document
 * the slides validator refuses is `invalid`, an oversized one `too_large`.
 */
export function verifySlidesCommit(input: SlidesCommitInput): SlidesCommitVerdict {
  if (input.transactionFormat !== SLIDE_STEP_FORMAT_V1) return { status: "document_mismatch" };
  const snapshot = verifySlidesSnapshot(input.document);
  if (!snapshot.ok) return { status: snapshot.reason };
  if (snapshot.sha256 !== input.finalDocumentHash) return { status: "document_mismatch" };
  return { status: "ok", text: snapshot.text, sha256: snapshot.sha256 };
}
