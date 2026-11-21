import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestSubmissionReceiptPayloadV2,
  isSubmissionReceiptPayloadV2,
  type SubmissionReceiptPayloadV2,
} from "./submission-receipt-v2.ts";
import {
  digestSubmissionReceiptPayloadV3,
  isSignedSubmissionReceiptV3,
  isSubmissionReceiptPayloadV3,
  SUBMISSION_RECEIPT_V3_SIGNING_INPUT_BYTES,
  type SubmissionReceiptPayloadV3,
} from "./submission-receipt-v3.ts";
import { verifySignedSubmissionReceiptV2 } from "./submission-receipt-verifier-v2.ts";
import { verifySignedSubmissionReceiptV3 } from "./submission-receipt-verifier-v3.ts";

// Synthetic known answer, computed outside this module with Python json and
// hashlib, signed with OpenSSL; the payload is the v2 vector with the v3
// schema and the declaration hash of the declaration-v1 vector (section 9).
// Public RFC 8032 test vector 1 seed, never a deployed signing key.
const V2_CANONICAL =
  '{"afterDeadline":false,"artifactSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","assignmentId":"3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91","assignmentVersion":1,"documentId":"doc-1","dueAt":"2026-11-02T11:00:00.000000Z","evidenceDomainId":"d21fe0a3-103c-42e5-a29e-c102f9030af5","evidenceHeadSegmentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidencePackageId":"evidence-1","evidenceRecord":"continuous","principalId":"72cd1705-85fc-4754-a382-c2500d038368","receiptSchema":"ductus-submission-receipt-v2","requestedAt":"2026-11-02T10:58:00.123456Z","revision":7,"signedAt":"2026-11-02T10:59:00.654321Z","submissionId":"c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69"}';
const V2_DIGEST = "b8bed7b0129d597cbdd9903b020e2bdcff4c7b46cba8a4ac673b4126a6188408";
const DECLARATION_SHA256 = "f89129ae57b4451a03b41615f3dd1f35a6b7de2841a17535f2ce525c95870638";
const CANONICAL =
  '{"afterDeadline":false,"artifactSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","assignmentId":"3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91","assignmentVersion":1,"declarationSha256":"f89129ae57b4451a03b41615f3dd1f35a6b7de2841a17535f2ce525c95870638","documentId":"doc-1","dueAt":"2026-11-02T11:00:00.000000Z","evidenceDomainId":"d21fe0a3-103c-42e5-a29e-c102f9030af5","evidenceHeadSegmentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidencePackageId":"evidence-1","evidenceRecord":"continuous","principalId":"72cd1705-85fc-4754-a382-c2500d038368","receiptSchema":"ductus-submission-receipt-v3","requestedAt":"2026-11-02T10:58:00.123456Z","revision":7,"signedAt":"2026-11-02T10:59:00.654321Z","submissionId":"c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69"}';
const DIGEST = "08f4eec1e143610c2809b81d31ed1fac09249f02c1d1245a1bf656ee231812dd";
const INPUT =
  "6475637475732d7375626d697373696f6e2d726563656970742d76330a08f4eec1e143610c2809b81d31ed1fac09249f02c1d1245a1bf656ee231812dd";
const SIGNATURE =
  "95cb7de41446863e315637e895c764ba1b9ec6f531937237f9b93f766377f168857a38df0bfa3d7ea755bf0dc3ac50395bd9ac132ed06cd165407696a3451c07";
const NULL_CANONICAL = CANONICAL.replace(`"${DECLARATION_SHA256}"`, "null");
const NULL_DIGEST = "90166513f55205184dc640e328cac30477e58c36bb3a2403d4cd13b6e2f504ba";

