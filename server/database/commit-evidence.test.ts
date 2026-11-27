// DAN-815 part a2, plan of attack ductura/server#119 parts E and F. Port of
// Ductus src/server/evidence/evidence-commit.test.ts at d52a92c3, over
// createEvidenceCommitter; the signer answers a Result, as our signing port
// does. Invented ids, hashes and a key made for this test only.
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  type EvidenceReceiptPayloadV2,
  type EvidenceSegmentDescriptorV2,
  type SignatureEnvelope,
} from "../domain/index.ts";

import type { EvidenceCommitContext } from "./commit-context.ts";
import {
  createEvidenceCommitter,
  type EvidenceCommitInput,
  type ReceiptSigner,
} from "./commit-evidence.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const INSTITUTION = "00000000-0000-4000-8000-0000000000a1";
const RECEIPT = "00000000-0000-4000-8000-0000000000c1";
const HASH = "b".repeat(64);
const CONTEXT: EvidenceCommitContext = {
  evidencePackageId: "pkg-1",
  institutionId: INSTITUTION,
  evidenceDomainId: DOMAIN,
  evidenceProfileId: "standard-v1",
  maxPayloadBytes: 262144,
  transactionKnown: false,
  documentSchemaVersion: 1,
  state: {
    currentRevision: 4,
    documentHash: "e".repeat(64),
    headSegmentHash: null,
    lastSequenceTo: 8,
  },
};
const DESCRIPTOR: EvidenceSegmentDescriptorV2 = {
  evidencePackageId: "pkg-1",
  documentId: "doc-1",
  sessionId: "session-1",
  segmentId: "segment-1",
  evidenceSchema: "ductus-evidence-segment-v2",
  canonicalization: "RFC8785-JCS",
  hashAlgorithm: "sha256",
  evidenceProfileId: "standard-v1",
  sequenceFrom: 1,
  sequenceTo: 1,
  eventCount: 1,
  observedStartedAt: "2026-10-19T06:00:00.000Z",
  observedEndedAt: "2026-10-19T06:00:00.000Z",
  segmentHash: HASH,
  predecessorSegmentHash: null,
  payloadBytes: 123,
};
const INPUT: EvidenceCommitInput = {
  context: CONTEXT,
  documentId: "doc-1",
  clientTransactionId: "tx-1",
  baseRevision: 0,
  initialDocumentHash: "c".repeat(64),
  finalDocumentHash: "d".repeat(64),
  descriptor: DESCRIPTOR,
  storageRef: "local-demo:v2/x/pkg-1/b.json",
  snapshot: "{}",
  aiTransferLinks: null,
};
const PAYLOAD: EvidenceReceiptPayloadV2 = {
  receiptSchema: "ductus-evidence-receipt-v2",
  receiptId: RECEIPT,
  evidenceDomainId: DOMAIN,
  evidencePackageId: "pkg-1",
  documentId: "doc-1",
  revision: 1,
  clientTransactionId: "tx-1",
  principalId: "00000000-0000-4000-8000-0000000000e1",
  sessionId: "session-1",
  segmentId: "segment-1",
  segmentHash: HASH,
  predecessorSegmentHash: null,
  previousReceiptId: null,
  evidenceSchema: "ductus-evidence-segment-v2",
  evidenceProfileId: "standard-v1",
  sequenceFrom: 1,
  sequenceTo: 1,
  eventCount: 1,
  payloadBytes: 123,
  acceptedAt: "2026-10-19T06:00:00.000Z",
};
const TEXT = canonicalizeJcs(PAYLOAD);

const pair = generateKeyPairSync("ed25519");
const KEY = { keyId: "test-key-1", keyVersion: "1" };
const KEY_ROW = {
  key_id: KEY.keyId,
  key_version: KEY.keyVersion,
  evidence_domain_id: DOMAIN,
  purpose: "receipt",
  algorithm: "Ed25519",
  key_base64url: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  valid_from: "2026-10-19T05:00:00.000Z",
  valid_to: null,
  revoked_at: null,
};

function sign(message: Uint8Array): SignatureEnvelope {
  return {
    algorithm: "Ed25519",
    ...KEY,
    signatureEncoding: "raw",
    signatureBase64Url: nodeSign(null, Buffer.from(message), pair.privateKey).toString("base64url"),
  };
}

