// Fakes for the tests of server/deletion: an Ed25519 signer over node:crypto
// with an ephemeral key, an in-memory store with the contract of the
// storage port, and invented tombstones. No real key, bucket or person.
import { generateKeyPairSync, sign } from "node:crypto";
import type { PublicVerificationKey, Result, SignatureEnvelope } from "../domain/index.ts";
import type { EvidencePayloadPutResult, EvidencePayloadStore } from "../external/storage/index.ts";
import type { ErasureTombstone } from "./erasure-checkpoint.ts";
import type { ErasureCheckpointSigner } from "./service.ts";

export const INSTITUTION_A = "0f0e0d0c-0b0a-4908-8706-050403020100";
export const INSTITUTION_B = "1f1e1d1c-1b1a-4918-9716-151413121110";

export type FakeSigner = ErasureCheckpointSigner & { calls: number };

export function createFakeSigner(keyId = "deletion-test-key", keyVersion = "v1"): FakeSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const signer: FakeSigner = {
    calls: 0,
    async sign(message: Uint8Array): Promise<Result<SignatureEnvelope>> {
      signer.calls += 1;
      return {
        ok: true,
        value: {
          algorithm: "Ed25519",
          keyId,
          keyVersion,
          signatureEncoding: "raw",
          signatureBase64Url: sign(null, message, privateKey).toString("base64url"),
        },
      };
    },
    async publicVerificationKey(): Promise<Result<PublicVerificationKey>> {
      return {
        ok: true,
        value: {
          algorithm: "Ed25519",
          keyId,
          keyVersion,
          encoding: "spki-der",
          keyBase64Url: spki,
        },
      };
    },
  };
  return signer;
}

export type FakeStore = EvidencePayloadStore & {
  objects: Map<string, string>;
  answer: EvidencePayloadPutResult | null;
};

/** Content-addressed and never overwritten, as the storage port promises. */
export function createFakeStore(): FakeStore {
  const store: FakeStore = {
    objects: new Map(),
    answer: null,
    async putImmutable(input) {
      if (store.answer !== null) return store.answer;
      const key = `v2/${input.institutionId}/${input.evidencePackageId}/${input.segmentHash}.json`;
      const storageRef = `memory:${key}`;
      const existing = store.objects.get(key);
      if (existing !== undefined) {
        return existing === input.canonicalPayload
          ? { status: "existing", storageRef }
          : { status: "conflict" };
      }
      store.objects.set(key, input.canonicalPayload);
      return { status: "stored", storageRef };
    },
  };
  return store;
}

function hex(seed: number, length: number): string {
  let text = "";
  for (let index = 0; text.length < length; index += 1) {
    text += ((seed * 2654435761 + index * 40503) >>> 0).toString(16).padStart(8, "0");
  }
  return text.slice(0, length);
}

function uuid(seed: number): string {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An invented tombstone of `institutionId`; `seed` makes it distinct. */
export function tombstone(seed: number, institutionId = INSTITUTION_A): ErasureTombstone {
  const second = String(seed % 60).padStart(2, "0");
  return {
    id: uuid(seed + 1),
    institutionId,
    dataClass: "access_log",
    subjectId: uuid(seed + 100_000),
    contentSha256: hex(seed + 7, 64),
    reason: seed % 2 === 0 ? "retention_expired" : "erasure_request",
    jobId: seed % 3 === 0 ? null : uuid(seed + 200_000),
    erasedAt: `2026-11-20T10:00:${second}.${String(seed % 1_000_000).padStart(6, "0")}Z`,
  };
}
