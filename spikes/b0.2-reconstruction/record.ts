// An invented evidence record for the B0.2 measurement: one paragraph that grows
// by the given texts, one segment per text. Copied from the reconstruction
// tests (server/evidence/reconstruction/record.fixture.ts), which the lint rule
// import-boundary does not allow to be imported from here. All texts are made up.
import {
  canonicalEvidenceSegmentV2,
  canonicalizeJcs,
  digestCanonicalDocumentV2,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  parseEditSteps,
  sha256WebCrypto,
  type EvidenceSegmentV2,
  type EvidenceStepReplayerV2,
  type JcsJsonValue,
} from "../../server/domain/index.ts";
import type {
  ReconstructionCheckpoint,
  VerifiedEvidenceSegment,
} from "../../server/evidence/reconstruction/index.ts";

const NODE = "odlomak-izmisljeni-1";
const TEXT_START = 1;

export type Doc = { nodes: { id: string; text: string }[] };
const paragraph = (text: string): Doc => ({ nodes: [{ id: NODE, text }] });
export const EMPTY: Doc = paragraph("");

/** Appends plain text to the one paragraph; any other step fails the replay. */
export const replayer: EvidenceStepReplayerV2<Doc> = {
  transactionFormat: EDIT_STEP_FORMAT_V1,
  load: (canonical) => {
    const document = structuredClone(canonical as unknown as Doc);
    if (
      !Array.isArray(document?.nodes) ||
      document.nodes.length !== 1 ||
      typeof document.nodes[0]?.text !== "string"
    )
      throw new Error("invalid document");
    return document;
  },
  apply: (document, event) => {
    const parsed = parseEditSteps(EDIT_STEP_FORMAT_V1, event.steps);
    if (!parsed.ok) throw new Error("unsupported step");
    return parsed.steps.reduce((current, step) => {
      const node = step.stepType === "replace" ? step.slice?.content[0] : undefined;
      const offset = step.stepType === "replace" ? step.from - TEXT_START : -1;
      if (node?.type !== "text" || offset !== current.nodes[0]!.text.length)
        throw new Error("unsupported step");
      return paragraph(current.nodes[0]!.text + node.text);
    }, document);
  },
  toCanonical: (document) => ({ nodes: document.nodes.map(({ id, text }) => ({ id, text })) }),
};

export const canonical = (document: Doc): JcsJsonValue => replayer.toCanonical(document);
export const canonicalText = (document: Doc): string => canonicalizeJcs(canonical(document));
const documentHash = async (document: Doc) =>
  (await digestCanonicalDocumentV2(canonical(document))).sha256;

export type InventedRecord = {
  segments: VerifiedEvidenceSegment[];
  /** `documents[r]` is the document at revision `r`; `documents[0]` the start. */
  documents: Doc[];
};

/** A verified record of one segment per text, chained from the empty paragraph. */
export async function buildRecord(texts: readonly string[]): Promise<InventedRecord> {
  const segments: VerifiedEvidenceSegment[] = [];
  const documents: Doc[] = [EMPTY];
  let predecessor: string | null = null;
  for (const [index, text] of texts.entries()) {
    const from = documents[index]!;
    const to = paragraph(from.nodes[0]!.text + text);
    const before = await documentHash(from);
    const after = await documentHash(to);
    const minute = String(index % 60).padStart(2, "0");
    const segment: EvidenceSegmentV2 = {
      evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
      canonicalization: EVIDENCE_CANONICALIZATION_V2,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
      documentId: "dokument-izmisljeni-1503",
      sessionId: "sesija-izmisljena-1503",
      segmentId: `odsjecak-${index + 1}`,
      sequenceFrom: index + 1,
      sequenceTo: index + 1,
      observedStartedAt: `2026-11-21T09:${minute}:00.000Z`,
      observedEndedAt: `2026-11-21T09:${minute}:00.000Z`,
      initialDocumentHash: before,
      finalDocumentHash: after,
      predecessorSegmentHash: predecessor,
      events: [
        {
          sequence: index + 1,
          source: "editor",
          steps: [
            {
              stepType: "replace",
              from: TEXT_START + from.nodes[0]!.text.length,
              to: TEXT_START + from.nodes[0]!.text.length,
              slice: { content: [{ type: "text", text }] },
            },
          ],
          touchedNodeIds: [NODE],
          beforeDocumentHash: before,
          afterDocumentHash: after,
        },
      ],
      captureContext: { editorModel: "prosemirror", transactionFormat: EDIT_STEP_FORMAT_V1 },
      evidenceProfileId: "standard-v1",
    };
    const segmentHash = await sha256WebCrypto(canonicalEvidenceSegmentV2(segment));
    segments.push({ segmentHash, segment });
    documents.push(to);
    predecessor = segmentHash;
  }
  return { segments, documents };
}

/** The checkpoint a correct store holds for revision `revision` of `record`. */
export async function checkpointOf(
  record: InventedRecord,
  revision: number,
): Promise<ReconstructionCheckpoint> {
  const body = canonicalText(record.documents[revision]!);
  return {
    revision,
    segmentHash: record.segments[revision - 1]!.segmentHash,
    contentHash: await sha256WebCrypto(body),
    body,
  };
}

/** Invented texts: `Izmisljena recenica n.` (the property test adds non-ASCII letters). */
export const inventedTexts = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `Izmisljena recenica ${at + 1}. `);