function signer(
  behaviour: (message: Uint8Array) => Promise<SignatureEnvelope> = async (m) => sign(m),
) {
  const calls: Uint8Array[] = [];
  const provider: ReceiptSigner = {
    sign: async (message) => {
      calls.push(message);
      return { ok: true, value: await behaviour(message) };
    },
  };
  return { provider, calls };
}

type Script = { commit: unknown[]; keys?: unknown[]; attach?: unknown[] };

/** A withActor whose transaction answers by statement and records what ran and how it ended. */
function database(script: Script, failAt?: "commit") {
  const ran: string[] = [];
  const ended: string[] = [];
  const withActor: WithActor = async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text) {
        const kind = text.includes("commit_evidence_segment")
          ? "commit"
          : text.includes("attach_receipt_signature")
            ? "attach"
            : text.includes("signing_key")
              ? "keys"
              : "context";
        ran.push(kind);
        if (failAt === kind) throw new Error("connection reset: secret detail");
        const rows = (
          kind === "context" ? script.commit : (script[kind as keyof Script] ?? [])
        ) as never[];
        return { rows, rowCount: rows.length };
      },
    };
    try {
      const result = await fn(tx);
      ended.push("commit");
      return result;
    } catch (error) {
      ended.push("rollback");
      throw error;
    }
  };
  return { withActor, ran, ended };
}

const reserved = (extra: Record<string, unknown> = {}) => ({
  outcome: "reserved",
  committed_revision: "1",
  receipt_payload: TEXT,
  receipt_id: RECEIPT,
  signature: null,
  ...extra,
});

async function storedSignature() {
  const digest = await digestEvidenceReceiptPayloadV2(PAYLOAD);
  // jsonb gives the keys in its own order; the answer must not depend on it.
  const { keyId, algorithm, keyVersion, signatureBase64Url, signatureEncoding } = sign(
    digest.signingInput,
  );
  return { keyId, algorithm, keyVersion, signatureBase64Url, signatureEncoding };
}

describe("readContext", () => {
  // The cases of the context are in commit-context.test.ts (part a1); the
  // committer only passes the reader through.
  it("reads the context through the same withActor", async () => {
    const db = database({ commit: [{ outcome: "not_found" }] });
    expect(
      await createEvidenceCommitter(db.withActor, signer().provider).readContext("t", "d", "x"),
    ).toEqual({ status: "not_found" });
    expect(db.ran).toEqual(["context"]);
  });
});

