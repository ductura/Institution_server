// DAN-815 b2, plan of attack ductura/server#119 parts B3, C6 to C8, D2 and E5.
// Port of Ductus src/server/evidence/evidence-commit-request.test.ts at
// d52a92c3 over createEvidenceService and the real committer of part a2; the
// signer is never reached (the acceptance answers a stale base). The segment
// and document are the invented golden chain.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  type ActorTransaction,
  createEvidenceCommitter,
  type ReceiptSigner,
  type WithActor,
} from "../database/index.ts";
import {
  canonicalizeJcs,
  isEvidenceSegment,
  MAX_DOCUMENT_SNAPSHOT_BYTES,
  MAX_EVIDENCE_SEGMENT_BYTES,
  parseEditSteps,
  REVISION_ZERO_V4_SHA256,
  verifyVersionedDocumentSnapshot,
} from "../domain/index.ts";

import { createEvidenceService, type EvidenceCommitRequest } from "./service.ts";

// The invented first segment of the golden chain and the document it ends in.
// The domain's golden vectors, read as bytes: another area may import only
// server/domain/index.ts, and the loader is not part of it.
type GoldenSegment = {
  documentId: string;
  evidenceProfileId: string;
  initialDocumentHash: string;
  finalDocumentHash: string;
  predecessorSegmentHash: string | null;
  sequenceFrom: number;
  sequenceTo: number;
  events: Record<string, unknown>[];
};
const { chain } = JSON.parse(
  readFileSync(
    new URL("../domain/forensics/golden-vectors/evidence-v2.json", import.meta.url),
    "latin1",
  ),
) as {
  chain: {
    segments: {
      canonicalUtf8Hex: string;
      segment: GoldenSegment;
      descriptor: Record<string, unknown>;
      segmentHash: string;
    }[];
    documentStates: { afterSequence: number; value: unknown }[];
  };
};
const golden = chain.segments[0]!;
const SEGMENT = Buffer.from(golden.canonicalUtf8Hex, "hex");
const final = chain.documentStates.find(
  (state) => state.afterSequence === golden.segment.sequenceTo,
);
const DOCUMENT = new TextEncoder().encode(canonicalizeJcs(final?.value));
const INSTITUTION = "00000000-0000-4000-8000-0000000000a1";
// SRV-7F: the revision 0 hashes as contracts v1, v2 and v3 write them.
const V1_ZERO = "a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b";
const V2_ZERO = "8f8aa5047daa07e8d68f4952aa70ab3c671eccdf6191bfaf6dcba591735f2618";
const V3_ZERO = "b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141";
/** A context row as the database names it; written in camelCase, sent in snake_case. */
const CONTEXT_ROW = {
  outcome: "ok",
  evidencePackageId: "paket-iz-baze-1",
  institutionId: INSTITUTION,
  evidenceDomainId: "00000000-0000-4000-8000-0000000000d1",
  evidenceProfileId: golden.segment.evidenceProfileId,
  maxPayloadBytes: 262144,
  transactionKnown: false,
  // The chain the golden segment continues: base revision 3 of REQUEST.
  currentRevision: "3",
  documentHash: golden.segment.initialDocumentHash,
  headSegmentHash: golden.segment.predecessorSegmentHash,
  lastSequenceTo: String(golden.segment.sequenceFrom - 1),
};
// The acceptance answers a stale base, so these tests stop before any signature.
const STALE = {
  outcome: "stale_base",
  currentRevision: "4",
  documentHash: "e".repeat(64),
  headSegmentHash: null,
  lastSequenceTo: "8",
};
const REQUEST: EvidenceCommitRequest = {
  documentId: golden.segment.documentId,
  clientTransactionId: "tx-izmisljeni-1",
  baseRevision: 3,
  segment: SEGMENT,
  document: DOCUMENT,
};
const refusingSigner: ReceiptSigner = {
  sign: () => Promise.reject(new Error("never")),
};

