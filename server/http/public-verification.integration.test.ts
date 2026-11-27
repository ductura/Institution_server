// SRV-9B (✓ C-6): POST /api/v1/public/verification over a real server and a
// fake read. Every id, hash and key here is invented; the read answers
// no_match, so the signature path stays in server/public-verification's tests.
import { createPrivateKey, sign } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";
import {
  digestSubmissionReceiptPayloadV2,
  type SubmissionReceiptPayloadV2,
} from "../domain/index.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";

import {
  createPublicVerificationRouteFor,
  createPublicVerificationRoutesFor,
  PUBLIC_VERIFICATION_PER_MINUTE,
  publicVerificationLimiter,
} from "./public-verification.ts";

const ORIGIN = "https://ductura.example.invalid";
const BODY = {
  submissionId: "00000000-0000-4000-8000-00000000c0de",
  artifactSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
};
const NO_MATCH_ROW = { outcome: "no_match" };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
});

async function open(rows: unknown[] | Error = [NO_MATCH_ROW], perMinute?: number) {
  const tokens: (string | null | undefined)[] = [];
  const withActor: WithActor = async (token, transact) => {
    tokens.push(token);
    return transact({
      query: async () => {
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length };
      },
    } as unknown as ActorTransaction);
  };
  let clock = 0;
  const limiter =
    perMinute === undefined ? publicVerificationLimiter() : publicVerificationLimiter(() => clock);
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createPublicVerificationRouteFor({ withActor }, limiter)],
  });
  const send = (body: unknown = BODY, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${running?.port}/api/v1/public/verification`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { send, tokens, tick: (ms: number) => (clock += ms) };
}

describe("POST /api/v1/public/verification", () => {
  it("answers match false without a login, and sets no cookie", async () => {
    const { send, tokens } = await open();
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ match: false });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toEqual([null]);
  });

  it("never passes the session cookie on to the database (D-09)", async () => {
    const { send, tokens } = await open();
    const response = await send(BODY, { cookie: `__Host-ductus_session=${"T".repeat(43)}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(tokens).toEqual([null]);
  });

  it.each([
    ["an upper-case id", { ...BODY, submissionId: BODY.submissionId.toUpperCase() }],
    ["a short hash", { ...BODY, artifactSha256: BODY.artifactSha256.slice(1) }],
    ["an unknown field", { ...BODY, email: "student@example.invalid" }],
    ["a missing hash", { submissionId: BODY.submissionId }],
  ])("refuses %s as 422 without a read", async (_name, body) => {
    const { send, tokens } = await open();
    const response = await send(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(tokens).toEqual([]);
  });

  it("refuses broken JSON as 400 and another media type as 415", async () => {
    const { send } = await open();
    expect((await send("{")).status).toBe(400);
    expect((await send(BODY, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("answers 503 when the read fails", async () => {
    const { send } = await open(new Error("connection refused"));
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "unavailable" });
  });

  it("limits one address, then lets it through after Retry-After", async () => {
    const { send, tokens, tick } = await open([NO_MATCH_ROW], PUBLIC_VERIFICATION_PER_MINUTE);
    for (let i = 0; i < PUBLIC_VERIFICATION_PER_MINUTE; i += 1) {
      expect((await send()).status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    const wait = Number(limited.headers.get("retry-after"));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(tokens).toHaveLength(PUBLIC_VERIFICATION_PER_MINUTE);
    tick(wait * 1000);
    expect((await send()).status).toBe(200);
  });
});

// DIZAJN-27-11 1.1 (3): POST /api/v1/public/verification/code beside the pair
// route, both over one limiter as server.ts mounts them. The receipt is
// invented and signed with the public RFC 8032 test vector 1, never a deployed key.
const CODE = "DK7M-4Q9P-X2HT-R8VN";
const payload: SubmissionReceiptPayloadV2 = {
  receiptSchema: "ductus-submission-receipt-v2",
  signedAt: "2026-11-20T10:59:00.654321Z",
  submissionId: "c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69",
  principalId: "72cd1705-85fc-4754-a382-c2500d038368",
  evidenceDomainId: "d21fe0a3-103c-42e5-a29e-c102f9030af5",
  assignmentId: "3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91",
  assignmentVersion: 1,
  documentId: "doc-1",
  evidencePackageId: "evidence-1",
  revision: 7,
  artifactSha256: "b".repeat(64),
  evidenceHeadSegmentHash: "a".repeat(64),
  evidenceRecord: "continuous",
  requestedAt: "2026-11-20T10:58:00.123456Z",
  dueAt: "2026-11-20T11:00:00.000000Z",
  afterDeadline: false,
};

async function matchRow() {
  const key = createPrivateKey({
    key: Buffer.from(
      "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  });
  const digest = await digestSubmissionReceiptPayloadV2(payload);
  return {
    outcome: "match",
    submissionId: payload.submissionId,
    artifactSha256: payload.artifactSha256,
    payload: JSON.stringify(payload),
    digest: digest.sha256,
    signature: {
      algorithm: "Ed25519",
      keyId: "izmisljeni-kljuc",
      keyVersion: "1",
      signatureEncoding: "raw",
      signatureBase64Url: sign(null, Buffer.from(digest.signingInput), key).toString("base64url"),
    },
    keyBase64Url: Buffer.from(
      "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    ).toString("base64url"),
    domain: payload.evidenceDomainId,
    purpose: "receipt",
    validFrom: "2026-11-19T00:00:00.000Z",
    validTo: null,
    revokedAt: null,
  };
}

async function openBoth(rows: unknown[]) {
  const reads: { token: string | null | undefined; values: unknown }[] = [];
  const withActor: WithActor = async (token, transact) =>
    transact({
      query: async (_text: string, values: unknown) => {
        reads.push({ token, values });
        return { rows, rowCount: rows.length };
      },
    } as unknown as ActorTransaction);
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createPublicVerificationRoutesFor(
      { withActor },
      publicVerificationLimiter(() => 0),
    ),
  });
  const send = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${running?.port}/api/v1/public/verification${path}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { send, reads };
}

describe("POST /api/v1/public/verification/code", () => {
  it("answers match for the code of a bound receipt, without a login", async () => {
    const { send, reads } = await openBoth([await matchRow()]);
    const response = await send("/code", { code: CODE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      match: true,
      submittedAt: payload.requestedAt,
      signedAt: payload.signedAt,
      keyId: "izmisljeni-kljuc",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(reads).toEqual([{ token: null, values: [CODE] }]);
  });

  it("answers the bare match false for an unknown code", async () => {
    const { send } = await openBoth([NO_MATCH_ROW]);
    const response = await send("/code", { code: CODE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ match: false });
  });

  it("refuses a malformed code as 422 without a read", async () => {
    const { send, reads } = await openBoth([NO_MATCH_ROW]);
    for (const code of ["dk7m-4q9p-x2ht-r8vn", "DK7M-4Q9P-X2HT-R8VU", "DK7M-4Q9P"]) {
      expect((await send("/code", { code })).status).toBe(422);
    }
    expect(reads).toEqual([]);
  });

  it("counts checks by code and by pair against one limit per address", async () => {
    const { send, reads } = await openBoth([NO_MATCH_ROW]);
    const half = PUBLIC_VERIFICATION_PER_MINUTE / 2;
    for (let i = 0; i < half; i += 1) {
      expect((await send("", BODY)).status).toBe(200);
      expect((await send("/code", { code: CODE })).status).toBe(200);
    }
    expect((await send("/code", { code: CODE })).status).toBe(429);
    expect((await send("", BODY)).status).toBe(429);
    expect(reads).toHaveLength(PUBLIC_VERIFICATION_PER_MINUTE);
  });
});
