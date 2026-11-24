// The signer and the storage of the commit route, made from the environment
// once per process (DAN-815 c). Port of Ductus
// src/server/evidence/{receipt-signer,payload-reader,ingest-deps}.ts at
// d52a92c3, without a change of logic: the development signer only under
// NODE_ENV development or test (F-020; the adapter refuses otherwise), a
// refusing signer in every other case (503 signing), and the storage of
// EVIDENCE_STORAGE_DOMAINS or none at all (503 storage). There is no default
// or shared bucket and no fake in production. Protocol 2 (DAN-518, the
// worker signs) only under the process's own DUCTUS_EVIDENCE_ASYNC_SIGNING
// exactly "1" (DAN-821-3); off by default, so no unsigned acceptance.
// DAN-963: a complete DUCTUS_KMS_* configuration (server/settings/kms.ts)
// selects the AWS KMS signer in every NODE_ENV, over the official SDK client;
// any KMS variable that is not usable refuses (server.ts does not start), and
// never falls back to the development signer.
import { KMSClient } from "@aws-sdk/client-kms";

import { createEvidenceCommitter } from "../database/index.ts";
import { createEvidenceService } from "../evidence/index.ts";
import {
  type EvidencePayloadLocator,
  type EvidencePayloadStore,
  type InstitutionEvidencePayloadReader,
  InstitutionRoutedPayloadStore,
  loadEvidenceStorageConfig,
} from "../external/storage/index.ts";
import {
  AwsKmsEd25519SigningKeyProvider,
  AwsSdkKmsEd25519Transport,
  type KmsCommandSender,
  PersistentDevelopmentEd25519SigningKeyProvider,
  type SigningKeyProvider,
} from "../external/keys/index.ts";
import { kmsProblems, kmsSettings, type KmsSettings } from "../settings/index.ts";

import type { Databases } from "./databases.ts";
import { createEvidenceCommitRoute } from "./evidence-commit.ts";
import { createEvidenceReplayRoute } from "./evidence-replay.ts";
import type { Route } from "./router.ts";

type Env = Readonly<Record<string, string | undefined>>;
/** The storage of every institution: written by commit, read by replay (DAN-818). */
type Payloads = EvidencePayloadStore & EvidencePayloadLocator & InstitutionEvidencePayloadReader;

export type EvidenceIngestDependencies = {
  readonly signer: Pick<SigningKeyProvider, "sign">;
  readonly payloads: Payloads;
  /** Protocol 2 of the commit route: answered 202 and signed by the worker; absent is off. */
  readonly asyncSigning?: boolean;
};

/** The variable that turns protocol 2 on; only the exact value "1" does. */
export const ASYNC_SIGNING_FLAG = "DUCTUS_EVIDENCE_ASYNC_SIGNING";

const notConfigured = { status: "unavailable", reason: "storage_not_configured" } as const;
/** No storage domain: every write, name and read is unavailable, never a default bucket. */
export const STORAGE_NOT_CONFIGURED: Payloads = Object.freeze({
  putImmutable: async () => notConfigured,
  storageRefFor: async () => notConfigured,
  readImmutable: async () => notConfigured,
});

/**
 * A signer that never signs: the commit and the submission answer 503
 * signing and keep nothing.
 */
export const REFUSING_SIGNER: SigningKeyProvider = Object.freeze({
  sign: () => Promise.reject(new Error("signing_key_unavailable")),
  verify: () => Promise.reject(new Error("signing_key_unavailable")),
  publicVerificationKey: () => Promise.reject(new Error("signing_key_unavailable")),
});

/** The deadline of one KMS call (Sign, Verify, GetPublicKey); on expiry 503 signing. */
export const KMS_CALL_TIMEOUT_MS = 5_000;

/** Makes the KMS client of a complete configuration; tests hand in the fake KMS. */
export type KmsClientFactory = (settings: KmsSettings) => KmsCommandSender;

/**
 * The official SDK client in the configured region. Credentials come from the
 * SDK's default chain of the running host (role), never from this repository.
 */
const sdkKmsClient: KmsClientFactory = (settings) => new KMSClient({ region: settings.region });

