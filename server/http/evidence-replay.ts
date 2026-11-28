// POST /api/v1/evidence/replay (DAN-818, VS-1 narrow cut, step 4, part c).
// Port of Ductus src/server/evidence/replay-route.ts at 333e163 (DAN-344,
// route R3) behind the guards of the evidence routes (docs/vs1-rute.md): the
// headers before the body, a closed body of exactly {documentId, from: 0} or
// {documentId, from, head}, and every outcome through one closed mapping. Who
// asks comes only from the session cookie, bound into the source; a role,
// institution or time in the body is refused, never read. The 200 body is
// the reader's JCS text, the same bytes for the owner and the teacher of the
// assignment (PRODUCT §5 rule 5). Method is the router's and Origin pipeline
// step 7.
import { ROUTES } from "../contracts/index.ts";
import {
  type ActorReader,
  createReplayResolutionReader,
  createReplaySource,
  type ReplayHead,
  type WithActor,
} from "../database/index.ts";
import { readReplayPage, type ReplayReadResult } from "../evidence/index.ts";
import type { InstitutionEvidencePayloadReader } from "../external/storage/index.ts";

import { reportServerError } from "./error-catalog.ts";
import {
  type EvidenceAnswer,
  parseClosedObject,
  readEvidenceBody,
  sendEvidenceAnswer,
} from "./evidence-request.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const REPLAY_ID = "evidence.replay.post";
const found = ROUTES.find((route) => route.id === REPLAY_ID);
if (found === undefined) throw new Error(`no contract ${REPLAY_ID}`);
const contract = found;

/** DUCTUS_PROTOCOL_VERSION of server/domain/evidence, as open and commit take it. */
export const REPLAY_PROTOCOLS: readonly string[] = ["1"];
export const REPLAY_MAX_BYTES = 1024;
export const REPLAY_TIMEOUT_MS = 5_000;
const HASH = /^[0-9a-f]{64}$/;

export type EvidenceReplayOptions = {
  readonly actorReader: ActorReader;
  readonly withActor: WithActor;
  /** Storage of every institution; the reader binds it to the source row's. */
  readonly payloads: InstitutionEvidencePayloadReader;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

export type ReplayRequest = { documentId: string; from: number; pin: ReplayHead | null };

/** Exactly `{segmentHash, segmentCount}`: a lowercase SHA-256 and a count of at least one. */
function readHead(value: unknown): ReplayHead | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2) return null;
  const { segmentHash, segmentCount } = value as Record<string, unknown>;
  if (typeof segmentHash !== "string" || !HASH.test(segmentHash)) return null;
  if (!Number.isSafeInteger(segmentCount) || (segmentCount as number) < 1) return null;
  return { segmentHash, segmentCount: segmentCount as number };
}

/**
 * The closed body: `{documentId, from: 0}` for the first page and
 * `{documentId, from, head}` for every later one; anything else is null.
 */
export function parseReplayRequest(bytes: Uint8Array): ReplayRequest | null {
  const first = parseClosedObject(bytes, ["documentId", "from"]);
  if (first !== null) {
    const { documentId, from } = first;
    return typeof documentId === "string" && from === 0 ? { documentId, from: 0, pin: null } : null;
  }
  const later = parseClosedObject(bytes, ["documentId", "from", "head"]);
  if (later === null) return null;
  const { documentId, from } = later;
  const pin = readHead(later.head);
  if (typeof documentId !== "string" || !Number.isSafeInteger(from) || (from as number) < 1) {
    return null;
  }
  return pin === null ? null : { documentId, from: from as number, pin };
}

const refusal = (status: number, code: string): EvidenceAnswer => ({
  status,
  body: { status: code },
});
const unavailable = (stage: "context" | "storage"): EvidenceAnswer => ({
  status: 503,
  body: { status: "unavailable", stage },
  headers: { "retry-after": "5" },
});
const STORAGE_REASONS = new Set([
  "payload_missing",
  "payload_unavailable",
  "invalid_segment",
  "segment_mismatch",
]);

/** The closed mapping of a read to the wire: the page text, or a refusal. */
export function replayAnswer(read: ReplayReadResult): { readonly text: string } | EvidenceAnswer {
  switch (read.status) {
    case "ok":
      return { text: read.body };
    case "not_found":
      return refusal(404, "not_found");
    case "unauthenticated":
      return refusal(401, "unauthenticated");
    case "record_changed":
      // Reached only after access is decided; the reader starts again from the first page.
      return refusal(409, "record_changed");
    case "unavailable":
      return unavailable(STORAGE_REASONS.has(read.reason) ? "storage" : "context");
    default:
      return unavailable("context");
  }
}

/** The replay route over the main database's session and the storage of every institution. */
export function createEvidenceReplayRoute(options: EvidenceReplayOptions): Route {
  const timeoutMs = options.timeoutMs ?? REPLAY_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      const refuse = (a: EvidenceAnswer) => sendEvidenceAnswer(response, contract, a);
      const read = await readEvidenceBody(request, options.actorReader, {
        protocols: REPLAY_PROTOCOLS,
        maxBytes: REPLAY_MAX_BYTES,
        timeoutMs,
        live: false,
      });
      if (!read.ok) return refuse(read.answer);
      const body = parseReplayRequest(read.bytes);
      if (body === null) return refuse(refusal(422, "invalid"));
      let page: ReplayReadResult;
      try {
        page = await readReplayPage(
          {
            source: createReplaySource(options.withActor, read.token),
            payloads: options.payloads,
            // F4-EDI-R05-SRV (B2): the same session and the same viewers as the source.
            resolutions: createReplayResolutionReader(options.withActor, read.token),
          },
          body.documentId,
          body.from,
          body.pin,
        );
      } catch (error) {
        // Only the class of the error: never its message, the request or a token.
        reportServerError("route", error, requestIdOf(response), contract.id);
        page = { status: "unavailable", reason: "source_unavailable" };
      }
      const answer = replayAnswer(page);
      // The JCS text unchanged: parsed and written again, it is the same bytes,
      // since JSON.stringify keeps the sorted keys and writes strings as JCS does.
      if ("text" in answer) return sendJson(response, 200, JSON.parse(answer.text) as unknown);
      refuse(answer);
    },
  };
}
