// POST /api/v1/submission (contract submission.submit.post; B-12 step 4b2,
// docs/BACKEND.md 4.6). Port of the HTTP edge of Ductus
// src/server/evidence/submission-route.ts at 078c780 (handleSubmissionRequest
// and submissionResponse): the guards of the evidence routes come before the
// body (readEvidenceBody: protocol 426, media type 415, cookie 401, body under
// 1 KiB and 5 s), the body is exactly {documentId, revision} (422 invalid),
// and the outcome of the submission goes onto the wire through one closed
// mapping: a status not named there is never a success. No time, document or
// hash comes from the client. The submission itself (Ductus submitWork: the
// request committed with the database clock, the reconstruction of that
// revision, record_submission with the reconstructed hash and the signed
// receipt v2) is the `submit` port; this edge never decides it.
//
// Mounted by server/server.ts (SRV-18, Ductus#2028): the port is Ductus
// submitWork in server/evidence/submission.ts, over main's withActor and the
// process's one signer and storage (evidence-deps.ts), the same the commit
// route writes with. The time of a submission is the database's clock.
//
// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 §6.7):
// while the assignment requires a declaration and none is confirmed for the
// submitted revision, the database refuses the request and nothing is written
// (declaration.pin_request, ZD428); submitWork answers declaration_required.
// The checked route (submission.submit-checked.post) puts it on the wire as
// 409 declaration_required. This route's contract has no answer for it (a new
// 409 branch breaks its clients, scripts/check-breaking.ts), so here it is
// 503 request: never a success (PRODUCT §5 rule 11).
import { ROUTES } from "../contracts/index.ts";
import type { ActorReader } from "../database/index.ts";
import { DUCTUS_PROTOCOL_VERSION, submitWork } from "../evidence/index.ts";
import type { SigningKeyProvider } from "../external/keys/index.ts";
import { recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import type { EvidenceIngestDependencies } from "./evidence-deps.ts";
import {
  type EvidenceAnswer,
  parseClosedObject,
  readEvidenceBody,
  sendEvidenceAnswer,
} from "./evidence-request.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

export const SUBMISSION_MAX_BYTES = 1024;
export const SUBMISSION_TIMEOUT_MS = 5_000;

/** The reasons a submission is blocked (Ductus SubmissionBlockReason). */
export type SubmissionBlockReason =
  "segment_unsigned" | "record_mismatch" | "record_discontinuous" | "no_evidence";
/** The stages of a submission that can be unavailable (Ductus SubmissionStage). */
export type SubmissionStage =
  "request" | "record" | "chain" | "storage" | "verification" | "submission" | "signing";

/** The outcome of Ductus submitWork, as the edge reads it. */
export type SubmissionOutcome =
  | { readonly status: "submitted"; readonly receipt: unknown }
  | { readonly status: "blocked"; readonly reason: SubmissionBlockReason }
  | { readonly status: "stale_revision"; readonly currentRevision: number }
  | { readonly status: "already_requested"; readonly revision: number }
  | {
      readonly status:
        | "not_acknowledged"
        | "not_open"
        | "not_found"
        | "unauthenticated"
        | "invalid"
        | "declaration_required";
    }
  | { readonly status: "unavailable"; readonly stage: SubmissionStage; readonly code: string };

export type SubmitWork = (
  token: string,
  input: { readonly documentId: string; readonly revision: number },
) => Promise<SubmissionOutcome>;

export type SubmissionRouteOptions = {
  readonly submit: SubmitWork;
  /** Asked only for the shape of the session here (live: false, as Ductus). */
  readonly actors: ActorReader;
  /** Session activity for a submission (Ductus counted). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
  /**
   * The checked route (submission.submit-checked.post), whose contract names
   * 409 declaration_required; without it, the route of submission.submit.post.
   */
  readonly checked?: boolean;
};

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}
const CONTRACT = contractOf("submission.submit.post");
const CHECKED_CONTRACT = contractOf("submission.submit-checked.post");

const unavailable = (stage: string): EvidenceAnswer => ({
  status: 503,
  body: { status: "unavailable", stage },
  headers: { "retry-after": "5" },
});