const privateKey = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  type: "pkcs8",
  format: "der",
});
const publicKey = createPublicKey(privateKey);
const payload = JSON.parse(CANONICAL) as SubmissionReceiptPayloadV3;
const edit = (change: Record<string, unknown>) => ({ ...payload, ...change });
const signed = (p: SubmissionReceiptPayloadV3 = payload, digest = DIGEST, sig = SIGNATURE) => ({
  payload: structuredClone(p),
  payloadDigestSha256: digest,
  signature: {
    algorithm: "Ed25519" as const,
    keyId: "synthetic-test-key",
    keyVersion: "1",
    signatureEncoding: "raw" as const,
    signatureBase64Url: Buffer.from(sig, "hex").toString("base64url"),
  },
});
const key = {
  algorithm: "Ed25519" as const,
  keyId: "synthetic-test-key",
  keyVersion: "1",
  encoding: "spki-der" as const,
  keyBase64Url: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  evidenceDomainId: payload.evidenceDomainId,
  purpose: "receipt" as const,
  validFrom: "2026-11-02T10:59:00.000Z",
  validTo: "2026-11-02T11:00:00.000Z",
  revokedAt: null,
};
const expected = (change: Record<string, unknown> = {}) => {
  const { receiptSchema: unusedSchema, signedAt: unusedTime, ...rest } = payload;
  void unusedSchema;
  void unusedTime;
  return { ...rest, ...change };
};

describe("submission receipt v3: the declaration in the signed submission (declaration-v1 6.4 A)", () => {
  it("matches the independent canonical/digest/RAW61B/signature vector", async () => {
    const result = await digestSubmissionReceiptPayloadV3(payload);
    expect(result.canonical).toBe(CANONICAL);
    expect(result.sha256).toBe(DIGEST);
    expect(createHash("sha256").update(CANONICAL).digest("hex")).toBe(DIGEST);
    expect(Buffer.from(result.signingInput).toString("hex")).toBe(INPUT);
    expect(result.signingInput.byteLength).toBe(SUBMISSION_RECEIPT_V3_SIGNING_INPUT_BYTES);
    expect(sign(null, result.signingInput, privateKey).toString("hex")).toBe(SIGNATURE);
  });

  it("carries a null declaration hash as JSON null in the signed bytes (6.3)", async () => {
    const result = await digestSubmissionReceiptPayloadV3(
      edit({ declarationSha256: null }) as SubmissionReceiptPayloadV3,
    );
    expect(result.canonical).toBe(NULL_CANONICAL);
    expect(result.sha256).toBe(NULL_DIGEST);
  });

  it("leaves the v2 vector byte-equal", async () => {
    const v2 = JSON.parse(V2_CANONICAL) as SubmissionReceiptPayloadV2;
    const result = await digestSubmissionReceiptPayloadV2(v2);
    expect(result.canonical).toBe(V2_CANONICAL);
    expect(result.sha256).toBe(V2_DIGEST);
    expect(isSubmissionReceiptPayloadV3(v2)).toBe(false);
    expect(isSubmissionReceiptPayloadV2(payload)).toBe(false);
  });

  it("separates v3 from v2 and the bare digest", () => {
    const bytes = Buffer.from(SIGNATURE, "hex");
    for (const prefix of ["ductus-submission-receipt-v2", "ductus-submission-receipt-v1"])
      expect(
        verify(
          null,
          Buffer.concat([Buffer.from(prefix + "\n"), Buffer.from(DIGEST, "hex")]),
          publicKey,
          bytes,
        ),
      ).toBe(false);
    expect(verify(null, Buffer.from(DIGEST, "hex"), publicKey, bytes)).toBe(false);
    expect(verify(null, Buffer.from(INPUT, "hex"), publicKey, bytes)).toBe(true);
  });

  it("requires every one of the seventeen fields", () => {
    expect(Object.keys(payload)).toHaveLength(17);
    for (const name of Object.keys(payload)) {
      const missing = { ...payload } as Record<string, unknown>;
      delete missing[name];
      expect(isSubmissionReceiptPayloadV3(missing), name).toBe(false);
    }
  });

  it.each([
    "",
    "F89129AE57B4451A03B41615F3DD1F35A6B7DE2841A17535F2CE525C95870638",
    DECLARATION_SHA256.slice(1),
    DECLARATION_SHA256 + "0",
    0,
    false,
    {},
  ])("rejects declaration hash %s", async (declarationSha256) => {
    expect(isSubmissionReceiptPayloadV3(edit({ declarationSha256 }))).toBe(false);
    await expect(
      digestSubmissionReceiptPayloadV3(edit({ declarationSha256 }) as SubmissionReceiptPayloadV3),
    ).rejects.toThrow("not a v3 payload");
  });

  it("keeps the v2 field rules and refuses accessors without invoking them", () => {
    expect(
      isSubmissionReceiptPayloadV3(edit({ receiptSchema: "ductus-submission-receipt-v2" })),
    ).toBe(false);
    expect(isSubmissionReceiptPayloadV3(edit({ afterDeadline: true }))).toBe(false);
    expect(isSubmissionReceiptPayloadV3(edit({ signedAt: "2026-11-02T10:58:00.123455Z" }))).toBe(
      false,
    );
    expect(isSubmissionReceiptPayloadV3(edit({ extra: true }))).toBe(false);
    let calls = 0;
    const getter = Object.defineProperty({ ...payload }, "declarationSha256", {
      get: () => {
        calls++;
        return DECLARATION_SHA256;
      },
      enumerable: true,
    });
    expect(isSubmissionReceiptPayloadV3(getter)).toBe(false);
    expect(calls).toBe(0);
  });

  it("checks the signed envelope shape", () => {
    expect(isSignedSubmissionReceiptV3(signed())).toBe(true);
    expect(isSignedSubmissionReceiptV3({ ...signed(), extra: true })).toBe(false);
    expect(isSignedSubmissionReceiptV3({ ...signed(), payloadDigestSha256: "invalid" })).toBe(
      false,
    );
  });
});

