// SRV-ED43-DORADA-POSALJI (Ductus#2058, BLOK ED-43): the HTTP edge of
// POST /api/v1/revision-send (collaboration.revision-send.post), "Pošalji
// doradu". The edge only, in the order of the revision-requests edge: the
// session cookie (401), the media type, the bounded body as its exact
// canonical bytes, the work id before the other values (a malformed id reads
// as a missing work, 404), the shape of the contract and the text rule of the
// message, then collaboration.send_revision (migration 20261220160000). The
// database decides the relation (the teacher of the work 403, anybody else
// 404), whether a revision request was opened or reopened since the previous
// round (409 not_allowed otherwise, also on a submitted work) and which round
// this is. A log line carries the route and one closed code, never the message
// or the id.
import { Value } from "@sinclair/typebox/value";

import { isWorkId, ROUTES } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const CONTRACT = ROUTES.find((route) => route.id === "collaboration.revision-send.post")!;
const BODY = CONTRACT.request.body!;
const SUCCESS = CONTRACT.responses.find((response) => response.status === 200)!.body!;
const BODY_TIMEOUT_MS = 5_000;
const KEYS = ["documentId", "message"] as const;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
// White_Space plus zero width, as collaboration.is_revision_text: a text needs a visible character.
const VISIBLE =
  /[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/u;
const DB_REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD404", [404, "not_found"]],
  ["ZD409", [409, "not_allowed"]],
  ["ZD422", [422, "invalid_input"]],
]);

/** The canonical bytes of `{documentId, message}`: keys sorted, no space. */
function canonicalBytes(input: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ documentId: input.documentId, message: input.message }));
}

/** The message, if any, is the server's side of the text rule: NFC, no control but newline and tab, no bidi, a visible character. */
function messageWellFormed(value: unknown): boolean {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    value === value.normalize("NFC") &&
    !/\p{Cc}/u.test(value.replace(/[\n\t]/gu, "")) &&
    !BIDI.test(value) &&
    VISIBLE.test(value)
  );
}

/** The round the database answered; anything else is not as the contract says. */
async function send(tx: ActorTransaction, documentId: string, message: string | null) {
  const { rows } = await tx.query<{ round: unknown }>(
    "SELECT round FROM collaboration.send_revision($1, $2)",
    [documentId, message],
  );
  return rows.length === 1 ? { round: rows[0]!.round } : undefined;
}

export function createRevisionSendRouteFor(main: { withActor: WithActor }): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, CONTRACT.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");

      // Exactly the canonical bytes of an object with exactly the two keys:
      // this alone refuses a duplicate key and every other second spelling.
      const value = json.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const input = value as Record<string, unknown>;
      const keys = Object.keys(input).sort();
      if (
        keys.length !== KEYS.length ||
        keys.some((key, i) => key !== KEYS[i]) ||
        !canonicalBytes(input).equals(raw.bytes)
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      // A malformed id is answered like a missing work, before the database.
      if (!isWorkId(input.documentId)) return sendProblem(response, 404, "not_found");
      if (!Value.Check(BODY, input) || !messageWellFormed(input.message)) {
        return sendProblem(response, 422, "invalid_input");
      }

      try {
        const answer = await main.withActor(token, (tx) =>
          send(tx, input.documentId as string, input.message as string | null),
        );
        if (answer !== undefined && Value.Check(SUCCESS, answer)) {
          return sendJson(response, 200, answer);
        }
        reportServerError(
          "route",
          new Error("revision send result unavailable"),
          requestIdOf(response),
          CONTRACT.id,
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const refusal = typeof code === "string" ? DB_REFUSALS.get(code) : undefined;
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}
