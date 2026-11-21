// Fakes for the tests of the daily root (SRV-1311) and of the CLI
// scripts/evidence-verify: an Ed25519 signer over node:crypto with an
// ephemeral key, a store with the contract of the storage port and invented
// log entries. No real key, bucket, receipt or person.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { PublicVerificationKey, Result, SignatureEnvelope } from "../../domain/index.ts";
import type {
  EvidencePayloadPutResult,
  EvidencePayloadStore,
} from "../../external/storage/index.ts";
import type { DailyRootEntry } from "./daily-root.ts";
import type { DailyRootSigner } from "./job.ts";

export const INSTITUTION = "0f0e0d0c-0b0a-4908-8706-050403020100";
export const DAY = "2026-11-20";

export type FakeSigner = DailyRootSigner & {
  calls: number;
  publicKey: KeyObject;
  publicPem: string;
};

export function createFakeSigner(keyId = "daily-root-test-key"): FakeSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const signer: FakeSigner = {
    calls: 0,
    publicKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    async sign(message: Uint8Array): Promise<Result<SignatureEnvelope>> {
      signer.calls += 1;
      return {
        ok: true,
        value: {
          algorithm: "Ed25519",
          keyId,
          keyVersion: "v1",
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
          keyVersion: "v1",
          encoding: "spki-der",
          keyBase64Url: spki,
        },
      };
    },
  };
  return signer;
}

export type FakeStore = Pick<EvidencePayloadStore, "putImmutable"> & {
  objects: Map<string, string>;
  answer: EvidencePayloadPutResult | null;
};

/** Never overwritten, as the storage port promises: the same key with other bytes is a conflict. */
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

/** An invented entry: receipt `receipt-<n>` accepted `minute` minutes into `day`. */
export function entry(n: number, minute = n, day = DAY): DailyRootEntry {
  return {
    receiptId: `receipt-${n}`,
    acceptedAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + minute * 60_000).toISOString(),
    digest: createHash("sha256").update(`invented receipt ${n}`).digest("hex"),
  };
}

export function entries(count: number, day = DAY): DailyRootEntry[] {
  return Array.from({ length: count }, (_, n) => entry(n, n % 1440, day));
}
