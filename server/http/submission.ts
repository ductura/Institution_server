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
// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
// OD-15): while the assignment requires a declaration, the submission goes to
// submitWork only after declaration.submission_gate found one confirmed for
// the submitted revision; otherwise nothing is written and nothing is
// requested. The contract of this route has no 409 for it (a new 409 branch
// breaks its clients, scripts/check-breaking.ts), so the refusal is 503
// request, as a failed read of the gate is: never a pass (PRODUCT §5 rule 11).
// The web reads declarationRequired and the state from student.declaration.get
// before it offers the submission. The trigger that pins the declaration to
// the request stays the guarantee.
import { ROUTES } from "../contracts/index.ts";
import {
  type ActorReader,
  createSubmissionDeclarationGate,
  type SubmissionDeclarationGate,
} from "../database/index.ts";
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
        "not_acknowledged" | "not_open" | "not_found" | "unauthenticated" | "invalid";
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
};

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "submission.submit.post");
  if (found === undefined) throw new Error("no contract submission.submit.post");
  return found;
})();

const unavailable = (stage: string): EvidenceAnswer => ({
  status: 503,
  body: { status: "unavailable", stage },
  headers: { "retry-after": "5" },
});

/**
 * The closed mapping onto the wire (Ductus submissionResponse); a status not
 * named here is never a success. Null is the 200 of a submission.
 */
export function submissionAnswer(outcome: SubmissionOutcome): EvidenceAnswer | null {
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
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const refuse = (answer: EvidenceAnswer) => sendEvidenceAnswer(response, CONTRACT, answer);
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
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return refuse(unavailable("submission"));
      }
      const answer = submissionAnswer(outcome);
      if (answer !== null) return refuse(answer);
      if (outcome.status === "submitted") {
        sendJson(response, 200, { status: "submitted", receipt: outcome.receipt });
        // Only a submission counts, once written; a failure costs only the touch.
        void options.recordActivity(read.token).catch(() => undefined);
      }
    },
  };
}

/** The code of a submission the declaration gate refused (503 request on the wire). */
export const DECLARATION_REQUIRED_CODE = "declaration_required";

/**
 * The submission behind the declaration gate: `submit` runs only on proceed.
 * A missing declaration and a gate that fails are both 503 request, so
 * nothing is requested without the gate's pass.
 */
export function gatedSubmit(gate: SubmissionDeclarationGate, submit: SubmitWork): SubmitWork {
  return async (token, input) => {
    let answer: Awaited<ReturnType<SubmissionDeclarationGate>>;
    try {
      answer = await gate(token, input);
    } catch {
      return { status: "unavailable", stage: "request", code: "declaration_gate_failed" };
    }
    if (answer === "declaration_required") {
      return { status: "unavailable", stage: "request", code: DECLARATION_REQUIRED_CODE };
    }
    return submit(token, input);
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
  const submit = gatedSubmit(createSubmissionDeclarationGate(main.withActor), (token, input) =>
    submitWork({ withActor: main.withActor, payloads: deps.payloads, signer: deps.signer }, token, {
      documentId: input.documentId,
      revision: input.revision,
    }),
  );
  return createSubmissionRoute({
    submit,
    actors: main.actorReader,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
