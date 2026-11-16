// POST /api/v1/evidence/open (DAN-811, VS-1 narrow cut, step 2). Port of
// Ductus src/server/evidence/open-route.ts at 078c780: the student's work for
// one assignment, made only on `"start": true`, with its current state, the
// snapshot of the current revision and the public receipt keys of its
// evidence domain. Package and institution never leave the server. Method is
// the router's and Origin pipeline step 7 (docs/vs1-rute.md).
import { ROUTES } from "../contracts/index.ts";
import type { ActorReader, OpenWorkResult, WorkOpener } from "../database/index.ts";

import { reportServerError } from "./error-catalog.ts";
import {
  type EvidenceAnswer,
  parseClosedObject,
  readEvidenceBody,
  sendEvidenceAnswer,
} from "./evidence-request.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const OPEN_ID = "evidence.open.post";
const found = ROUTES.find((route) => route.id === OPEN_ID);
if (found === undefined) throw new Error(`no contract ${OPEN_ID}`);
const contract = found;

/** DUCTUS_PROTOCOL_VERSION of server/domain/evidence; http may not import domain. */
export const OPEN_PROTOCOLS: readonly string[] = ["1"];
export const OPEN_MAX_BYTES = 1024;
export const OPEN_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EvidenceOpenOptions = {
  readonly actorReader: ActorReader;
  readonly workOpener: WorkOpener;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const answer = (status: number, code: string): EvidenceAnswer => ({
  status,
  body: { status: code },
});
const UNAVAILABLE: EvidenceAnswer = {
  status: 503,
  body: { status: "unavailable", stage: "context" },
  headers: { "retry-after": "5" },
};

function answerOf(opened: OpenWorkResult): EvidenceAnswer | { readonly body: unknown } {
  switch (opened.status) {
    case "opened": {
      const { snapshot, ...work } = opened.work;
      const body = {
        status: "opened",
        documentId: work.documentId,
        evidenceProfileId: work.evidenceProfileId,
        currentRevision: work.currentRevision,
        documentHash: work.documentHash,
        headSegmentHash: work.headSegmentHash,
        lastSequenceTo: work.lastSequenceTo,
        document: Buffer.from(snapshot, "utf8").toString("base64"),
        receiptKeys: work.receiptKeys,
        submitted: work.submitted,
      };
      return { body };
    }
    case "unauthenticated":
      return answer(401, "unauthenticated");
    case "not_found":
      return answer(404, "not_found");
    case "not_accepting":
    case "not_started":
      return answer(409, opened.status);
    default:
      return UNAVAILABLE;
  }
}

/** The open route over the main database's actor reader and work opener. */
export function createEvidenceOpenRoute(options: EvidenceOpenOptions): Route {
  const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      const refuse = (a: EvidenceAnswer) => sendEvidenceAnswer(response, contract, a);
      const read = await readEvidenceBody(request, options.actorReader, {
        protocols: OPEN_PROTOCOLS,
        maxBytes: OPEN_MAX_BYTES,
        timeoutMs,
        live: false,
      });
      if (!read.ok) return refuse(read.answer);
      const body =
        parseClosedObject(read.bytes, ["assignmentId"]) ??
        parseClosedObject(read.bytes, ["assignmentId", "start"]);
      const assignmentId = body?.assignmentId;
      // Only a literal true starts a work; a missing key and false open an existing one.
      const start = body !== null && "start" in body ? body.start : false;
      if (
        typeof assignmentId !== "string" ||
        !UUID.test(assignmentId) ||
        typeof start !== "boolean"
      ) {
        return refuse(answer(422, "invalid"));
      }
      let opened: OpenWorkResult;
      try {
        opened = await options.workOpener.openWork(read.token, assignmentId, start);
      } catch (error) {
        // Only the class of the error: never its message, the request or a token.
        reportServerError("route", error, requestIdOf(response), contract.id);
        opened = { status: "unavailable", reason: "work_failed" };
      }
      const result = answerOf(opened);
      if ("status" in result) return refuse(result);
      sendJson(response, 200, result.body);
    },
  };
}
