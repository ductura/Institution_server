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
  awsKmsSigningKeyProvider,
  type KmsClientFactory,
  PersistentDevelopmentEd25519SigningKeyProvider,
  type SigningKeyProvider,
} from "../external/keys/index.ts";
import { kmsProblems, kmsSettings } from "../settings/index.ts";

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

/** A signer that never signs: the commit answers 503 signing and keeps nothing. */
export const REFUSING_SIGNER: Pick<SigningKeyProvider, "sign"> = Object.freeze({
  sign: () => Promise.reject(new Error("signing_key_unavailable")),
});

function signerOf(
  env: Env,
  repositoryRoot: string,
  kmsClient: KmsClientFactory | undefined,
): Pick<SigningKeyProvider, "sign"> {
  // DAN-963: a KMS configuration selects the KMS signer in every NODE_ENV; an
  // incomplete one (which also stops the start) is no signer, never a quiet
  // fall back to the development key.
  if (kmsProblems(env).length > 0) return REFUSING_SIGNER;
  try {
    const kms = kmsSettings(env);
    if (kms !== null) return awsKmsSigningKeyProvider(kms, kmsClient);
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
 * The signer and storage of this process; `repositoryRoot` is where the server
 * runs from. `kmsClient` replaces the SDK's KMS client, for tests only.
 */
export function evidenceIngestDependencies(
  env: Env,
  repositoryRoot: string,
  options: { readonly kmsClient?: KmsClientFactory } = {},
): EvidenceIngestDependencies {
  // A copy, as Ductus handed over: later changes of the process environment change nothing.
  const own: Env = { ...env };
  // Only the process's own value: Ductus read env.X === "1", which an
  // inherited value (or a polluted Object.prototype) would also satisfy.
  const asyncSigning = Object.hasOwn(own, ASYNC_SIGNING_FLAG) && own[ASYNC_SIGNING_FLAG] === "1";
  return {
    signer: signerOf(own, repositoryRoot, options.kmsClient),
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
