// DAN-815 part a1, plan of attack ductura/server#119 part F1. Port of the
// readEvidenceCommitContext cases of Ductus
// src/server/evidence/evidence-commit.test.ts at d52a92c3. Every id and hash
// below is invented.
import { describe, expect, it } from "vitest";

import { createCommitContextReader, type EvidenceCommitContext } from "./commit-context.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const INSTITUTION = "00000000-0000-4000-8000-0000000000a1";
const HASH = "b".repeat(64);
const TOKEN = "izmisljeni-token-konteksta-0000000000000001";
const CONTEXT: EvidenceCommitContext = {
  evidencePackageId: "pkg-1",
  institutionId: INSTITUTION,
  evidenceDomainId: DOMAIN,
  evidenceProfileId: "standard-v1",
  maxPayloadBytes: 262144,
  transactionKnown: false,
  state: {
    currentRevision: 4,
    documentHash: "e".repeat(64),
    headSegmentHash: null,
    lastSequenceTo: 8,
  },
};

/** A withActor that answers the context statement and records what it was given. */
function database(rows: unknown[]) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { withActor, seen };
}

const readerOf = (db: { withActor: WithActor }) => createCommitContextReader(db.withActor);

describe("readContext", () => {
  const row = {
    outcome: "ok",
    evidence_package_id: "pkg-1",
    institution_id: INSTITUTION,
    evidence_domain_id: DOMAIN,
    evidence_profile_id: "standard-v1",
    max_payload_bytes: 262144,
    transaction_known: false,
    current_revision: "4",
    document_hash: "e".repeat(64),
    head_segment_hash: null,
    last_sequence_to: "8",
  };

  it("returns the context the database resolved", async () => {
    const db = database([row]);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "ok",
      context: CONTEXT,
    });
  });

  it("returns a head segment the database names (F-099)", async () => {
    const db = database([{ ...row, head_segment_hash: HASH, current_revision: 5 }]);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "ok",
      context: {
        ...CONTEXT,
        state: { ...CONTEXT.state, currentRevision: 5, headSegmentHash: HASH },
      },
    });
  });

  it.each(["unauthenticated", "not_found", "invalid", "not_accepting"])(
    "passes %s through",
    async (outcome) => {
      const db = database([{ outcome }]);
      expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({ status: outcome });
    },
  );

  it.each([
    ["no row", []],
    ["two rows", [row, row]],
    ["an unknown outcome", [{ ...row, outcome: "found" }]],
    ["a package id of another form", [{ ...row, evidence_package_id: "PKG/1" }]],
    ["a domain that is no v4 uuid", [{ ...row, evidence_domain_id: "local" }]],
    ["an institution that is no uuid", [{ ...row, institution_id: null }]],
    ["an empty profile", [{ ...row, evidence_profile_id: "" }]],
    ["a limit of 0", [{ ...row, max_payload_bytes: 0 }]],
    // review467a: a limit that is not a whole number never passes as one.
    ["a limit that is not whole", [{ ...row, max_payload_bytes: 1.5 }]],
    ["a limit given as text", [{ ...row, max_payload_bytes: "262144" }]],
    ["a known flag that is no boolean", [{ ...row, transaction_known: "f" }]],
    ["no current revision", [{ ...row, current_revision: null }]],
    ["a negative revision", [{ ...row, current_revision: "-1" }]],
    ["a document hash that is no hash", [{ ...row, document_hash: "e" }]],
    ["a head that is no hash", [{ ...row, head_segment_hash: "" }]],
    ["no last sequence", [{ ...row, last_sequence_to: null }]],
    // Plan of attack #119 F1: counters only as the canonical text of a safe integer.
    ["a negative last sequence", [{ ...row, last_sequence_to: "-1" }]],
    ["a last sequence with a leading zero", [{ ...row, last_sequence_to: "01" }]],
    ["a last sequence above 2^53", [{ ...row, last_sequence_to: "9007199254740992" }]],
    ["a last sequence that is no number", [{ ...row, last_sequence_to: "x" }]],
    ["a fractional last sequence", [{ ...row, last_sequence_to: 1.5 }]],
    ["a revision with a leading zero", [{ ...row, current_revision: "01" }]],
    ["a revision above 2^53", [{ ...row, current_revision: "9007199254740992" }]],
    ["a negative limit", [{ ...row, max_payload_bytes: -1 }]],
    ["a document hash in upper case", [{ ...row, document_hash: "E".repeat(64) }]],
    ["a head of 63 digits", [{ ...row, head_segment_hash: "b".repeat(63) }]],
  ])("is unavailable for %s", async (_, rows) => {
    const db = database(rows);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
  });

  it("is unavailable with a closed code when the database fails", async () => {
    const failing: WithActor = () => Promise.reject(new Error("secret detail"));
    expect(await createCommitContextReader(failing).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_failed",
    });
  });
});

describe("readContext parameters", () => {
  it("presents the token to withActor only; the statement gets the document and transaction ids", async () => {
    const db = database([{ outcome: "not_found" }]);
    expect(await readerOf(db).readContext(TOKEN, "doc-1", "tx-1")).toEqual({ status: "not_found" });
    expect(db.seen).toHaveLength(1);
    expect(db.seen[0]?.token).toBe(TOKEN);
    expect(db.seen[0]?.values).toEqual(["doc-1", "tx-1"]);
    expect(db.seen[0]?.text).toContain("app.evidence_commit_context($1, $2)");
  });
});