describe("trusted submission receipt v3 verifier", () => {
  const check = (r: unknown = signed(), e: unknown = expected()) =>
    verifySignedSubmissionReceiptV3(r, e, [key]);

  it("verifies the independent known answer with a separately supplied key and declaration hash", async () => {
    expect(await check()).toEqual({ ok: true, payload });
  });

  it("refuses a receipt whose declaration is not the one the request pinned", async () => {
    expect(await check(signed(), expected({ declarationSha256: null }))).toEqual({
      ok: false,
      reason: "submission_mismatch",
    });
    expect(await check(signed(), expected({ declarationSha256: "e".repeat(64) }))).toEqual({
      ok: false,
      reason: "submission_mismatch",
    });
  });

  it("refuses a declaration hash swapped after signing", async () => {
    const swapped = signed(
      edit({ declarationSha256: null }) as SubmissionReceiptPayloadV3,
      NULL_DIGEST,
    );
    expect(await check(swapped, expected({ declarationSha256: null }))).toEqual({
      ok: false,
      reason: "signature_invalid",
    });
    const stale = signed(edit({ declarationSha256: null }) as SubmissionReceiptPayloadV3);
    expect(await check(stale, expected({ declarationSha256: null }))).toEqual({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("verifies a receipt without a declaration against a null expectation", async () => {
    const nullPayload = edit({ declarationSha256: null }) as SubmissionReceiptPayloadV3;
    const digest = await digestSubmissionReceiptPayloadV3(nullPayload);
    const receipt = signed(
      nullPayload,
      NULL_DIGEST,
      sign(null, digest.signingInput, privateKey).toString("hex"),
    );
    expect(await check(receipt, expected({ declarationSha256: null }))).toEqual({
      ok: true,
      payload: nullPayload,
    });
  });

  it("never accepts a v2 receipt as v3 or a v3 receipt as v2", async () => {
    expect(await check(signed(), { ...expected(), declarationSha256: undefined })).toEqual({
      ok: false,
      reason: "expectation_invalid",
    });
    const v2Expected = expected();
    delete (v2Expected as Record<string, unknown>).declarationSha256;
    expect(await verifySignedSubmissionReceiptV2(signed(), v2Expected, [key])).toEqual({
      ok: false,
      reason: "receipt_malformed",
    });
    const v2 = JSON.parse(V2_CANONICAL) as SubmissionReceiptPayloadV2;
    const v2Receipt = {
      ...signed(),
      payload: v2,
      payloadDigestSha256: V2_DIGEST,
    };
    expect(await check(v2Receipt)).toEqual({ ok: false, reason: "receipt_malformed" });
  });
});