/** The row with the column names of the database (only server/database writes them). */
const snake = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`),
      value,
    ]),
  );

/**
 * `workVersion` stands in for the version the database lane will read from a
 * v4 revision 0 (SRV-10E): until it reads one, a v4 work is context_malformed.
 */
function setup(
  contextRow: Record<string, unknown> = CONTEXT_ROW,
  revisionZero = V1_ZERO,
  workVersion?: number,
) {
  const queries: { kind: string; values: readonly unknown[] }[] = [];
  const zeroReads: { kind: string; values: readonly unknown[] }[] = [];
  const kindReads: { kind: string; values: readonly unknown[] }[] = [];
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
        // The reads of revision 0 and of the work's kind (SRV-V14-SHEET-COMMIT)
        // are kept apart, so `queries` stays context and commit.
        (kind === "revision0" ? zeroReads : kind === "kind" ? kindReads : queries).push({
          kind,
          values,
        });
        const row =
          kind === "context"
            ? snake(contextRow)
            : kind === "revision0"
              ? { content_hash: revisionZero }
              : kind === "kind"
                ? snake({ documentKind: "text" })
                : snake(STALE);
        const rows = [row] as never[];
        return { rows, rowCount: 1 };
      },
    };
    return fn(tx);
  };
  const payloads = {
    putImmutable: vi.fn(async () => ({ status: "stored" as const, storageRef: "memory:put-ref" })),
    storageRefFor: vi.fn(async () => ({ status: "ok" as const, storageRef: "memory:known-ref" })),
  };
  const real = createEvidenceCommitter(withActor, refusingSigner);
  const committer: typeof real =
    workVersion === undefined
      ? real
      : {
          ...real,
          async readContext(...args) {
            const read = await real.readContext(...args);
            if (read.status !== "ok") return read;
            const documentSchemaVersion = workVersion as typeof read.context.documentSchemaVersion;
            return { ...read, context: { ...read.context, documentSchemaVersion } };
          },
        };
  const run = (request: Partial<EvidenceCommitRequest> = {}) =>
    createEvidenceService({ committer, payloads }).commit("t", { ...REQUEST, ...request });
  return { run, queries, payloads, zeroReads };
}

const segmentWith = (change: Record<string, unknown>) =>
  new TextEncoder().encode(canonicalizeJcs({ ...golden.segment, ...change }));

describe("createEvidenceService().commit", () => {
  it("builds the descriptor from the received bytes and the package from the context, then commits", async () => {
    const { run, queries, payloads } = setup();
    expect(await run()).toEqual({
      status: "stale_base",
      state: {
        currentRevision: 4,
        documentHash: "e".repeat(64),
        headSegmentHash: null,
        lastSequenceTo: 8,
      },
    });
    expect(payloads.putImmutable).toHaveBeenCalledExactlyOnceWith({
      institutionId: INSTITUTION,
      evidencePackageId: "paket-iz-baze-1",
      segmentHash: golden.segmentHash,
      canonicalPayload: SEGMENT.toString("utf8"),
    });
    expect(payloads.storageRefFor).not.toHaveBeenCalled();
    const commit = queries.find((q) => q.kind === "commit");
    expect(commit?.values).toEqual([
      "paket-iz-baze-1",
      "tx-izmisljeni-1",
      3,
      golden.segment.initialDocumentHash,
      golden.segment.finalDocumentHash,
      JSON.stringify({ ...golden.descriptor, evidencePackageId: "paket-iz-baze-1" }),
      golden.segmentHash,
      "memory:put-ref",
      new TextDecoder().decode(DOCUMENT),
      null,
      // F4-EDI-R05-SRV (B1): no resolution yet.
      null,
    ]);
  });

  it("writes nothing for a known idempotency key and names the object it stored before", async () => {
    const { run, queries, payloads } = setup({ ...CONTEXT_ROW, transactionKnown: true });
    await run();
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(payloads.storageRefFor).toHaveBeenCalledExactlyOnceWith({
      institutionId: INSTITUTION,
      evidencePackageId: "paket-iz-baze-1",
      segmentHash: golden.segmentHash,
    });
    expect(queries.find((q) => q.kind === "commit")?.values[7]).toBe("memory:known-ref");
  });

  // F-099: for a new key, what the acceptance would refuse is refused before storage.
  const read = (row: Record<string, unknown>) => ({
    currentRevision: Number(row.currentRevision),
    documentHash: row.documentHash,
    headSegmentHash: row.headSegmentHash,
    lastSequenceTo: Number(row.lastSequenceTo),
  });
  it.each<[string, Record<string, unknown>, (row: Record<string, unknown>) => unknown]>([
    [
      "a stale base",
      { currentRevision: "4" },
      (row) => ({ status: "stale_base", state: read(row) }),
    ],
    [
      "another head segment",
      { headSegmentHash: "a".repeat(64) },
      (row) => ({ status: "chain_conflict", state: read(row) }),
    ],
    [
      "a sequence that goes back",
      { lastSequenceTo: String(golden.segment.sequenceFrom) },
      () => ({ status: "invalid" }),
    ],
    [
      "another document state",
      { documentHash: "c".repeat(64) },
      (row) => ({ status: "not_continuous", state: read(row) }),
    ],
  ])(
    "refuses %s from the context's state without storing or committing",
    async (_, change, expected) => {
      const row = { ...CONTEXT_ROW, ...change };
      const { run, queries, payloads } = setup(row);
      expect(await run()).toEqual(expected(row));
      expect(payloads.putImmutable).not.toHaveBeenCalled();
      expect(queries.map((q) => q.kind)).toEqual(["context"]);
    },
  );

  it("answers not_accepting from the context without storing or committing", async () => {
    const { run, queries, payloads } = setup({ outcome: "not_accepting" });
    expect(await run()).toEqual({ status: "not_accepting" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
  });

  it("lets a known key past a changed chain to its receipt: the acceptance decides, nothing is stored", async () => {
    const { run, queries, payloads } = setup({
      ...CONTEXT_ROW,
      transactionKnown: true,
      currentRevision: "9",
    });
    await run();
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).toEqual(["context", "commit"]);
  });

  it.each([
    ["no revision", { currentRevision: null }],
    ["a revision as a fraction", { currentRevision: "1.5" }],
    ["a document hash in capitals", { documentHash: "E".repeat(64) }],
    ["a head that is no hash", { headSegmentHash: "x" }],
    ["no sequence", { lastSequenceTo: undefined }],
  ])("is unavailable when the context's state has %s", async (_, change) => {
    const { run, payloads } = setup({ ...CONTEXT_ROW, ...change });
    expect(await run()).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
  });

  it.each([
    ["a transaction id with a control character", { clientTransactionId: "tx\n1" }],
    ["an empty transaction id", { clientTransactionId: "" }],
    ["a base revision that is not whole (qa467a)", { baseRevision: 0.5 }],
    ["a negative base revision", { baseRevision: -1 }],
    ["a base revision with no next revision", { baseRevision: Number.MAX_SAFE_INTEGER }],
    ["a segment that is no byte array", { segment: "{}" as unknown as Uint8Array }],
    ["a document id that is no text", { documentId: 7 as unknown as string }],
  ])("refuses %s as invalid before reading any state", async (_, change) => {
    const { run, queries } = setup();
    expect(await run(change)).toEqual({ status: "invalid" });
    expect(queries).toEqual([]);
  });

  it.each([
    ["a segment over D-96", { segment: new Uint8Array(MAX_EVIDENCE_SEGMENT_BYTES + 1) }],
    ["a snapshot over 2 MiB", { document: new Uint8Array(MAX_DOCUMENT_SNAPSHOT_BYTES + 1) }],
  ])("refuses %s as too large before reading any state", async (_, change) => {
    const { run, queries } = setup();
    expect(await run(change)).toEqual({ status: "too_large" });
    expect(queries).toEqual([]);
  });

  it.each(["unauthenticated", "not_found", "invalid"])(
    "answers context %s and does nothing else",
    async (outcome) => {
      const { run, queries, payloads } = setup({ outcome });
      expect(await run({ segment: new TextEncoder().encode("no segment") })).toEqual({
        status: outcome,
      });
      expect(queries.map((q) => q.kind)).toEqual(["context"]);
      expect(payloads.putImmutable).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a segment that is not JCS",
      { segment: new TextEncoder().encode(` ${SEGMENT.toString("utf8")}`) },
      "invalid",
    ],
    [
      "a segment with a byte order mark",
      { segment: new Uint8Array([0xef, 0xbb, 0xbf, ...SEGMENT]) },
      "invalid",
    ],
    [
      "a segment of another document",
      { segment: segmentWith({ documentId: "dokument-drugi" }) },
      "invalid",
    ],
    [
      "a segment of another profile",
      { segment: segmentWith({ evidenceProfileId: "drugi-profil" }) },
      "invalid",
    ],
    [
      "a snapshot that is not JCS",
      { document: new TextEncoder().encode(` ${new TextDecoder().decode(DOCUMENT)}`) },
      "invalid",
    ],
    [
      "a snapshot of another document",
      { document: new TextEncoder().encode(canonicalizeJcs(chain.documentStates[0]!.value)) },
      "document_mismatch",
    ],
  ])("refuses %s and stores nothing", async (_, change, status) => {
    const { run, queries, payloads } = setup();
    expect(await run(change)).toEqual({ status });
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
    expect(payloads.putImmutable).not.toHaveBeenCalled();
  });

  it("refuses a segment over the package's own limit as too large", async () => {
    const { run, payloads } = setup({ ...CONTEXT_ROW, maxPayloadBytes: SEGMENT.byteLength - 1 });
    expect(await run()).toEqual({ status: "too_large" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unavailable",
      { status: "unavailable", reason: "storage_unavailable" },
      { status: "unavailable", stage: "storage", code: "storage_unavailable" },
    ],
    // A fault of the store, never of the client: a retry, not a refusal (review468a 1).
    [
      "conflict",
      { status: "conflict" },
      { status: "unavailable", stage: "storage", code: "storage_conflict" },
    ],
    [
      "invalid",
      { status: "invalid" },
      { status: "unavailable", stage: "storage", code: "storage_refused" },
    ],
  ])("maps a store answering %s and commits nothing", async (_, answer, expected) => {
    const { run, queries, payloads } = setup();
    payloads.putImmutable.mockResolvedValueOnce(answer as never);
    expect(await run()).toEqual(expected);
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
  });

  it("is unavailable when a known key's object cannot be named", async () => {
    const { run, queries, payloads } = setup({ ...CONTEXT_ROW, transactionKnown: true });
    payloads.storageRefFor.mockResolvedValueOnce({ status: "unavailable", reason: "x" } as never);
    expect(await run()).toEqual({
      status: "unavailable",
      stage: "storage",
      code: "storage_unavailable",
    });
    expect(queries.map((q) => q.kind)).toEqual(["context"]);
  });

  it("gives a closed code, never a message, when a dependency throws", async () => {
    const { run, payloads } = setup();
    payloads.putImmutable.mockRejectedValueOnce(
      new Error("bucket ductus-evidence-x secret detail"),
    );
    expect(await run()).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "prepare_failed",
    });
  });
});

// SRV-33 (Ductus#2028 c.7009695691): the snapshot may be of schema 2; it goes
// to the acceptance as received, whose database keeps a work at the version
// of its revision 0. An unknown field is still refused before storage (B-8).
describe("createEvidenceService().commit with a document v2", () => {
  const SRC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const v2 = (source: Record<string, unknown>) =>
    canonicalizeJcs({
      schemaVersion: 2,
      nodes: [
        {
          type: "paragraph",
          id: "11111111-1111-4111-8111-111111111111",
          children: [
            { type: "text", text: "Izmišljeni odlomak.", marks: [] },
            { type: "citation", sourceId: SRC, locator: "str. 12" },
          ],
        },
      ],
      sources: [source],
    });
  const book = {
    type: "book",
    id: SRC,
    authors: [{ kind: "person", family: "Prezime", given: "Ime" }],
    year: 2020,
    title: "Izvor 1",
    place: "Zagreb",
    publisher: "Nakladnik",
  };
  /** The golden segment, its last event and the segment ending in `text`. */
  const ending = (text: string) => {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const events = golden.segment.events.map((event, i, all) =>
      i === all.length - 1 ? { ...event, afterDocumentHash: hash } : event,
    );
    return {
      segment: segmentWith({ finalDocumentHash: hash, events }),
      document: new TextEncoder().encode(text),
    };
  };

  it("commits a v2 snapshot byte for byte", async () => {
    const text = v2(book);
    const { run, queries, payloads } = setup(CONTEXT_ROW, V2_ZERO);
    expect((await run(ending(text))).status).toBe("stale_base");
    expect(payloads.putImmutable).toHaveBeenCalledOnce();
    expect(queries.find((q) => q.kind === "commit")?.values[8]).toBe(text);
  });

  it("refuses a v2 snapshot with an unknown field before anything is stored", async () => {
    const { run, queries, payloads } = setup(CONTEXT_ROW, V2_ZERO);
    expect(await run(ending(v2({ ...book, note: "x" })))).toEqual({ status: "invalid" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.some((q) => q.kind === "commit")).toBe(false);
  });
});

// SRV-7F (docs/contracts/document-schema-v3.md §5 t. 7, §7): the step format
// and the snapshot are judged against the version of the work's revision 0,
// before anything is stored. Steps of the golden segment, recorded under
// ductus-edit-steps-v3, are valid v3 steps.
describe("createEvidenceService().commit by the version of the work", () => {
  const V3_DOCUMENT = canonicalizeJcs({
    schemaVersion: 3,
    nodes: [
      {
        type: "paragraph",
        id: "11111111-1111-4111-8111-111111111111",
        children: [
          { type: "text", text: "Izmišljeni odlomak.", marks: [] },
          { type: "footnote", text: "Izmišljeno objašnjenje." },
        ],
      },
    ],
    sources: [],
  });
  const V1_TEXT = new TextDecoder().decode(DOCUMENT);
  /** The golden segment under `format`, ending in `text`. */
  const ending = (text: string, format: string) => {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const events = golden.segment.events.map((event, i, all) =>
      i === all.length - 1 ? { ...event, afterDocumentHash: hash } : event,
    );
    return {
      segment: segmentWith({
        finalDocumentHash: hash,
        events,
        captureContext: { editorModel: "prosemirror", transactionFormat: format },
      }),
      document: new TextEncoder().encode(text),
    };
  };
  const V1_STEPS = "ductus-edit-steps-v1";
  const V3_STEPS = "ductus-edit-steps-v3";

  it("commits v3 steps and a v3 snapshot on a v3 work", async () => {
    const { run, queries, payloads, zeroReads } = setup(CONTEXT_ROW, V3_ZERO);
    expect((await run(ending(V3_DOCUMENT, V3_STEPS))).status).toBe("stale_base");
    expect(payloads.putImmutable).toHaveBeenCalledOnce();
    expect(zeroReads.map((q) => q.values)).toEqual([[REQUEST.documentId]]);
    expect(queries.find((q) => q.kind === "commit")?.values[8]).toBe(V3_DOCUMENT);
  });

  it.each([
    ["v3 steps on a v1 work", V1_ZERO, V3_DOCUMENT, V3_STEPS],
    ["v3 steps and a v1 snapshot on a v1 work", V1_ZERO, V1_TEXT, V3_STEPS],
    ["v3 steps on a v2 work", V2_ZERO, V3_DOCUMENT, V3_STEPS],
    ["v1 steps on a v3 work", V3_ZERO, V3_DOCUMENT, V1_STEPS],
    ["v3 steps and a v1 snapshot on a v3 work", V3_ZERO, V1_TEXT, V3_STEPS],
    ["v1 steps and a v3 snapshot on a v1 work", V1_ZERO, V3_DOCUMENT, V1_STEPS],
    ["v1 steps and a v1 snapshot on a v2 work", V2_ZERO, V1_TEXT, V1_STEPS],
    ["v2 steps on a v2 work", V2_ZERO, V1_TEXT, "ductus-edit-steps-v2"],
  ])("refuses %s as invalid before anything is stored", async (_, zero, text, format) => {
    const { run, queries, payloads } = setup(CONTEXT_ROW, zero);
    expect(await run(ending(text, format))).toEqual({ status: "invalid" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.some((q) => q.kind === "commit")).toBe(false);
  });

  it("is unavailable, storing nothing, when the work's revision 0 names no version", async () => {
    const { run, queries, payloads } = setup(CONTEXT_ROW, "c".repeat(64));
    expect(await run()).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.some((q) => q.kind === "commit")).toBe(false);
  });
});

// SRV-10E (docs/contracts/document-schema-v4.md §9 t. 9, §10): v4 steps and a
// v4 snapshot only on a v4 work, and a v4 work takes no other; each refusal
// comes before anything is stored. The steps of the golden segment are text,
// so under -v4 they pass exactly when the document's v4 parser reads them.
describe("createEvidenceService().commit by the version of the work, v4", () => {
  const { documentsV4 } = JSON.parse(
    readFileSync(new URL("../domain/document/golden-vectors-v4.json", import.meta.url), "latin1"),
  ) as { documentsV4: { name: string; utf8Hex: string }[] };
  const V4_DOCUMENTS = documentsV4.map((d) => Buffer.from(d.utf8Hex, "hex").toString("utf8"));
  const V4_DOCUMENT = V4_DOCUMENTS.at(-1)!;
  const V3_DOCUMENT = canonicalizeJcs({
    schemaVersion: 3,
    nodes: [
      {
        type: "paragraph",
        id: "11111111-1111-4111-8111-111111111111",
        children: [{ type: "text", text: "Izmišljeni odlomak.", marks: [] }],
      },
    ],
    sources: [],
  });
  const V1_TEXT = new TextDecoder().decode(DOCUMENT);
  const ending = (text: string, format: string) => {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const events = golden.segment.events.map((event, i, all) =>
      i === all.length - 1 ? { ...event, afterDocumentHash: hash } : event,
    );
    return {
      segment: segmentWith({
        finalDocumentHash: hash,
        events,
        captureContext: { editorModel: "prosemirror", transactionFormat: format },
      }),
      document: new TextEncoder().encode(text),
    };
  };
  const V1_STEPS = "ductus-edit-steps-v1";
  const V3_STEPS = "ductus-edit-steps-v3";
  const V4_STEPS = "ductus-edit-steps-v4";
  const goldenStepsAreV4 = golden.segment.events.every(
    (event) => parseEditSteps(V4_STEPS, event.steps).ok,
  );

  it("has golden v4 documents the domain takes", async () => {
    expect(V4_DOCUMENTS.length).toBeGreaterThan(0);
    for (const text of V4_DOCUMENTS) {
      const verified = await verifyVersionedDocumentSnapshot(new TextEncoder().encode(text));
      expect(verified.ok && verified.document.schemaVersion).toBe(4);
    }
  });

  it.each([
    ["v4 steps on a v1 work", V1_ZERO, 1, V1_TEXT, V4_STEPS],
    ["v4 steps on a v2 work", V2_ZERO, 2, V1_TEXT, V4_STEPS],
    ["v4 steps on a v3 work", V3_ZERO, 3, V3_DOCUMENT, V4_STEPS],
    ["v4 steps and a v4 snapshot on a v3 work", V3_ZERO, 3, V4_DOCUMENT, V4_STEPS],
    ["v1 steps and a v4 snapshot on a v1 work", V1_ZERO, 1, V4_DOCUMENT, V1_STEPS],
    ["v1 steps and a v4 snapshot on a v2 work", V2_ZERO, 2, V4_DOCUMENT, V1_STEPS],
    ["v3 steps and a v4 snapshot on a v3 work", V3_ZERO, 3, V4_DOCUMENT, V3_STEPS],
    ["v1 steps on a v4 work", V1_ZERO, 4, V4_DOCUMENT, V1_STEPS],
    ["v3 steps on a v4 work", V1_ZERO, 4, V4_DOCUMENT, V3_STEPS],
    ["v4 steps and a v3 snapshot on a v4 work", V1_ZERO, 4, V3_DOCUMENT, V4_STEPS],
    ["v4 steps and a v1 snapshot on a v4 work", V1_ZERO, 4, V1_TEXT, V4_STEPS],
    ["v1 steps on a work of version 5", V1_ZERO, 5, V1_TEXT, V1_STEPS],
  ])("refuses %s as invalid before anything is stored", async (_, zero, version, text, format) => {
    const { run, queries, payloads } = setup(CONTEXT_ROW, zero, version);
    expect(await run(ending(text, format))).toEqual({ status: "invalid" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.some((q) => q.kind === "commit")).toBe(false);
  });

  it.each(V4_DOCUMENTS.map((text, i) => [documentsV4[i]!.name, text]))(
    "takes v4 steps and the v4 snapshot %s on a v4 work exactly when the steps are v4",
    async (_, text) => {
      const { run, queries, payloads } = setup(CONTEXT_ROW, V1_ZERO, 4);
      const outcome = await run(ending(text, V4_STEPS));
      if (goldenStepsAreV4) {
        expect(outcome.status).toBe("stale_base");
        expect(payloads.putImmutable).toHaveBeenCalledOnce();
        expect(queries.find((q) => q.kind === "commit")?.values[8]).toBe(text);
      } else {
        // Until the document reads ductus-edit-steps-v4 (SRV-10A §11 t. 5).
        expect(outcome).toEqual({ status: "invalid" });
        expect(payloads.putImmutable).not.toHaveBeenCalled();
      }
    },
  );

  it("is unavailable, storing nothing, while the database names no v4 work", async () => {
    // A v4 revision 0 is not one of the hashes the database lane reads yet.
    const { run, queries, payloads } = setup(CONTEXT_ROW, REVISION_ZERO_V4_SHA256);
    expect(await run(ending(V4_DOCUMENT, V4_STEPS))).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(queries.some((q) => q.kind === "commit")).toBe(false);
  });
});

// DAN-343 (contract on #896): the server takes a v3 segment and names v3 in
// the descriptor it commits; citation-form in a v2 segment is refused before
// anything is stored.
describe("createEvidenceService().commit with format v3", () => {
  const withCitation = (evidenceSchema: string) =>
    segmentWith({
      evidenceSchema,
      events: golden.segment.events.map((event, index) =>
        index === 0 ? { ...event, source: "citation-form" } : event,
      ),
    });

  it("commits a v3 segment under a v3 descriptor", async () => {
    const { run, queries, payloads } = setup();
    const segment = withCitation("ductus-evidence-segment-v3");
    await run({ segment });
    expect(payloads.putImmutable).toHaveBeenCalledOnce();
    const descriptor = JSON.parse(String(queries.find((q) => q.kind === "commit")?.values[5]));
    expect(descriptor).toMatchObject({
      evidenceSchema: "ductus-evidence-segment-v3",
      segmentHash: createHash("sha256").update(segment).digest("hex"),
      payloadBytes: segment.byteLength,
    });
  });

  it.each(["ductus-evidence-segment-v2", "ductus-evidence-segment-v4"])(
    "refuses citation-form under %s without storing or committing",
    async (evidenceSchema) => {
      const { run, queries, payloads } = setup();
      expect(await run({ segment: withCitation(evidenceSchema) })).toEqual({ status: "invalid" });
      expect(payloads.putImmutable).not.toHaveBeenCalled();
      expect(queries.map((q) => q.kind)).not.toContain("commit");
    },
  );
});
// DAN-411 step 1 (contract on #1836): the domain parses a valid v4 segment, but
// the server keeps refusing v4 until step 2 opens it after the binding checks of
// step 3; nothing is stored or committed.
describe("createEvidenceService().commit with format v4 before step 2", () => {
  const IMPORT = {
    source: "import",
    importId: "00000000-0000-4000-8000-0000000000b1",
    importManifestSha256: "1".repeat(64),
  };
  const ORIGIN = {
    kind: "ai-response",
    refId: "00000000-0000-4000-8000-0000000000b2",
    textSha256: "2".repeat(64),
  };

  it.each([
    ["an import", IMPORT],
    ["a paste with pasteOrigin", { source: "paste", pasteOrigin: ORIGIN }],
  ])("refuses a valid v4 segment with %s without storing or committing", async (_name, change) => {
    const { run, queries, payloads } = setup();
    const segment = segmentWith({
      evidenceSchema: "ductus-evidence-segment-v4",
      events: golden.segment.events.map((event, index) =>
        index === 0 ? { ...event, ...change } : event,
      ),
    });
    // The refusal is the server's: the domain accepts this segment.
    expect(isEvidenceSegment(JSON.parse(new TextDecoder().decode(segment)))).toBe(true);
    expect(await run({ segment })).toEqual({ status: "invalid" });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(payloads.storageRefFor).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).not.toContain("commit");
  });
});

// DAN-453 PR 0 (#1258 G2): the real caller refuses every reserved value of
// D-34 and D-132 before anything is stored or committed.
describe("createEvidenceService().commit with a reserved value", () => {
  const SUGGESTION = "33333333-3333-4333-8333-333333333333";
  const VARIANT = "44444444-4444-4444-8444-444444444444";
  const withFirstEvent = (evidenceSchema: string, change: Record<string, unknown>) =>
    segmentWith({
      evidenceSchema,
      events: golden.segment.events.map((event, index) =>
        index === 0 ? { ...event, ...change } : event,
      ),
    });

  it.each([
    ["ductus-evidence-segment-v2", { source: "applied-suggestion", suggestionId: SUGGESTION }],
    ["ductus-evidence-segment-v3", { source: "applied-suggestion", suggestionId: SUGGESTION }],
    ["ductus-evidence-segment-v2", { source: "own-variant", variantId: VARIANT }],
    ["ductus-evidence-segment-v3", { source: "own-variant", variantId: VARIANT }],
    ["ductus-evidence-segment-v3", { source: "citation-form", suggestionId: SUGGESTION }],
    ["ductus-evidence-segment-v2", { variantId: VARIANT }],
    ["ductus-evidence-variant-v1", {}],
  ])("refuses %s with %j without storing or committing", async (evidenceSchema, change) => {
    const { run, queries, payloads } = setup();
    expect(await run({ segment: withFirstEvent(evidenceSchema, change) })).toEqual({
      status: "invalid",
    });
    expect(payloads.putImmutable).not.toHaveBeenCalled();
    expect(payloads.storageRefFor).not.toHaveBeenCalled();
    expect(queries.map((q) => q.kind)).not.toContain("commit");
  });
});

// E7, E8: the service hands the committer the signing the route asked for and
// nothing else; without one it signs inline (protocol 1), so a protocol-1
// commit never comes back pending.
describe("createEvidenceService().commit signing", () => {
  function spying() {
    const withActor: WithActor = async (_token, fn) => {
      const tx: ActorTransaction = {
        async query(text) {
          // SRV-7F: the context's read of revision 0 names a v1 work, and its
          // read of the kind a text work (SRV-V14-SHEET-COMMIT).
          const row = text.includes("evidence.document_revision")
            ? { content_hash: V1_ZERO }
            : text.includes("document_kind")
              ? snake({ documentKind: "text" })
              : snake(CONTEXT_ROW);
          return { rows: [row] as never[], rowCount: 1 };
        },
      };
      return fn(tx);
    };
    const real = createEvidenceCommitter(withActor, refusingSigner);
    const commit = vi.fn(async () => ({ status: "txid_reused" as const }));
    const payloads = {
      putImmutable: vi.fn(async () => ({ status: "stored" as const, storageRef: "memory:ref" })),
      storageRefFor: vi.fn(async () => ({ status: "ok" as const, storageRef: "memory:ref" })),
    };
    const service = createEvidenceService({
      committer: { readContext: real.readContext, commit },
      payloads,
    });
    return { service, commit };
  }

  it.each([
    ["no signing given", undefined, "inline"],
    ["inline", "inline", "inline"],
    ["deferred", "deferred", "deferred"],
  ] as const)("%s reaches the committer as %s", async (_name, signing, expected) => {
    const { service, commit } = spying();
    expect(await service.commit("t", REQUEST, signing)).toEqual({ status: "txid_reused" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]).toEqual(["t", expect.any(Object), expected]);
  });
});