/**
 * The closed mapping onto the wire (Ductus submissionResponse); a status not
 * named here is never a success. Null is the 200 of a submission. A missing
 * required declaration is 409 only on the checked route, 503 request otherwise.
 */
export function submissionAnswer(
  outcome: SubmissionOutcome,
  checked = false,
): EvidenceAnswer | null {
  switch (outcome.status) {
    case "submitted":
      return null;
    case "blocked":
      return { status: 409, body: { status: "blocked", reason: outcome.reason } };
    case "stale_revision":
      return {
        status: 409,
        body: { status: "stale_revision", currentRevision: outcome.currentRevision },
      };
    case "already_requested":
      return { status: 409, body: { status: "already_requested", revision: outcome.revision } };
    case "not_acknowledged":
    case "not_open":
      return { status: 409, body: { status: outcome.status } };
    case "declaration_required":
      return checked
        ? { status: 409, body: { status: "declaration_required" } }
        : unavailable("request");
    case "not_found":
      return { status: 404, body: { status: "not_found" } };
    case "unauthenticated":
      return { status: 401, body: { status: "unauthenticated" } };
    case "invalid":
      return { status: 422, body: { status: "invalid" } };
    case "unavailable":
      return unavailable(outcome.stage);
    default:
      return unavailable("submission");
  }
}

export function createSubmissionRoute(options: SubmissionRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? SUBMISSION_TIMEOUT_MS;
  const checked = options.checked === true;
  const contract = checked ? CHECKED_CONTRACT : CONTRACT;
  return {
    contract,
    async handle(request, response) {
      const refuse = (answer: EvidenceAnswer) => sendEvidenceAnswer(response, contract, answer);
      const read = await readEvidenceBody(request, options.actors, {
        protocols: [DUCTUS_PROTOCOL_VERSION],
        maxBytes: SUBMISSION_MAX_BYTES,
        timeoutMs,
        live: false,
      });
      if (!read.ok) return refuse(read.answer);
      const body = parseClosedObject(read.bytes, ["documentId", "revision"]);
      const documentId = body?.documentId;
      const revision = body?.revision;
      if (
        typeof documentId !== "string" ||
        documentId === "" ||
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        // Revision 0 is a work with nothing saved: the database answers `no_evidence`.
        revision < 0
      ) {
        return refuse({ status: 422, body: { status: "invalid" } });
      }
      let outcome: SubmissionOutcome;
      try {
        outcome = await options.submit(read.token, { documentId, revision });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return refuse(unavailable("submission"));
      }
      const answer = submissionAnswer(outcome, checked);
      if (answer !== null) return refuse(answer);
      if (outcome.status === "submitted") {
        sendJson(response, 200, { status: "submitted", receipt: outcome.receipt });
        // Only a submission counts, once written; a failure costs only the touch.
        void options.recordActivity(read.token).catch(() => undefined);
      }
    },
  };
}

/**
 * The route over main's application withActor and actor reader, with Ductus
 * submitWork over this process's signer and payload storage (evidence-deps.ts).
 */
export function createSubmissionRouteFor(
  main: Pick<Databases["main"], "withActor" | "actorReader">,
  deps: Pick<EvidenceIngestDependencies, "payloads"> & { readonly signer: SigningKeyProvider },
): Route {
  return createSubmissionRoute(submissionOptionsFor(main, deps));
}

/** The same submission on the checked route, which names 409 declaration_required. */
export function createCheckedSubmissionRouteFor(
  main: Pick<Databases["main"], "withActor" | "actorReader">,
  deps: Pick<EvidenceIngestDependencies, "payloads"> & { readonly signer: SigningKeyProvider },
): Route {
  return createSubmissionRoute({ ...submissionOptionsFor(main, deps), checked: true });
}

function submissionOptionsFor(
  main: Pick<Databases["main"], "withActor" | "actorReader">,
  deps: Pick<EvidenceIngestDependencies, "payloads"> & { readonly signer: SigningKeyProvider },
): SubmissionRouteOptions {
  const submit: SubmitWork = (token, input) =>
    submitWork({ withActor: main.withActor, payloads: deps.payloads, signer: deps.signer }, token, {
      documentId: input.documentId,
      revision: input.revision,
    });
  return {
    submit,
    actors: main.actorReader,
    recordActivity: (token) => recordActivity(token, main.withActor),
  };
}
