// F4-EDI-R05-SRV: "keep the text from this device" over the existing commit.
// Device B moved the work to revision N; device A's commit got stale_base or
// chain_conflict with the head state. Device A resolves it with a new segment
// that starts at that head: predecessor = headSegmentHash, sequenceFrom =
// lastSequenceTo + 1, initialDocumentHash = documentHash, base = N, and events
// with the attribution `unattributed` that turn the server's text into its own.
// These cases hold the service's checks of such a segment before storage; the
// database half is tests/db/evidence-commit-resolution.integration.test.ts.
// The segment and document are the invented golden chain.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  type ActorTransaction,
  createEvidenceCommitter,
  type ReceiptSigner,
  type WithActor,
} from "../database/index.ts";
import { canonicalizeJcs } from "../domain/index.ts";

import { createEvidenceService, type EvidenceCommitRequest } from "./service.ts";

type GoldenEvent = Record<string, unknown> & {
  sequence: number;
  beforeDocumentHash: string;
  afterDocumentHash: string;
};
type GoldenSegment = Record<string, unknown> & {
  documentId: string;
  evidenceProfileId: string;
  initialDocumentHash: string;
  finalDocumentHash: string;
  predecessorSegmentHash: string | null;
  sequenceFrom: number;
  sequenceTo: number;
  events: GoldenEvent[];
};
const { chain } = JSON.parse(
  readFileSync(
    new URL("../domain/forensics/golden-vectors/evidence-v2.json", import.meta.url),
    "latin1",
  ),
) as {
  chain: {
    segments: { segment: GoldenSegment; segmentHash: string }[];
    documentStates: { afterSequence: number; value: unknown }[];
  };
};
// Device B's work is the head: the first golden segment, sequences 1 and 2.
const head = chain.segments[0]!;
// Device A's text arrives as the second golden segment, every event unattributed.
const second = chain.segments[1]!.segment;
const NODE = "8b3e2d71-6c4f-4a90-b5d2-e17f0a9c3b46";
const documentAfter = (sequence: number) =>
  new TextEncoder().encode(
    canonicalizeJcs(chain.documentStates.find((s) => s.afterSequence === sequence)?.value),
  );
const DOCUMENT = documentAfter(second.sequenceTo);
const INSTITUTION = "00000000-0000-4000-8000-0000000000a1";
const V1_ZERO = "a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b";
const N = 7;
/** The head state device A got with its refusal: revision N after device B's segment. */
const CONTEXT_ROW = {
  outcome: "ok",
  evidencePackageId: "paket-razrjesenje-1",
  institutionId: INSTITUTION,
  evidenceDomainId: "00000000-0000-4000-8000-0000000000d1",
  evidenceProfileId: head.segment.evidenceProfileId,
  maxPayloadBytes: 262144,
  transactionKnown: false,
  currentRevision: String(N),
  documentHash: head.segment.finalDocumentHash,
  headSegmentHash: head.segmentHash,
  lastSequenceTo: String(head.segment.sequenceTo),
};
const STATE = {
  currentRevision: N,
  documentHash: head.segment.finalDocumentHash,
  headSegmentHash: head.segmentHash,
  lastSequenceTo: head.segment.sequenceTo,
};
// The acceptance answers a stale base, so no case reaches a signature.
const STALE = {
  outcome: "stale_base",
  currentRevision: String(N + 1),
  documentHash: "e".repeat(64),
  headSegmentHash: null,
  lastSequenceTo: "9",
};
const refusingSigner: ReceiptSigner = { sign: () => Promise.reject(new Error("never")) };