export type EvidenceIngestOptions = {
  /** The KMS client of a complete configuration; absent is the SDK's own. */
  readonly kmsClient?: KmsClientFactory;
};

function kmsSignerOf(settings: KmsSettings, kmsClient: KmsClientFactory): SigningKeyProvider {
  const transport = new AwsSdkKmsEd25519Transport(kmsClient(settings), {
    timeoutMs: KMS_CALL_TIMEOUT_MS,
  });
  // The configured key ARN is the one trusted version (kms.ts takes no alias):
  // a signature of any other key neither signs nor verifies here.
  return new AwsKmsEd25519SigningKeyProvider(transport, settings.keyId, [settings.keyId]);
}

function signerOf(
  env: Env,
  repositoryRoot: string,
  options: EvidenceIngestOptions,
): SigningKeyProvider {
  const kms = kmsSettings(env);
  if (kms !== null) {
    try {
      return kmsSignerOf(kms, options.kmsClient ?? sdkKmsClient);
    } catch {
      // A client that cannot be made: no signature, and no development key instead.
      return REFUSING_SIGNER;
    }
  }
  // Some KMS variable is set but not usable: the server does not start
  // (server.ts, kmsProblems); here, too, it is never the development signer.
  if (kmsProblems(env).length > 0) return REFUSING_SIGNER;
  try {
    return new PersistentDevelopmentEd25519SigningKeyProvider(env, repositoryRoot);
  } catch {
    // signing_key_production or a fault of the seed path: no key, no signature.
    return REFUSING_SIGNER;
  }
}

function payloadsOf(env: Env): Payloads {
  // An allowlist, as for the signer (F-020): an unset, empty or misspelt
  // NODE_ENV counts as production. Ductus could read "!== production"
  // because next build fixed NODE_ENV; this server reads it at start. The
  // loader gets NODE_ENV production outside the allowlist too, so its own
  // production rules (no shared credentials, P9) hold for every such value.
  const nonProduction = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const configEnv: Env = nonProduction ? env : { ...env, NODE_ENV: "production" };
  try {
    return InstitutionRoutedPayloadStore.fromConfig(loadEvidenceStorageConfig(configEnv), {
      allowPlainHttpOnLoopback: nonProduction,
    });
  } catch {
    // The adapter's messages name no value; none is kept here either.
    return STORAGE_NOT_CONFIGURED;
  }
}

/**
 * The signer and storage of this process; `repositoryRoot` is where the
 * server runs from. The signer is the whole provider: a
 * submission (submission.ts, SRV-18) also reads its public key and checks
 * its signature; commit uses only `sign`.
 */
export function evidenceIngestDependencies(
  env: Env,
  repositoryRoot: string,
  options: EvidenceIngestOptions = {},
): EvidenceIngestDependencies & { readonly signer: SigningKeyProvider } {
  // A copy, as Ductus handed over: later changes of the process environment change nothing.
  const own: Env = { ...env };
  // Only the process's own value: Ductus read env.X === "1", which an
  // inherited value (or a polluted Object.prototype) would also satisfy.
  const asyncSigning = Object.hasOwn(own, ASYNC_SIGNING_FLAG) && own[ASYNC_SIGNING_FLAG] === "1";
  return {
    signer: signerOf(own, repositoryRoot, options),
    payloads: payloadsOf(own),
    asyncSigning,
  };
}

/** The commit route over the main database and this process's signer and storage. */
export function createEvidenceCommitRouteFor(
  main: Databases["main"],
  deps: EvidenceIngestDependencies,
): Route {
  const committer = createEvidenceCommitter(main.withActor, deps.signer);
  return createEvidenceCommitRoute({
    actorReader: main.actorReader,
    evidence: createEvidenceService({ committer, payloads: deps.payloads }),
    asyncSigning: deps.asyncSigning === true,
  });
}

/** The replay route over the main database and this process's storage (DAN-818). */
export function createEvidenceReplayRouteFor(
  main: Databases["main"],
  deps: Pick<EvidenceIngestDependencies, "payloads">,
): Route {
  return createEvidenceReplayRoute({
    actorReader: main.actorReader,
    withActor: main.withActor,
    payloads: deps.payloads,
  });
}
