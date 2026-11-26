// SRV-2006 (Faza 3, Ductus#2052): the HTTP edge of POST /api/v1/revision-requests/{action},
// the port of the Ductus boundary of server/collaboration/revision-requests.ts
// (DAN-314 2f). The edge only: the session cookie (401), the action (404), the
// media type, the bounded body as its exact canonical bytes (so no duplicate
// key and no second spelling of a value is read), the id before the other
// values (a malformed id reads as a foreign one, 403), the shape of the
// contract, then the SECURITY DEFINER function of the action. The database
// decides who may and which transition is allowed. A log line carries the
// route and one closed code, never text, anchor, hash or id.
import { Value } from "@sinclair/typebox/value";

import { isWorkId, ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendDeclaredResponse,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

import { ACTS, execute, type Action } from "./store.ts";

export { createRevisionSendRouteFor } from "./send.ts";

const CONTRACT = ROUTES.find((route) => route.id === "collaboration.revision-requests.post")!;
const BODY = CONTRACT.request.body!;
const SUCCESS = CONTRACT.responses.find((response) => response.status === 200)!.body!;
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// White_Space plus zero width, as collaboration.is_revision_text: a text needs a visible character.
const VISIBLE =
  /[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/u;
const DB_REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  // A transition the state does not allow; a stale counter is the outcome "conflict" instead.
  ["ZD409", [409, "not_allowed"]],
  ["ZD422", [422, "invalid_input"]],
]);

function isAction(value: string | undefined): value is Action {
  return value !== undefined && Object.hasOwn(ACTS, value);
}

/** The value with its keys in the order of the canonical form (UTF-16 code units). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sorted(inner)]),
  );
}

/** A text of the body is the server's side of the rule: NFC, no control character but newline and tab, no bidi, a visible character. */
function textsWellFormed(input: Record<string, unknown>): boolean {
  for (const key of ["instruction", "explanation"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value !== value.normalize("NFC") ||
      /\p{Cc}/u.test(value.replace(/[\n\t]/gu, "")) ||
      BIDI.test(value) ||
      !VISIBLE.test(value)
    ) {
      return false;
    }
  }
  return true;
}

export function createRevisionRequestsRouteFor(main: { withActor: WithActor }): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      // The origin layer covers every POST action, including list.
      const action = params?.action;
      if (!isAction(action)) return refuse(response, 404, "not_found");
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

      // Exactly the canonical bytes of an object with exactly the keys of the
      // action: this alone refuses a duplicate key, which JSON.parse would
      // silently resolve to the last one, and every other second spelling.
      const value = json.value;
      const spec = ACTS[action];
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const input = value as Record<string, unknown>;
      const keys = Object.keys(input).sort();
      if (
        keys.length !== spec.keys.length ||
        keys.some((key, i) => key !== spec.keys[i]) ||
        !Buffer.from(JSON.stringify(sorted(input))).equals(raw.bytes)
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      // A malformed id is answered like a foreign or missing one, before the database.
      const id = input[spec.id];
      if (
        spec.id === "documentId" ? !isWorkId(id) : !(typeof id === "string" && REQUEST_ID.test(id))
      ) {
        return sendProblem(response, 403, "forbidden");
      }
      if (!Value.Check(BODY, input) || !textsWellFormed(input)) {
        return sendProblem(response, 422, "invalid_input");
      }

      try {
        const result = await main.withActor(token, (tx) => execute(tx, action, input));
        if (result.status === 409)
          return sendDeclaredResponse(response, CONTRACT, 409, result.body);
        if (result.status === 200 && Value.Check(SUCCESS, result.body)) {
          return sendJson(response, 200, result.body);
        }
        reportServerError(
          "route",
          new Error("revision request result unavailable"),
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