describe("commit", () => {
  it("signs the reserved receipt, verifies it under the registry key and attaches it in the same transaction", async () => {
    const db = database({ commit: [reserved()], keys: [KEY_ROW], attach: [{ outcome: "signed" }] });
    const s = signer();
    const outcome = await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT);
    expect(outcome).toMatchObject({
      status: "committed",
      revision: 1,
      signedReceipt: { payload: PAYLOAD },
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.byteLength).toBe(59);
    expect(db.ran).toEqual(["commit", "keys", "attach"]);
    expect(db.ended).toEqual(["commit"]);
  });

  it("answers a signed retry with the stored receipt, byte for byte, without signing or attaching", async () => {
    const firstDb = database({
      commit: [reserved()],
      keys: [KEY_ROW],
      attach: [{ outcome: "signed" }],
    });
    const first = await createEvidenceCommitter(firstDb.withActor, signer().provider).commit(
      "t",
      INPUT,
    );
    const db = database({
      commit: [{ ...reserved(), outcome: "duplicate_signed", signature: await storedSignature() }],
      keys: [KEY_ROW],
    });
    const s = signer();
    const again = await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT);
    expect(again.status).toBe("duplicate");
    expect(JSON.stringify(again.status === "duplicate" && again.signedReceipt)).toBe(
      JSON.stringify(first.status === "committed" && first.signedReceipt),
    );
    expect(s.calls).toHaveLength(0);
    expect(db.ran).toEqual(["commit", "keys"]);
  });

  it.each([
    ["a changed signature", { signatureBase64Url: "A".repeat(85) + "A" }, [KEY_ROW]],
    ["a key that is not in the registry", {}, []],
    ["a revoked key", {}, [{ ...KEY_ROW, revoked_at: "2026-10-19T05:30:00.000Z" }]],
    ["a checkpoint key of the domain", {}, [{ ...KEY_ROW, purpose: "checkpoint" }]],
  ])("never trusts a stored receipt with %s, and never signs it again", async (_, change, keys) => {
    const db = database({
      commit: [
        {
          ...reserved(),
          outcome: "duplicate_signed",
          signature: { ...(await storedSignature()), ...change },
        },
      ],
      keys,
    });
    const s = signer();
    expect(await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT)).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "stored_receipt_unverified",
    });
    expect(s.calls).toHaveLength(0);
    expect(db.ran).not.toContain("attach");
  });

  it("never signs a pending acceptance (T6, T8)", async () => {
    const db = database({ commit: [{ ...reserved(), outcome: "duplicate_pending" }] });
    const s = signer();
    expect(await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT)).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "duplicate_pending",
    });
    expect(s.calls).toHaveLength(0);
    expect(db.ran).toEqual(["commit"]);
  });

  describe("deferred signing (protocol 2, DAN-518)", () => {
    it.each([
      ["reserved", "committed_pending"],
      ["duplicate_pending", "duplicate_pending"],
    ])("answers %s pending, never signing, attaching or reading keys", async (outcome, status) => {
      const db = database({
        commit: [reserved({ outcome })],
        keys: [KEY_ROW],
        attach: [{ outcome: "signed" }],
      });
      const s = signer();
      expect(
        await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT, "deferred"),
      ).toEqual({
        status,
        revision: 1,
      });
      expect(s.calls).toHaveLength(0);
      expect(db.ran).toEqual(["commit"]);
      // The acceptance is kept, its receipt still pending.
      expect(db.ended).toEqual(["commit"]);
    });

    it("gives a double commit the same revision: reserved, then the retry pending", async () => {
      const s = signer();
      const answers = [];
      for (const outcome of ["reserved", "duplicate_pending"]) {
        const db = database({ commit: [reserved({ outcome })] });
        answers.push(
          await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT, "deferred"),
        );
      }
      expect(answers).toEqual([
        { status: "committed_pending", revision: 1 },
        { status: "duplicate_pending", revision: 1 },
      ]);
      expect(s.calls).toHaveLength(0);
    });

    it("answers a retry the worker has signed with the stored receipt, verified", async () => {
      const db = database({
        commit: [reserved({ outcome: "duplicate_signed", signature: await storedSignature() })],
        keys: [KEY_ROW],
      });
      const s = signer();
      const outcome = await createEvidenceCommitter(db.withActor, s.provider).commit(
        "t",
        INPUT,
        "deferred",
      );
      expect(outcome).toMatchObject({
        status: "duplicate",
        revision: 1,
        signedReceipt: { payload: PAYLOAD },
      });
      expect(s.calls).toHaveLength(0);
      expect(db.ran).toEqual(["commit", "keys"]);
    });

    it("never answers pending for a signed retry whose signature does not verify", async () => {
      const signature = { ...(await storedSignature()), signatureBase64Url: "A".repeat(86) };
      const db = database({
        commit: [reserved({ outcome: "duplicate_signed", signature })],
        keys: [KEY_ROW],
      });
      expect(
        await createEvidenceCommitter(db.withActor, signer().provider).commit(
          "t",
          INPUT,
          "deferred",
        ),
      ).toEqual({
        status: "unavailable",
        stage: "repository",
        code: "stored_receipt_unverified",
      });
    });

    it.each([
      [
        "reserved",
        "a text that is not JCS",
        { receipt_payload: JSON.stringify(PAYLOAD) },
        "receipt_malformed",
      ],
      [
        "reserved",
        "another transaction",
        { receipt_payload: canonicalizeJcs({ ...PAYLOAD, clientTransactionId: "tx-2" }) },
        "receipt_mismatch",
      ],
      [
        "reserved",
        "a revision other than base + 1",
        { committed_revision: "2" },
        "receipt_mismatch",
      ],
      [
        "reserved",
        "another receipt id",
        { receipt_id: "00000000-0000-4000-8000-0000000000c2" },
        "receipt_mismatch",
      ],
      ["reserved", "a signature", { signature: { keyId: "k" } }, "receipt_malformed"],
      ["duplicate_pending", "no payload", { receipt_payload: null }, "receipt_malformed"],
      [
        "duplicate_pending",
        "another document",
        { receipt_payload: canonicalizeJcs({ ...PAYLOAD, documentId: "doc-2" }) },
        "receipt_mismatch",
      ],
      ["duplicate_pending", "a signature", { signature: { keyId: "k" } }, "receipt_malformed"],
    ])("rolls back %s with %s instead of answering pending", async (outcome, _, extra, code) => {
      const db = database({ commit: [reserved({ outcome, ...extra })] });
      const s = signer();
      expect(
        await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT, "deferred"),
      ).toEqual({
        status: "unavailable",
        stage: "repository",
        code,
      });
      expect(s.calls).toHaveLength(0);
      expect(db.ended).toEqual(["rollback"]);
    });
  });

  const state = {
    current_revision: "3",
    document_hash: "e".repeat(64),
    head_segment_hash: null,
    last_sequence_to: "9",
  };
  it.each([
    ["unauthorized", {}, { status: "not_found" }],
    ["context_mismatch", {}, { status: "invalid" }],
    ["invalid", {}, { status: "invalid" }],
    ["idempotency_conflict", {}, { status: "txid_reused" }],
    ["not_accepting", {}, { status: "not_accepting" }],
    ["too_large", {}, { status: "too_large" }],
    ...(["stale_base", "chain_conflict", "not_continuous"] as const).map((outcome) => [
      outcome,
      state,
      {
        status: outcome,
        state: {
          currentRevision: 3,
          documentHash: "e".repeat(64),
          headSegmentHash: null,
          lastSequenceTo: 9,
        },
      },
    ]),
    [
      "stale_base",
      { ...state, document_hash: null },
      { status: "unavailable", stage: "repository", code: "state_malformed" },
    ],
    [
      "chain_conflict",
      { ...state, current_revision: "-1" },
      { status: "unavailable", stage: "repository", code: "state_malformed" },
    ],
    [
      "not_continuous",
      { ...state, head_segment_hash: "B".repeat(64) },
      { status: "unavailable", stage: "repository", code: "state_malformed" },
    ],
    [
      "concurrent_conflict",
      {},
      { status: "unavailable", stage: "repository", code: "outcome_unknown" },
    ],
    ["committed", {}, { status: "unavailable", stage: "repository", code: "outcome_unknown" }],
  ] as [string, Record<string, unknown>, unknown][])(
    "maps %s to its closed outcome without signing",
    async (outcome, extra, expected) => {
      for (const signing of ["inline", "deferred"] as const) {
        const db = database({ commit: [{ outcome, ...extra }] });
        const s = signer();
        expect(
          await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT, signing),
        ).toEqual(expected);
        expect(s.calls).toHaveLength(0);
      }
    },
  );

  it.each([
    ["no row", [], "commit_rows"],
    ["two rows", [reserved(), reserved()], "commit_rows"],
  ])("is unavailable for %s", async (_, rows, code) => {
    const db = database({ commit: rows });
    expect(
      await createEvidenceCommitter(db.withActor, signer().provider).commit("t", INPUT),
    ).toEqual({
      status: "unavailable",
      stage: "repository",
      code,
    });
  });

  const otherText = (change: Partial<EvidenceReceiptPayloadV2>) =>
    canonicalizeJcs({ ...PAYLOAD, ...change });
  it.each([
    ["a text that is not JCS", { receipt_payload: JSON.stringify(PAYLOAD) }, "receipt_malformed"],
    [
      "no v2 payload",
      { receipt_payload: canonicalizeJcs({ ...PAYLOAD, extra: 1 }) },
      "receipt_malformed",
    ],
    [
      "another document",
      { receipt_payload: otherText({ documentId: "doc-2" }) },
      "receipt_mismatch",
    ],
    [
      "another transaction",
      { receipt_payload: otherText({ clientTransactionId: "tx-2" }) },
      "receipt_mismatch",
    ],
    [
      "another segment hash",
      { receipt_payload: otherText({ segmentHash: "f".repeat(64) }) },
      "receipt_mismatch",
    ],
    [
      "another segment",
      { receipt_payload: otherText({ segmentId: "segment-2" }) },
      "receipt_mismatch",
    ],
    [
      "another package",
      { receipt_payload: otherText({ evidencePackageId: "pkg-2" }) },
      "receipt_mismatch",
    ],
    [
      "another domain",
      { receipt_payload: otherText({ evidenceDomainId: "00000000-0000-4000-8000-0000000000d2" }) },
      "receipt_mismatch",
    ],
    [
      "a revision other than base + 1",
      { receipt_payload: otherText({ revision: 2 }) },
      "receipt_mismatch",
    ],
    [
      "both revisions other than base + 1",
      { receipt_payload: otherText({ revision: 2 }), committed_revision: "2" },
      "receipt_mismatch",
    ],
    [
      "a committed revision other than the receipt's",
      { committed_revision: "2" },
      "receipt_mismatch",
    ],
    [
      "another receipt id",
      { receipt_id: "00000000-0000-4000-8000-0000000000c2" },
      "receipt_mismatch",
    ],
  ])("rolls back and signs nothing for a reserved receipt with %s", async (_, extra, code) => {
    const db = database({
      commit: [reserved(extra)],
      keys: [KEY_ROW],
      attach: [{ outcome: "signed" }],
    });
    const s = signer();
    expect(await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT)).toEqual({
      status: "unavailable",
      stage: "repository",
      code,
    });
    expect(s.calls).toHaveLength(0);
    expect(db.ended).toEqual(["rollback"]);
  });

  it.each([
    [
      "a signer that throws",
      () => Promise.reject(new Error("seed path /secret")),
      [KEY_ROW],
      "signing_failed",
    ],
    [
      "a malformed signature",
      async () => ({ algorithm: "Ed25519" }) as SignatureEnvelope,
      [KEY_ROW],
      "signing_failed",
    ],
    [
      "a key that is not in the registry",
      async (m: Uint8Array) => sign(m),
      [],
      "signature_unverified",
    ],
    [
      "a signature over other bytes",
      async () => sign(new Uint8Array(59)),
      [KEY_ROW],
      "signature_unverified",
    ],
  ])(
    "rolls back with stage signing for %s, before any attach (T1, T2, T5)",
    async (_, behaviour, keys, code) => {
      const db = database({ commit: [reserved()], keys, attach: [{ outcome: "signed" }] });
      const outcome = await createEvidenceCommitter(
        db.withActor,
        signer(behaviour).provider,
      ).commit("t", INPUT);
      // Nothing of the receipt, the signature or the error text leaves (T2, P11).
      expect(outcome).toEqual({ status: "unavailable", stage: "signing", code });
      expect(db.ran).not.toContain("attach");
      expect(db.ended).toEqual(["rollback"]);
    },
  );

  it("rolls back with stage signing when the signing port answers a failure", async () => {
    const db = database({ commit: [reserved()], keys: [KEY_ROW], attach: [{ outcome: "signed" }] });
    const failing: ReceiptSigner = {
      sign: async () => ({ ok: false, error: { code: "KMS_DOWN", messageKey: "x" } }),
    };
    expect(await createEvidenceCommitter(db.withActor, failing).commit("t", INPUT)).toEqual({
      status: "unavailable",
      stage: "signing",
      code: "signing_failed",
    });
    expect(db.ran).not.toContain("attach");
    expect(db.ended).toEqual(["rollback"]);
  });

  it.each(["already_signed", "other_transaction", "digest_mismatch", "key_revoked", "unexpected"])(
    "rolls back when the attach RPC answers %s",
    async (answer) => {
      const db = database({ commit: [reserved()], keys: [KEY_ROW], attach: [{ outcome: answer }] });
      expect(
        await createEvidenceCommitter(db.withActor, signer().provider).commit("t", INPUT),
      ).toEqual({
        status: "unavailable",
        stage: "repository",
        code: "attach_refused",
      });
      expect(db.ended).toEqual(["rollback"]);
    },
  );

  it("is unavailable when the registry rows are malformed", async () => {
    const db = database({
      commit: [reserved()],
      keys: [{ ...KEY_ROW, purpose: "other" }],
      attach: [{ outcome: "signed" }],
    });
    expect(
      await createEvidenceCommitter(db.withActor, signer().provider).commit("t", INPUT),
    ).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "domain_keys_unavailable",
    });
    expect(db.ended).toEqual(["rollback"]);
  });

  it("gives a closed code, never the database's message, when a query fails", async () => {
    const db = database({ commit: [] }, "commit");
    expect(
      await createEvidenceCommitter(db.withActor, signer().provider).commit("t", INPUT),
    ).toEqual({
      status: "unavailable",
      stage: "repository",
      code: "commit_failed",
    });
  });
});

