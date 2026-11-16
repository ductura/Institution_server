// DAN-758 (U4-b): the contracts of evidence/open and evidence/commit, ported from
// Ductus d52a92c3, and the vectors the VS-1 path needs.
import { describe, expect, it } from "vitest";

import { answerFake, FAKE_VECTOR_HEADER, VECTORS } from "./generated/fake-server/index.ts";
import { validateInput } from "./generated/index.ts";
import { PENDING } from "./inventory.ts";
import { API_VERSION, MIN_CLIENT_VERSION, ROUTES } from "./index.ts";

const OPEN = "evidence.open.post";
const COMMIT = "evidence.commit.post";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const B64 = "e30=";
const ENVELOPE = {
  documentId: "00000000-0000-4000-8000-0000000000d1",
  clientTransactionId: "izmisljena-transakcija-0001",
  baseRevision: 0,
  segments: [B64],
  document: B64,
};

const vector = (route: string, name: string) => {
  const found = VECTORS.find((v) => v.route === route && v.name === name);
  if (found === undefined) throw new Error(`no vector ${route}/${name}`);
  return found;
};
const body = (route: string, name: string) => vector(route, name).response.body as never;

/** The vector's request as a client sends it, picked by name. */
function send(route: string, name: string) {
  const v = vector(route, name);
  const path = route === OPEN ? "/api/v1/evidence/open" : "/api/v1/evidence/commit";
  const text = v.request.rawBody ?? JSON.stringify(v.request.body);
  return answerFake({
    method: "POST",
    url: path,
    headers: { ...v.request.headers, [FAKE_VECTOR_HEADER]: name },
    body: new TextEncoder().encode(text),
  });
}

describe("evidence routes in the contract", () => {
  it("open, commit and replay have contracts (replay: DAN-818, not in DAN-758)", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([OPEN, COMMIT, "evidence.replay.post"]));
    expect(PENDING).not.toContain("app/api/evidence/open/route.ts");
    expect(PENDING).not.toContain("app/api/evidence/commit/route.ts");
    expect(PENDING).not.toContain("app/api/evidence/replay/route.ts");
    expect(PENDING).toHaveLength(1);
  });

  it.each(
    VECTORS.filter((v) => v.route === OPEN || v.route === COMMIT).map((v) => [v.route, v.name]),
  )("the fake server answers %s %s from its vector, never 501", (route, name) => {
    const answer = send(route, name);
    expect(answer.status).not.toBe(501);
    expect(answer.status).toBe(vector(route, name).response.status);
  });
});

describe("input validation: closed bodies", () => {
  it.each([
    ["the plain open", OPEN, { assignmentId: ASSIGNMENT }, true],
    ["open with start", OPEN, { assignmentId: ASSIGNMENT, start: true }, true],
    ["an unknown field", OPEN, { assignmentId: ASSIGNMENT, role: "teacher" }, false],
    ["start as text", OPEN, { assignmentId: ASSIGNMENT, start: "true" }, false],
    ["an assignment that is not a UUID", OPEN, { assignmentId: "a1" }, false],
    ["no assignment", OPEN, {}, false],
    ["the commit envelope", COMMIT, ENVELOPE, true],
    ["an unknown field", COMMIT, { ...ENVELOPE, actorId: "izmisljeni-0001" }, false],
    ["a gap field", COMMIT, { ...ENVELOPE, gap: true }, false],
    ["two segments", COMMIT, { ...ENVELOPE, segments: [B64, B64] }, false],
    ["no segment", COMMIT, { ...ENVELOPE, segments: [] }, false],
    ["a segment that is not base64", COMMIT, { ...ENVELOPE, segments: ["e30"] }, false],
    ["a document that is not base64", COMMIT, { ...ENVELOPE, document: "nije base64!" }, false],
    ["a negative base revision", COMMIT, { ...ENVELOPE, baseRevision: -1 }, false],
    ["a fractional base revision", COMMIT, { ...ENVELOPE, baseRevision: 0.5 }, false],
    ["a base revision as text", COMMIT, { ...ENVELOPE, baseRevision: "0" }, false],
    ["an empty transaction id", COMMIT, { ...ENVELOPE, clientTransactionId: "" }, false],
    ["a blank transaction id", COMMIT, { ...ENVELOPE, clientTransactionId: "   " }, false],
    ["a control character", COMMIT, { ...ENVELOPE, clientTransactionId: "tx\u0007-1" }, false],
    [
      "a transaction id with Croatian letters",
      COMMIT,
      { ...ENVELOPE, clientTransactionId: "tx-š-1" },
      true,
    ],
    [
      "a transaction id of 129",
      COMMIT,
      { ...ENVELOPE, clientTransactionId: "x".repeat(129) },
      false,
    ],
    ["a missing document", COMMIT, { ...ENVELOPE, document: undefined }, false],
  ])("%s (%s) -> %s", (_, route, value, valid) => {
    const input = JSON.parse(JSON.stringify(value)) as unknown;
    expect(validateInput(route, "body", input)).toBe(valid);
  });

  it("every vector refused as invalid has a body the contract refuses too", () => {
    for (const name of ["invalid-unknown-field", "invalid-start"]) {
      expect(validateInput(OPEN, "body", vector(OPEN, name).request.body)).toBe(false);
    }
    for (const name of ["invalid-unknown-field", "invalid-two-segments", "invalid-base64"]) {
      expect(validateInput(COMMIT, "body", vector(COMMIT, name).request.body)).toBe(false);
    }
  });
});