const snake = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`),
      value,
    ]),
  );

/**
 * The resolving segment: device A's events, renumbered from `from`, the first
 * one starting at `initial`, all with the attribution `unattributed`.
 */
function resolution(
  change: { from?: number; initial?: string; predecessor?: string | null } = {},
): Uint8Array {
  const from = change.from ?? STATE.lastSequenceTo + 1;
  const initial = change.initial ?? STATE.documentHash;
  const events = second.events.map((event, index) => ({
    ...event,
    sequence: from + index,
    source: "unattributed",
    touchedNodeIds: [NODE],
    ...(index === 0 ? { beforeDocumentHash: initial } : {}),
  }));
  return new TextEncoder().encode(
    canonicalizeJcs({
      ...second,
      sequenceFrom: from,
      sequenceTo: from + events.length - 1,
      initialDocumentHash: initial,
      predecessorSegmentHash:
        change.predecessor === undefined ? STATE.headSegmentHash : change.predecessor,
      events,
    }),
  );
}

function setup(contextRow: Record<string, unknown> = CONTEXT_ROW) {
  const queries: { kind: string; values: readonly unknown[] }[] = [];
  const withActor: WithActor = async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values = []) {
        const kind = text.includes("evidence_commit_context")
          ? "context"
          : text.includes("evidence.document_revision")
            ? "revision0"
            : text.includes("document_kind")
              ? "kind"
              : "commit";
        if (kind === "context" || kind === "commit") queries.push({ kind, values });
        const row =
          kind === "context"
            ? snake(contextRow)
            : kind === "revision0"
              ? { content_hash: V1_ZERO }
              : kind === "kind"
                ? snake({ documentKind: "text" })
                : snake(STALE);
        return { rows: [row] as never[], rowCount: 1 };
      },
    };
    return fn(tx);
  };
  const payloads = {
    putImmutable: vi.fn(async () => ({ status: "stored" as const, storageRef: "memory:put-ref" })),
    storageRefFor: vi.fn(async () => ({ status: "ok" as const, storageRef: "memory:known-ref" })),
  };
  const committer = createEvidenceCommitter(withActor, refusingSigner);
  const run = (request: Partial<EvidenceCommitRequest> = {}) =>
    createEvidenceService({ committer, payloads }).commit("t", {
      documentId: head.segment.documentId,
      clientTransactionId: "tx-razrjesenje-1",
      baseRevision: N,
      segment: resolution(),
      document: DOCUMENT,
      ...request,
    });
  return { run, queries, payloads };
}

describe("a resolving segment from the head state", () => {
  it("is committed as revision N + 1 on base N, continuing the head", async () => {
    const { run, queries, payloads } = setup();
    const segment = resolution();
    await run({ segment });
    const segmentHash = createHash("sha256").update(segment).digest("hex");
    expect(payloads.putImmutable).toHaveBeenCalledExactlyOnceWith({
      institutionId: INSTITUTION,
      evidencePackageId: "paket-razrjesenje-1",
      segmentHash,
      canonicalPayload: new TextDecoder().decode(segment),
    });
    const commit = queries.find((q) => q.kind === "commit");
    expect(commit?.values.slice(0, 5)).toEqual([
      "paket-razrjesenje-1",
      "tx-razrjesenje-1",
      N,
      STATE.documentHash,
      second.finalDocumentHash,
    ]);
    expect(JSON.parse(String(commit?.values[5]))).toMatchObject({
      predecessorSegmentHash: STATE.headSegmentHash,
      sequenceFrom: STATE.lastSequenceTo + 1,
      sequenceTo: STATE.lastSequenceTo + second.events.length,
      segmentHash,
    });
    expect(commit?.values[8]).toBe(new TextDecoder().decode(DOCUMENT));
    expect(commit?.values[9]).toBeNull();
  });

  it.each<[string, Partial<EvidenceCommitRequest>, unknown]>([
    ["on base N - 1", { baseRevision: N - 1 }, { status: "stale_base", state: STATE }],
    ["on a base from the future", { baseRevision: N + 1 }, { status: "stale_base", state: STATE }],
    [
      "on base N after a segment that is no longer the head",
      { segment: resolution({ predecessor: "f".repeat(64) }) },
      { status: "chain_conflict", state: STATE },
    ],
    [
      "on base N with no predecessor, as before device B's work",
      { segment: resolution({ predecessor: null }) },
      { status: "chain_conflict", state: STATE },
    ],
    [
      "from another document state",
      { segment: resolution({ initial: "c".repeat(64) }) },
      { status: "not_continuous", state: STATE },
    ],
    [
      "with a sequence that does not move past the head",
      { segment: resolution({ from: STATE.lastSequenceTo }) },
      { status: "invalid" },
    ],
    [
      "with a sequence that skips one",
      { segment: resolution({ from: STATE.lastSequenceTo + 2 }) },
      { status: "not_continuous", state: STATE },
    ],
    [
      "with a snapshot that is not its final document",
      { document: documentAfter(second.sequenceTo - 1) },
      { status: "document_mismatch" },
    ],
  ])("is refused %s, without storing or committing", async (_, request, expected) => {
    const { run, queries, payloads } = setup();
    expect(await run(request)).toEqual(expected);
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
  });

  it("over the package's payload limit is too_large, without storing or committing", async () => {
    const bytes = resolution().byteLength;
    const { run, queries, payloads } = setup({ ...CONTEXT_ROW, maxPayloadBytes: bytes - 1 });
    expect(await run()).toEqual({ status: "too_large" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
  });
});