describe("a revision of another document version (SRV-33B)", () => {
  /** A transaction whose acceptance fails as the version trigger does: ZD422, no message read. */
  function refusing(code: string) {
    const ended: string[] = [];
    const withActor: WithActor = async (_token, fn) => {
      const tx: ActorTransaction = {
        async query() {
          throw Object.assign(new Error("revision of another document version"), { code });
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        ended.push("rollback");
        throw error;
      }
    };
    return { withActor, ended };
  }

  it("answers invalid (422), not unavailable, when the database refuses the schemaVersion", async () => {
    const s = signer();
    const db = refusing("ZD422");
    expect(await createEvidenceCommitter(db.withActor, s.provider).commit("t", INPUT)).toEqual({
      status: "invalid",
    });
    expect(db.ended).toEqual(["rollback"]);
    expect(s.calls).toHaveLength(0);
  });

  it("keeps every other database code a closed repository fault", async () => {
    for (const code of ["ZD409", "23514", "zd422", "ZD4220"]) {
      expect(
        await createEvidenceCommitter(refusing(code).withActor, signer().provider).commit(
          "t",
          INPUT,
        ),
      ).toEqual({ status: "unavailable", stage: "repository", code: "commit_failed" });
    }
  });
});

describe("statement parameters", () => {
  it("presents the token to withActor only, never as a parameter of a statement", async () => {
    const token = "izmisljeni-token-commita-00000000000000001";
    const seen: { token: unknown; values: readonly unknown[] | undefined }[] = [];
    const withActor = (async (given, fn) => {
      const tx: ActorTransaction = {
        async query(text, values) {
          seen.push({ token: given, values });
          const rows = (
            text.includes("evidence_commit_context")
              ? [{ outcome: "not_found" }]
              : text.includes("commit_evidence_segment")
                ? [reserved()]
                : text.includes("attach_receipt_signature")
                  ? [{ outcome: "signed" }]
                  : [KEY_ROW]
          ) as never[];
          return { rows, rowCount: rows.length };
        },
      };
      return fn(tx);
    }) as WithActor;
    const committer = createEvidenceCommitter(withActor, signer().provider);
    await committer.readContext(token, "doc-1", "tx-1");
    expect(seen[0]?.values).toEqual(["doc-1", "tx-1"]);
    expect(await committer.commit(token, INPUT)).toMatchObject({ status: "committed" });
    expect(seen.length).toBe(4);
    for (const call of seen) {
      expect(call.token).toBe(token);
      expect(JSON.stringify(call.values)).not.toContain(token);
    }
  });

  // SRV-1809: the 10-argument acceptance takes the links as jsonb.
  describe("AI transfer links", () => {
    const LINK = {
      aiTransferId: "00000000-0000-4000-8000-0000000000a2",
      aiTransferSha256: "2".repeat(64),
    };

    async function commitValues(input: EvidenceCommitInput) {
      const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
      const withActor = (async (_token, fn) =>
        fn({
          async query(text, values) {
            seen.push({ text, values });
            return { rows: [{ outcome: "invalid" }] as never[], rowCount: 1 };
          },
        })) as WithActor;
      await createEvidenceCommitter(withActor, signer().provider).commit("t", input);
      return seen.find((call) => call.text.includes("commit_evidence_segment"));
    }

    it("calls the 10-argument acceptance with null for a v2 or v3 segment", async () => {
      const call = await commitValues(INPUT);
      expect(call?.text).toContain("$9, $10::jsonb)");
      expect(call?.values).toHaveLength(10);
      expect(call?.values?.[9]).toBeNull();
    });

    it("sends the links of a v4 segment as a JSON array, in their order", async () => {
      const other = {
        aiTransferId: "00000000-0000-4000-8000-0000000000a3",
        aiTransferSha256: "3".repeat(64),
      };
      const call = await commitValues({ ...INPUT, aiTransferLinks: [LINK, other, LINK] });
      expect(JSON.parse(call?.values?.[9] as string)).toEqual([LINK, other, LINK]);
    });

    it("sends an empty array for a v4 segment that names no transfer", async () => {
      const call = await commitValues({ ...INPUT, aiTransferLinks: [] });
      expect(call?.values?.[9]).toBe("[]");
    });

    it("sends only the two keys of a link", async () => {
      const extra = { ...LINK, note: "x" } as typeof LINK;
      const call = await commitValues({ ...INPUT, aiTransferLinks: [extra] });
      expect(JSON.parse(call?.values?.[9] as string)).toEqual([LINK]);
    });
  });
});
