// Evidence and submission routes of the dev fake server: open a work, commit
// segments, replay them, submit. The fake signs nothing. Every receipt names
// the key FAKE_KEY_ID and carries an all-zero signature, and the receipt key
// that open lists is a public key whose private half was thrown away at
// start, so no receipt of the fake verifies and no real client can take one
// as a signed receipt. No real key is ever read or copied.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import {
  EMPTY_DOCUMENT,
  readerOf,
  recordOpening,
  type Account,
  type State,
  type Work,
} from "./state.ts";

/** The key id of every fake receipt: unsigned, never a real key. */
export const FAKE_KEY_ID = "lazni-kljuc-nepotpisano";
/** 64 zero bytes as base64url: a signature that verifies under no key. */
export const FAKE_SIGNATURE = "A".repeat(86);
const FAKE_DOMAIN = "00000000-0000-4000-8000-00000000fa4e";
const PROFILE = "lazni-profil";

/** A public Ed25519 key with no private half kept: nothing the fake answers is signed by it. */
const FAKE_PUBLIC_KEY = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64url");

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const minute = (now: Date): string => `${now.toISOString().slice(0, 16)}:00.000Z`;
/** An instant in the receipt form: UTC with exactly six fraction digits. */
const microsecond = (iso: string): string => `${new Date(iso).toISOString().slice(0, 23)}000Z`;
/** Segments per replay page (MAX_REPLAY_PAGE_SEGMENTS of the contract). */
export const REPLAY_PAGE = 256;
const signature = {
  algorithm: "Ed25519",
  keyId: FAKE_KEY_ID,
  keyVersion: "0",
  signatureEncoding: "raw",
} as const;

function ownWork(state: State, account: Account | null, documentId: string): Work | undefined {
  return state.works.find((w) => w.documentId === documentId && w.studentId === account?.id);
}

/** The work state a 409 sends back so the author can reconcile. */
const workState = (work: Work) => ({
  currentRevision: work.revision,
  documentHash: sha256(Buffer.from(work.document, "base64")),
  headSegmentHash: work.segments.length === 0 ? null : sha256(work.segments.at(-1) ?? ""),
  lastSequenceTo: work.lastSequenceTo,
});

