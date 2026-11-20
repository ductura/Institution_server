// The Ductus evidence entry points the copied database tests call, each read
// through the Ductura port that replaced it. Only the call is mapped; every
// outcome is the one Ductura's own route gets.
// - createEvidencePayloadReader (Ductus src/server/evidence/payload-reader.ts):
//   the storage evidenceIngestDependencies makes for the commit and replay
//   routes (server/http/evidence-deps.ts, the port of that file).
// - createEvidenceReceiptSigner (Ductus src/server/evidence/receipt-signer.ts):
//   the persistent development key Ductura signs with under NODE_ENV test; its
//   calls answer a Result (server/external/keys/signing-key-provider.ts).
// - commitEvidenceRequest (Ductus src/server/evidence/evidence-commit-request.ts):
//   createEvidenceService over createEvidenceCommitter, as
//   createEvidenceCommitRouteFor builds it.
// - readEvidenceCommitContext (Ductus src/server/evidence/evidence-commit.ts):
//   createCommitContextReader, the reader the committer itself uses.
import { fileURLToPath } from "node:url";

import { createCommitContextReader } from "../../../server/database/commit-context.ts";
import {
  createEvidenceCommitter,
  type ReceiptSigner,
} from "../../../server/database/commit-evidence.ts";
import type { WithActor } from "../../../server/database/with-actor.ts";
import {
  createEvidenceService,
  type EvidenceCommitDependencies,
  type EvidenceCommitRequest,
} from "../../../server/evidence/service.ts";
import { PersistentDevelopmentEd25519SigningKeyProvider } from "../../../server/external/keys/persistent-development-ed25519-signer.ts";
import { evidenceIngestDependencies } from "../../../server/http/evidence-deps.ts";

type Env = Readonly<Record<string, string | undefined>>;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function createEvidencePayloadReader(env: Env) {
  return evidenceIngestDependencies(env, ROOT).payloads;
}

export function createEvidenceReceiptSigner(env: Env, repositoryRoot: string) {
  return new PersistentDevelopmentEd25519SigningKeyProvider(env, repositoryRoot);
}

export function commitEvidenceRequest(
  deps: {
    withActor: WithActor;
    signer: ReceiptSigner;
    payloads: EvidenceCommitDependencies["payloads"];
  },
  token: string,
  request: EvidenceCommitRequest,
) {
  const committer = createEvidenceCommitter(deps.withActor, deps.signer);
  return createEvidenceService({ committer, payloads: deps.payloads }).commit(token, request);
}

export function readEvidenceCommitContext(
  withActor: WithActor,
  token: string,
  documentId: string,
  clientTransactionId: string,
) {
  return createCommitContextReader(withActor).readContext(token, documentId, clientTransactionId);
}
