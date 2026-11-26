// ISTR-9: the chain of saves one synthetic student sends during a load run.
// Built ahead of the run (priprema.ts), because k6 cannot run the JCS and the
// edit-step replayer; k6 then only sends these bodies in order.

import { createHash } from "node:crypto";

import {
  canonicalizeJcs,
  type EvidenceEventV2,
  type JcsJsonValue,
  REVISION_ZERO_NODE_ID,
  REVISION_ZERO_SHA256,
} from "../../server/domain/index.ts";
import { createEditStepsV1Replayer } from "../../server/external/storage/index.ts";

/** What `evidence/open` answers for a work that was just started. */
export type OpenedWork = {
  documentId: string;
  document: string;
  documentHash: string;
  evidenceProfileId: string;
};

/** One body of `evidence/commit`, exactly as the route takes it. */
export type CommitBody = {
  documentId: string;
  clientTransactionId: string;
  baseRevision: number;
  segments: string[];
  document: string;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/**
 * One commit per text: the first replaces the empty paragraph of revision
 * zero, every later one appends its text to the end of that paragraph. Each
 * segment names the hash of the one before it and continues its event
 * numbers and document hash, so the server accepts them only in this order.
 * `minute` is the observed minute of every segment (a whole-minute ISO time).
 */
export function buildCommitChain(
  work: OpenedWork,
  texts: readonly string[],
  minute: string,
  runId: string,
): CommitBody[] {
  const initial = Buffer.from(work.document, "base64").toString("utf8");
  if (sha256(initial) !== REVISION_ZERO_SHA256 || work.documentHash !== REVISION_ZERO_SHA256)
    throw new Error("The opened work is not at revision zero.");
  if (texts.length === 0) throw new Error("A chain needs at least one text.");
  const replayer = createEditStepsV1Replayer();
  let document = replayer.load(JSON.parse(initial) as JcsJsonValue);
  let documentHash = work.documentHash;
  let previousSegmentHash: string | null = null;
  // Position right after the paragraph's text: 1 inside the empty paragraph.
  let end = 1;
  return texts.map((text, index) => {
    const sequence = index + 1;
    const event: EvidenceEventV2 = {
      sequence,
      source: "editor",
      steps: [
        { stepType: "replace", from: end, to: end, slice: { content: [{ type: "text", text }] } },
      ],
      touchedNodeIds: [REVISION_ZERO_NODE_ID],
      beforeDocumentHash: documentHash,
      afterDocumentHash: "",
    };
    document = replayer.apply(document, event);
    const snapshot = canonicalizeJcs(replayer.toCanonical(document));
    event.afterDocumentHash = sha256(snapshot);
    end += text.length;
    const transaction = `load-${runId}-${work.documentId}-${sequence}`;
    const segment = canonicalizeJcs({
      evidenceSchema: "ductus-evidence-segment-v2",
      canonicalization: "RFC8785-JCS",
      hashAlgorithm: "sha256",
      documentId: work.documentId,
      evidenceProfileId: work.evidenceProfileId,
      sessionId: `load-${runId}-${work.documentId}`,
      segmentId: transaction,
      sequenceFrom: sequence,
      sequenceTo: sequence,
      observedStartedAt: minute,
      observedEndedAt: minute,
      initialDocumentHash: documentHash,
      finalDocumentHash: event.afterDocumentHash,
      predecessorSegmentHash: previousSegmentHash,
      captureContext: { editorModel: "prosemirror", transactionFormat: "ductus-edit-steps-v1" },
      events: [event] as unknown as JcsJsonValue,
    });
    documentHash = event.afterDocumentHash;
    previousSegmentHash = sha256(segment);
    return {
      documentId: work.documentId,
      clientTransactionId: transaction,
      baseRevision: index,
      segments: [base64(segment)],
      document: base64(snapshot),
    };
  });
}
