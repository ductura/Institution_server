// Red-team: what POST /api/v1/evidence/commit lets a hostile client get into
// the evidence record (branch redteam/integritet-evidencije, Ductura P-2 work,
// 21. 11. 2026). The client is the student's own browser, so every value it
// sends may be forged. Each case is one attack on createEvidenceService over
// the real committer and the real domain checks; the database answers a stale
// base, so "accepted" here means "passed every check of the server and reached
// the acceptance transaction". Tests marked KNOWN LIMIT pass today because the
// attack gets through: they pin the limit so a fix shows up as a failing test
// that is then turned around. Every text is the invented golden chain.
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
  source: string;
  steps: Record<string, unknown>[];
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
    segments: { canonicalUtf8Hex: string; segment: GoldenSegment; segmentHash: string }[];
    documentStates: { afterSequence: number; value: unknown }[];
  };
};
// Segment 1: event 1 `editor`, event 2 `paste`.
const golden = chain.segments[0]!;
const final = chain.documentStates.find((s) => s.afterSequence === golden.segment.sequenceTo);
const DOCUMENT = new TextEncoder().encode(canonicalizeJcs(final?.value));

/** The chain right before segment 1, as the database would report it. */
const BEFORE = {
  currentRevision: "3",
  documentHash: golden.segment.initialDocumentHash,
  headSegmentHash: golden.segment.predecessorSegmentHash,
  lastSequenceTo: String(golden.segment.sequenceFrom - 1),
};
/** The chain right after segment 1 was accepted. */
const AFTER = {
  currentRevision: "4",
  documentHash: golden.segment.finalDocumentHash,
  headSegmentHash: golden.segmentHash,
  lastSequenceTo: String(golden.segment.sequenceTo),
};
const contextRow = (state: Record<string, string | null>) => ({
  outcome: "ok",
  evidencePackageId: "paket-iz-baze-1",
  institutionId: "00000000-0000-4000-8000-0000000000a1",
  evidenceDomainId: "00000000-0000-4000-8000-0000000000d1",
  evidenceProfileId: golden.segment.evidenceProfileId,
  maxPayloadBytes: 262144,
  transactionKnown: false,
  ...state,
});
const STALE = {
  outcome: "stale_base",
  currentRevision: "9",
  documentHash: "e".repeat(64),
  headSegmentHash: null,
  lastSequenceTo: "9",
};
const refusingSigner: ReceiptSigner = { sign: () => Promise.reject(new Error("never")) };
const snake = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`), v]),
  );

function attack(
  segment: Record<string, unknown>,
  options: { state?: typeof BEFORE; baseRevision?: number } = {},
) {
  const state = options.state ?? BEFORE;
  const kinds: string[] = [];
  const withActor: WithActor = async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text) {
        const kind = text.includes("evidence_commit_context") ? "context" : "commit";
        kinds.push(kind);
        return {
          rows: [snake(kind === "context" ? contextRow(state) : STALE)] as never[],
          rowCount: 1,
        };
      },
    };
    return fn(tx);
  };
  const payloads = {
    putImmutable: vi.fn(async () => ({ status: "stored" as const, storageRef: "memory:put" })),
    storageRefFor: vi.fn(async () => ({ status: "ok" as const, storageRef: "memory:known" })),
  };
  const request: EvidenceCommitRequest = {
    documentId: golden.segment.documentId,
    clientTransactionId: "tx-napad-1",
    baseRevision: options.baseRevision ?? Number(state.currentRevision),
    segment: new TextEncoder().encode(canonicalizeJcs(segment)),
    document: DOCUMENT,
  };
  return createEvidenceService({
    committer: createEvidenceCommitter(withActor, refusingSigner),
    payloads,
  })
    .commit("t", request)
    .then((outcome) => ({
      outcome,
      reachedAcceptance: kinds.includes("commit"),
      stored: payloads.putImmutable.mock.calls.length > 0,
    }));
}

const withEvents = (events: GoldenEvent[], extra: Record<string, unknown> = {}) => ({
  ...golden.segment,
  ...extra,
  events,
});
const events = () => structuredClone(golden.segment.events);

describe("red-team: the untouched segment (control)", () => {
  it("reaches the acceptance", async () => {
    const r = await attack(golden.segment);
    expect(r.reachedAcceptance).toBe(true);
  });
});

describe("red-team: tampering the server refuses", () => {
  it.each<[string, () => Record<string, unknown>]>([
    ["events reordered", () => withEvents(events().reverse())],
    [
      "an event dropped (gap in the sequence)",
      () => withEvents([events()[1]!], { sequenceTo: golden.segment.sequenceFrom }),
    ],
    [
      "an event's document hash forged",
      () => {
        const e = events();
        e[0]!.afterDocumentHash = "a".repeat(64);
        return withEvents(e);
      },
    ],
    [
      "a segment of another document",
      () => ({ ...golden.segment, documentId: "drugi-dokument-izmisljen" }),
    ],
    [
      "a segment under another evidence profile",
      () => ({ ...golden.segment, evidenceProfileId: `${golden.segment.evidenceProfileId}-x` }),
    ],
    [
      "a source outside the closed set (`teacher`)",
      () => {
        const e = events();
        e[1]!.source = "teacher";
        return withEvents(e);
      },
    ],
    [
      "a reserved source (`applied-suggestion`)",
      () => {
        const e = events();
        e[1]!.source = "applied-suggestion";
        return withEvents(e);
      },
    ],
    [
      "`citation-form` under a v2 header",
      () => {
        const e = events();
        e[1]!.source = "citation-form";
        return withEvents(e);
      },
    ],
    [
      "`ai-transfer` with an invented record (v4 still closed)",
      () => {
        const e = events();
        Object.assign(e[1]!, {
          source: "ai-transfer",
          aiTransferId: "00000000-0000-4000-8000-0000000000c9",
          aiTransferSha256: "c".repeat(64),
        });
        return withEvents(e, { evidenceSchema: "ductus-evidence-segment-v4" });
      },
    ],
    [
      "an extra field (a client-side flag the server never asked for)",
      () => ({ ...golden.segment, reviewFlags: [] }),
    ],
  ])("%s: nothing stored, no acceptance", async (_name, build) => {
    const r = await attack(build());
    expect(r.reachedAcceptance).toBe(false);
    expect(r.stored).toBe(false);
  });

  it("replays an accepted segment as a new transaction: refused before storage", async () => {
    const r = await attack(golden.segment, { state: AFTER });
    expect(r.outcome.status).not.toBe("stale_base");
    expect(["chain_conflict", "invalid", "not_continuous"]).toContain(r.outcome.status);
    expect(r.stored).toBe(false);
  });

  it("commits on an old base revision: refused before storage", async () => {
    const r = await attack(golden.segment, { baseRevision: 2 });
    expect(r.outcome.status).toBe("stale_base");
    expect(r.reachedAcceptance).toBe(false);
    expect(r.stored).toBe(false);
  });
});

describe("red-team: KNOWN LIMIT, the server cannot observe attribution", () => {
  // The segment's sources are the client's claim (evidence-segment-v2.ts: "The
  // server cannot observe attribution"). A paste relabelled as typing passes.
  it("a paste relabelled as `editor` is accepted", async () => {
    const e = events();
    expect(e[1]!.source).toBe("paste");
    e[1]!.source = "editor";
    const r = await attack(withEvents(e));
    expect(r.reachedAcceptance).toBe(true);
  });

  it("a paste relabelled as `citation-form` under v3 is accepted", async () => {
    const e = events();
    e[1]!.source = "citation-form";
    const r = await attack(withEvents(e, { evidenceSchema: "ductus-evidence-segment-v3" }));
    expect(r.reachedAcceptance).toBe(true);
  });
});

describe("red-team: KNOWN LIMIT, steps are not bound to the document hashes", () => {
  // The server checks that the event hashes chain and that the snapshot is the
  // final hash, but it does not run the steps (B-12 on the server is DAN-819).
  // So a segment whose steps do not produce its hashes is stored and receipted.
  // The client replay (editor-core evidence-replay-v2.ts) applies the steps and
  // compares every afterDocumentHash, so the teacher's replay shows the break,
  // but only when someone replays it. A client that computes the real hash of
  // each invented intermediate state passes the replay too: that is the
  // attribution limit above, not a hash gap.
  it("a step's text rewritten, hashes kept, is accepted", async () => {
    const e = events();
    const slice = e[0]!.steps[0]!.slice as { content: { text: string }[] };
    slice.content[0]!.text = "Posve drukčiji izmišljeni tekst. ";
    const r = await attack(withEvents(e));
    expect(r.reachedAcceptance).toBe(true);
  });

  it("one event duplicated into two `editor` events with an invented middle hash is accepted", async () => {
    // Splitting needs a hash for each intermediate document. The server never
    // computes them, so any invented middle hash that chains passes: a burst
    // of typing can be fabricated after the fact.
    const e = events();
    const first = e[0]!;
    const middle = "b".repeat(64);
    const a = { ...structuredClone(first), afterDocumentHash: middle };
    const b = {
      ...structuredClone(first),
      sequence: first.sequence + 1,
      beforeDocumentHash: middle,
    };
    const rest = e.slice(1).map((x) => ({ ...x, sequence: x.sequence + 1 }));
    const r = await attack(
      withEvents([a, b, ...rest], { sequenceTo: golden.segment.sequenceTo + 1 }),
    );
    expect(r.reachedAcceptance).toBe(true);
  });
});
