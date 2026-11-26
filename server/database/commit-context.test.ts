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
// SRV-7F: the revision 0 hashes as contracts v1 and v3 write them.
const V1_ZERO = "a102ced8a59b446a86c135c8d87d3ddf9f889e4ac93bcbc1857cd7c2c73ad14b";
const V3_ZERO = "b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141";
// SRV-V14-SHEET-COMMIT: the revision 0 of every spreadsheet work, and the
// column of the work's kind (a computed key: the lint takes no snake_case key).
const KIND = "document_kind";
const SHEET_ZERO = "70f7ffa27faf9f771316120c2b2f94e351aed32af3b94177d4c85ff56b0066e4";
const CONTEXT: EvidenceCommitContext = {
  evidencePackageId: "pkg-1",
  institutionId: INSTITUTION,
  evidenceDomainId: DOMAIN,
  evidenceProfileId: "standard-v1",
  maxPayloadBytes: 262144,
  transactionKnown: false,
  documentKind: "text",
  documentSchemaVersion: 1,
  state: {
    currentRevision: 4,
    documentHash: "e".repeat(64),
    headSegmentHash: null,
    lastSequenceTo: 8,
  },
};

/** A withActor that answers the context statement and records what it was given. */
function database(
  rows: unknown[],
  revisionZero: unknown[] = [{ content_hash: V1_ZERO }],
  kind: unknown[] = [{ [KIND]: "text" }],
) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        const answer = text.includes("evidence.document_revision")
          ? revisionZero
          : text.includes("document_kind")
            ? kind
            : rows;
        return { rows: answer as never[], rowCount: answer.length };
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

  it("SRV-7F: names the version of the work from its revision 0, in the same transaction", async () => {
    const db = database([row], [{ content_hash: V3_ZERO }]);
    expect(await readerOf(db).readContext(TOKEN, "doc-1", "tx-1")).toEqual({
      status: "ok",
      context: { ...CONTEXT, documentSchemaVersion: 3 },
    });
    expect(db.seen).toHaveLength(3);
    expect(db.seen[2]?.text).toMatch(/evidence\.document_revision[\s\S]*revision = 0/);
    expect(db.seen[2]?.values).toEqual(["doc-1"]);
    expect(db.seen[2]?.token).toBe(TOKEN);
  });

  it("SRV-V14-SHEET-COMMIT: reads the kind of the work from evidence.document, in the same transaction", async () => {
    const db = database([row]);
    await readerOf(db).readContext(TOKEN, "doc-1", "tx-1");
    expect(db.seen[1]?.text).toMatch(/SELECT document_kind FROM evidence\.document WHERE id = \$1/);
    expect(db.seen[1]?.values).toEqual(["doc-1"]);
    expect(db.seen[1]?.token).toBe(TOKEN);
  });

  it("SRV-V14-SHEET-COMMIT: names a spreadsheet work by its kind and its revision 0", async () => {
    const db = database([row], [{ content_hash: SHEET_ZERO }], [{ [KIND]: "spreadsheet" }]);
    expect(await readerOf(db).readContext(TOKEN, "doc-1", "tx-1")).toEqual({
      status: "ok",
      context: { ...CONTEXT, documentKind: "spreadsheet", documentSchemaVersion: 1 },
    });
  });

  it.each([
    ["a spreadsheet work with a text revision 0", "spreadsheet", V1_ZERO],
    ["a spreadsheet work with a v3 revision 0", "spreadsheet", V3_ZERO],
    ["a text work with the spreadsheet revision 0", "text", SHEET_ZERO],
    ["a slides work, which this reader does not know yet", "slides", SHEET_ZERO],
    ["a kind this server does not know", "drawing", V1_ZERO],
    ["a kind that is an object key", "__proto__", V1_ZERO],
    ["no kind", null, V1_ZERO],
  ])("SRV-V14-SHEET-COMMIT: is unavailable for %s, never a guessed kind", async (_, kind, zero) => {
    const db = database([row], [{ content_hash: zero }], [{ [KIND]: kind }]);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
  });

  it.each([
    ["no row", []],
    ["two rows", [{ [KIND]: "text" }, { [KIND]: "text" }]],
  ])("SRV-V14-SHEET-COMMIT: is unavailable for %s of the kind", async (_, kind) => {
    const db = database([row], undefined, kind);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
    });
  });

  it.each([
    ["no revision 0", []],
    ["a revision 0 that is no known one", [{ content_hash: "c".repeat(64) }]],
    ["two revisions 0", [{ content_hash: V1_ZERO }, { content_hash: V1_ZERO }]],
  ])("SRV-7F: is unavailable for %s, never a guessed version", async (_, revisionZero) => {
    const db = database([row], revisionZero);
    expect(await readerOf(db).readContext("t", "doc-1", "tx-1")).toEqual({
      status: "unavailable",
      stage: "context",
      code: "context_malformed",
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
