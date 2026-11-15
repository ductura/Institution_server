import { Type, type TSchema } from "@sinclair/typebox";

import { closed, defineRoute, type ErrorSpec } from "../schema/index.ts";

// Port of Ductus src/server/evidence/{open,commit}-route.ts and ingest-http.ts at
// d52a92c3 (docs/BACKEND.md 4.13). These two routes answer every refusal as
// {status: <code>}, not {error: <code>}: the browser client of that revision
// (src/client/evidence-ingest.ts) reads `status`, so the shape is kept.

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Standard base64 with padding; the route also asks that it encodes back to the same text. */
const Base64 = Type.String({
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});
/** A whole UTC minute, the form of acceptedAt (D-24). */
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
/** A canonical lowercase UUID v4: evidence domain and principal ids in a receipt. */
const UuidV4 = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const Algorithm = Type.Union([
  Type.Literal("Ed25519"),
  Type.Literal("ECDSA_P256_SHA256"),
  Type.Literal("RSA_PSS_SHA256"),
]);

/** Ductus MAX_COMMIT_REQUEST_BYTES: one segment and one snapshot in base64, plus the envelope. */
export const MAX_COMMIT_BODY_BYTES = 5_596_504;

/** A public receipt key of the work's evidence domain (EvidenceDomainKey). */
const ReceiptKey = closed({
  algorithm: Algorithm,
  keyId: Text(2048),
  keyVersion: Text(256),
  encoding: Type.Literal("spki-der"),
  keyBase64Url: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 4096 }),
  evidenceDomainId: UuidV4,
  purpose: Type.Literal("receipt"),
  validFrom: Minute,
  validTo: Type.Union([Minute, Type.Null()]),
  revokedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

/** SignedEvidenceReceiptV2 (server/domain/forensics/evidence-receipt.ts). */
const SignedReceipt = closed({
  payload: closed({
    receiptSchema: Type.Literal("ductus-evidence-receipt-v2"),
    receiptId: Text(256),
    evidencePackageId: Text(256),
    documentId: Text(256),
    sessionId: Text(256),
    segmentId: Text(256),
    segmentHash: Sha256,
    predecessorSegmentHash: Type.Union([Sha256, Type.Null()]),
    previousReceiptId: Type.Union([Text(256), Type.Null()]),
    evidenceSchema: Type.Union([
      Type.Literal("ductus-evidence-segment-v2"),
      Type.Literal("ductus-evidence-segment-v3"),
      Type.Literal("ductus-evidence-segment-v4"),
    ]),
    evidenceProfileId: Text(120),
    sequenceFrom: Count,
    sequenceTo: Count,
    eventCount: Count,
    payloadBytes: Count,
    acceptedAt: Minute,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    clientTransactionId: Text(128),
    evidenceDomainId: UuidV4,
    principalId: UuidV4,
  }),
  payloadDigestSha256: Sha256,
  signature: closed({
    algorithm: Algorithm,
    keyId: Text(2048),
    keyVersion: Text(256),
    signatureEncoding: Type.Union([
      Type.Literal("raw"),
      Type.Literal("ieee-p1363"),
      Type.Literal("der"),
    ]),
    signatureBase64Url: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 4096 }),
  }),
});

/** The work's state, sent with every 409 that asks the author to reconcile. */
const WorkState = {
  currentRevision: Count,
  documentHash: Sha256,
  headSegmentHash: Type.Union([Sha256, Type.Null()]),
  lastSequenceTo: Count,
};

function refusal(status: number, code: string, extra: Record<string, TSchema> = {}): ErrorSpec {
  return {
    status,
    code,
    key: `errors.${code}`,
    body: closed({ status: Type.Literal(code), ...extra }),
  };
}

/** 503 with the closed stage that failed, and `retry-after: 5`. */
function unavailable(stages: readonly string[]): ErrorSpec {
  const stage = stages.map((s) => Type.Literal(s));
  return refusal(503, "unavailable", {
    stage: stage.length === 1 ? (stage[0] as TSchema) : Type.Union(stage),
  });
}

// readGuardedBody: method and Origin, protocol, media type, cookie, then the body under limits.
const GUARD_ERRORS = [
  refusal(403, "forbidden"),
  refusal(426, "upgrade_required"),
  refusal(415, "unsupported_media_type"),
  refusal(401, "unauthenticated"),
  refusal(413, "too_large"),
  refusal(408, "timeout"),
  refusal(400, "bad_request"),
  refusal(422, "invalid"),
  refusal(404, "not_found"),
  refusal(409, "not_accepting"),
] as const;

export const open = defineRoute({
  id: "evidence.open.post",
  method: "POST",
  path: "/api/v1/evidence/open",
  inventory: "app/api/evidence/open/route.ts",
  access: "student",
  summary:
    "The caller's own work for one assignment and its current revision; `start: true` makes it. " +
    "Same Origin, `ductus-protocol: 1`; anyone but the student gets 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({
      assignmentId: Type.String({
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      }),
      start: Type.Optional(Type.Boolean()),
    }),
  },
  responses: [
    {
      status: 200,
      description: "opened",
      body: closed({
        status: Type.Literal("opened"),
        documentId: Type.String({ minLength: 1 }),
        evidenceProfileId: Text(120),
        ...WorkState,
        /** Exact JCS bytes of the snapshot of currentRevision. */
        document: Base64,
        /** Keys of exactly one evidence domain; a receipt verifies only under these. */
        receiptKeys: Type.Array(ReceiptKey, { minItems: 1 }),
        submitted: Type.Boolean(),
      }),
    },
  ],
  errors: [...GUARD_ERRORS, refusal(409, "not_started"), unavailable(["context"])],
});

const Accepted = Type.Union([Type.Literal("committed"), Type.Literal("duplicate")]);

export const commit = defineRoute({
  id: "evidence.commit.post",
  method: "POST",
  path: "/api/v1/evidence/commit",
  inventory: "app/api/evidence/commit/route.ts",
  access: "student_owner",
  summary:
    "One evidence segment and the document after it. Same Origin, `ductus-protocol: 1` (signed " +
    "now, 200) or `2` (signed by the worker: 202 pending_signature, then the same request again).",
  request: {
    contentType: "application/json",
    maxBodyBytes: MAX_COMMIT_BODY_BYTES,
    body: closed({
      documentId: Type.String(),
      clientTransactionId: Text(128),
      baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
      segments: Type.Array(Base64, { minItems: 1, maxItems: 1 }),
      document: Base64,
    }),
  },
  responses: [
    {
      status: 200,
      description: "stored and signed",
      body: closed({
        status: Accepted,
        revision: Count,
        receipt: closed({ status: Type.Literal("signed"), signedReceipt: SignedReceipt }),
      }),
    },
    {
      status: 202,
      description: "stored, receipt pending_signature (protocol 2 only); not an acknowledgement",
      headers: ["retry-after"],
      body: closed({
        status: Accepted,
        revision: Count,
        receipt: closed({ status: Type.Literal("pending_signature") }),
      }),
    },
  ],
  errors: [
    ...GUARD_ERRORS,
    refusal(409, "stale_base", WorkState),
    refusal(409, "chain_conflict", WorkState),
    refusal(409, "not_continuous", WorkState),
    refusal(409, "txid_reused"),
    refusal(422, "document_mismatch"),
    unavailable(["context", "storage", "repository", "signing"]),
  ],
});

export const evidenceRoutes = [open, commit] as const;