export const EVIDENCE_HANDLERS: Handlers = {
  "evidence.open.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthenticated" };
    const assignmentId = body.assignmentId.toLowerCase();
    const assignment = state.assignments.find((a) => a.id === assignmentId);
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || !course?.studentIds.includes(account.id))
      return { error: "not_found" };
    let work = state.works.find(
      (w) => w.assignmentId === assignmentId && w.studentId === account.id,
    );
    if (work === undefined) {
      if (body.start !== true) return { error: "not_started" };
      // PRODUCT §5: the notice comes before the work.
      if (assignment.acknowledged.get(account.id)?.version !== assignment.version)
        return { error: "forbidden" };
      work = {
        documentId: randomUUID(),
        assignmentId,
        studentId: account.id,
        state: "in_progress",
        revision: 0,
        lastChangeAt: now.toISOString(),
        submittedAt: null,
        document: EMPTY_DOCUMENT,
        segments: [],
        lastSequenceTo: 0,
        transactions: new Map(),
        live: null,
      };
      state.works.push(work);
    }
    return {
      status: 200,
      body: {
        status: "opened",
        documentId: work.documentId,
        evidenceProfileId: PROFILE,
        ...workState(work),
        document: work.document,
        receiptKeys: [
          {
            algorithm: "Ed25519",
            keyId: FAKE_KEY_ID,
            keyVersion: "0",
            encoding: "spki-der",
            keyBase64Url: FAKE_PUBLIC_KEY,
            evidenceDomainId: FAKE_DOMAIN,
            purpose: "receipt",
            validFrom: "2026-01-01T00:00:00.000Z",
            validTo: null,
            revokedAt: null,
          },
        ],
        submitted: work.state === "submitted",
      },
    };
  },
  "evidence.commit.post": ({ state, account, body, now, header }) => {
    const work = ownWork(state, account, body.documentId);
    if (work === undefined || account === null) return { error: "not_found" };
    if (work.state === "submitted") return { error: "not_accepting" };
    const done = work.transactions.get(body.clientTransactionId);
    if (done !== undefined && done !== body.baseRevision + 1) return { error: "txid_reused" };
    if (done === undefined && body.baseRevision !== work.revision)
      return { error: "stale_base", body: { status: "stale_base", ...workState(work) } };
    const segment = Buffer.from(body.segments[0] ?? "", "base64").toString("utf8");
    const predecessor = work.segments.length === 0 ? null : sha256(work.segments.at(-1) ?? "");
    if (done === undefined) {
      work.segments.push(segment);
      work.revision += 1;
      work.document = body.document;
      work.lastSequenceTo += 1;
      work.lastChangeAt = now.toISOString();
      work.transactions.set(body.clientTransactionId, work.revision);
    }
    const status = done === undefined ? "committed" : "duplicate";
    const revision = done ?? work.revision;
    if (header("ductus-protocol") === "2")
      return {
        status: 202,
        headers: { "retry-after": "2" },
        body: { status, revision, receipt: { status: "pending_signature" } },
      };
    const payload = {
      receiptSchema: "ductus-evidence-receipt-v2",
      receiptId: `lazna-potvrda-${work.documentId}-${revision}`,
      evidencePackageId: `lazni-paket-${work.documentId}`,
      documentId: work.documentId,
      sessionId: "lazna-sesija",
      segmentId: `lazni-odsjecak-${revision}`,
      segmentHash: sha256(segment),
      predecessorSegmentHash: done === undefined ? predecessor : null,
      previousReceiptId: revision > 1 ? `lazna-potvrda-${work.documentId}-${revision - 1}` : null,
      evidenceSchema: "ductus-evidence-segment-v2",
      evidenceProfileId: PROFILE,
      sequenceFrom: revision,
      sequenceTo: revision,
      eventCount: 1,
      payloadBytes: Math.max(1, Buffer.byteLength(segment)),
      acceptedAt: minute(now),
      revision: Math.max(1, revision),
      clientTransactionId: body.clientTransactionId,
      evidenceDomainId: FAKE_DOMAIN,
      principalId: account.id,
    } as const;
    return {
      status: 200,
      body: {
        status,
        revision,
        receipt: {
          status: "signed",
          signedReceipt: {
            payload,
            payloadDigestSha256: sha256(JSON.stringify(payload)),
            signature: { ...signature, signatureBase64Url: FAKE_SIGNATURE },
          },
        },
      },
    };
  },
  "evidence.replay.post": ({ state, account, body, now }) => {
    const work = state.works.find((w) => w.documentId === body.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null || account === null) return { error: "not_found" };
    const head =
      work.segments.length === 0
        ? null
        : { segmentHash: sha256(work.segments.at(-1) ?? ""), segmentCount: work.segments.length };
    if ("head" in body && body.head.segmentHash !== head?.segmentHash)
      return { error: "record_changed" };
    if (reader === "teacher")
      recordOpening(
        state,
        { documentId: work.documentId, readerId: account.id, role: "teacher", surface: "replay" },
        now,
      );
    return {
      status: 200,
      body: {
        replayFormat: "ductus-evidence-replay-v1",
        segmentCount: work.segments.length,
        head,
        from: body.from,
        next: body.from + REPLAY_PAGE < work.segments.length ? body.from + REPLAY_PAGE : null,
        startDocument:
          head === null ? null : Buffer.from(EMPTY_DOCUMENT, "base64").toString("utf8"),
        segments: work.segments.slice(body.from, body.from + REPLAY_PAGE),
        resumeDocuments: {},
      },
    };
  },
  "submission.submit.post": ({ state, account, body, now }) => {
    const work = ownWork(state, account, body.documentId);
    const assignment = state.assignments.find((a) => a.id === work?.assignmentId);
    if (work === undefined || assignment === undefined || account === null)
      return { error: "not_found" };
    if (work.submittedAt !== null)
      return {
        error: "already_requested",
        body: { status: "already_requested", revision: work.revision },
      };
    if (assignment.acknowledged.get(account.id)?.version !== assignment.version)
      return { error: "not_acknowledged" };
    if (now.toISOString() < assignment.content.opensAt) return { error: "not_open" };
    if (body.revision !== work.revision)
      return {
        error: "stale_revision",
        body: { status: "stale_revision", currentRevision: work.revision },
      };
    if (work.segments.length === 0)
      return { error: "blocked", body: { status: "blocked", reason: "no_evidence" } };
    const requestedAt = now.toISOString();
    work.state = "submitted";
    work.submittedAt = requestedAt;
    // After the submission the live view serves the submitted revision's bytes.
    work.live = {
      json: Buffer.from(work.document, "base64").toString("utf8"),
      token: randomUUID(),
    };
    const payload = {
      receiptSchema: "ductus-submission-receipt-v2",
      submissionId: randomUUID(),
      evidenceDomainId: FAKE_DOMAIN,
      principalId: account.id,
      assignmentId: assignment.id,
      assignmentVersion: assignment.version,
      documentId: work.documentId,
      evidencePackageId: "lazni-paket",
      revision: work.revision,
      artifactSha256: sha256(Buffer.from(work.document, "base64")),
      evidenceHeadSegmentHash: sha256(work.segments.at(-1) ?? ""),
      evidenceRecord: "continuous",
      requestedAt: microsecond(requestedAt),
      dueAt: microsecond(assignment.content.dueAt),
      afterDeadline: requestedAt > assignment.content.dueAt,
      signedAt: microsecond(requestedAt),
    } as const;
    return {
      status: 200,
      body: {
        status: "submitted",
        receipt: {
          payload,
          payloadDigestSha256: sha256(JSON.stringify(payload)),
          signature: { ...signature, signatureBase64Url: FAKE_SIGNATURE },
        },
      },
    };
  },
};