// The submission (Ductus 078c780 submission-route.ts): exactly {documentId, revision},
// a non-empty id and a whole revision from 0; anything else is 422 invalid.
const SUBMIT = "submission.submit.post";
const SUBMISSION = { documentId: "izmisljeni-rad-predaje-0001", revision: 7 };

describe("submission: closed body and receipt", () => {
  it.each([
    ["the plain submission", SUBMISSION, true],
    [
      "revision 0 (409 blocked no_evidence or stale_revision, never 422)",
      { ...SUBMISSION, revision: 0 },
      true,
    ],
    ["an unknown field", { ...SUBMISSION, submittedAt: "2026-12-20T21:00:00Z" }, false],
    ["a hash from the client", { ...SUBMISSION, artifactSha256: "a1".repeat(32) }, false],
    ["a negative revision", { ...SUBMISSION, revision: -1 }, false],
    ["a fractional revision", { ...SUBMISSION, revision: 0.5 }, false],
    ["a revision as text", { ...SUBMISSION, revision: "7" }, false],
    ["an empty document id", { ...SUBMISSION, documentId: "" }, false],
    ["no revision", { documentId: SUBMISSION.documentId }, false],
  ])("%s -> %s", (_, value, valid) => {
    expect(validateInput(SUBMIT, "body", JSON.parse(JSON.stringify(value)) as unknown)).toBe(valid);
  });

  it("every vector refused as invalid with a JSON body has a body the contract refuses too", () => {
    for (const name of ["invalid-unknown-field", "invalid-negative-revision"]) {
      expect(validateInput(SUBMIT, "body", vector(SUBMIT, name).request.body)).toBe(false);
    }
  });

  it("a receipt is after the deadline exactly when it was requested after it, and signed after the request", () => {
    for (const name of ["submitted", "submitted-after-deadline"]) {
      const { receipt } = body(SUBMIT, name) as {
        receipt: {
          payload: { requestedAt: string; dueAt: string; signedAt: string; afterDeadline: boolean };
        };
      };
      const p = receipt.payload;
      expect(p.afterDeadline).toBe(p.requestedAt > p.dueAt);
      expect(p.signedAt >= p.requestedAt).toBe(true);
    }
  });
});

describe("VS-1 path", () => {
  // Since 1.3.0 (S-1M-a, DAN-795) the API version is apiVersion; the 1.2.0
  // answer with `version` stays a valid vector, and that field is never newer.
  it("health carries the API version as apiVersion, and then it is API_VERSION", () => {
    const answer = body("platform.health.get", "alive-current") as Record<string, string>;
    expect(answer.apiVersion).toBe(API_VERSION);
    expect(answer.minClientVersion).toBe(MIN_CLIENT_VERSION);
    expect(answer.version).toBeUndefined();
    const old = body("platform.health.get", "alive-with-version") as { version: string };
    expect(old.version).toBe("1.2.0");
    expect(validateInput("platform.health.get", "query", {})).toBe(true);
  });

  it("another person's document is answered as one that does not exist", () => {
    const foreign = vector(COMMIT, "not-found-foreign-document");
    expect(foreign.request.body).toMatchObject({
      documentId: "dokument-tudji-izmisljeni-1",
    });
    expect(foreign.response).toMatchObject({ status: 404, body: { status: "not_found" } });
    expect(Object.keys(foreign.response.body as object)).toEqual(["status"]);
  });

  it("open after the commit reports the committed revision, hash and head", async () => {
    const committed = body(COMMIT, "committed") as {
      revision: number;
      receipt: { signedReceipt: { payload: { segmentHash: string; sequenceTo: number } } };
    };
    const reopened = body(OPEN, "opened-after-commit") as Record<string, unknown>;
    const sent = vector(COMMIT, "committed").request.body as { document: string };
    const bytes = Buffer.from(sent.document, "base64");
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    const { payload } = committed.receipt.signedReceipt;
    expect(reopened).toMatchObject({
      currentRevision: committed.revision,
      documentHash: hash,
      headSegmentHash: payload.segmentHash,
      lastSequenceTo: payload.sequenceTo,
      document: sent.document,
    });
  });

  it("202 pending_signature only under protocol 2, with retry-after and no receipt", () => {
    const pending = VECTORS.filter((v) => v.route === COMMIT && v.response.status === 202);
    expect(pending.map((v) => v.name)).toEqual([
      "committed-pending-signature",
      "duplicate-pending-signature",
    ]);
    for (const v of pending) {
      expect(v.request.headers?.["ductus-protocol"]).toBe("2");
      expect(v.response.headers?.["retry-after"]).toBe("2");
      expect(v.response.body).toMatchObject({ receipt: { status: "pending_signature" } });
    }
    const signed = VECTORS.filter((v) => v.route === COMMIT && v.response.status === 200);
    for (const v of signed) {
      expect(v.response.body).toMatchObject({ receipt: { status: "signed" } });
    }
  });
});
