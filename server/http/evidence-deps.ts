// The signer and the storage of the commit route, made from the environment
// once per process (DAN-815 c). Port of Ductus
// src/server/evidence/{receipt-signer,payload-reader,ingest-deps}.ts at
// d52a92c3, without a change of logic: the development signer only under
// NODE_ENV development or test (F-020; the adapter refuses otherwise), a
// refusing signer in every other case (503 signing), and the storage of
// EVIDENCE_STORAGE_DOMAINS or none at all (503 storage). There is no default
// or shared bucket and no fake in production. Protocol 2 is not read from the
// environment here (VS-1b).
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
  PersistentDevelopmentEd25519SigningKeyProvider,
  type SigningKeyProvider,
} from "../external/keys/index.ts";

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
};

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

function signerOf(env: Env, repositoryRoot: string): Pick<SigningKeyProvider, "sign"> {
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

/** The signer and storage of this process; `repositoryRoot` is where the server runs from. */
export function evidenceIngestDependencies(
  env: Env,
  repositoryRoot: string,
): EvidenceIngestDependencies {
  // A copy, as Ductus handed over: later changes of the process environment change nothing.
  const own: Env = { ...env };
  return { signer: signerOf(own, repositoryRoot), payloads: payloadsOf(own) };
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
