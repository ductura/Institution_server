// SRV-ED42-PRIJEDLOZI (Ductus#2058, PITANJE ED-42; D-34, C-9, D-266 t. 1):
// the HTTP edge of a teacher's text suggestions. Four POST routes, reads too,
// so a work id never lands in a URL: collaboration.suggestions-list.post,
// collaboration.suggestions.post, collaboration.suggestion-accept.post and
// collaboration.suggestion-reject.post. The edge only: the session cookie
// (401), the media type (415), the bounded body (413/408/400), the JSON
// (400), a malformed work id read as a missing work (404), the shape of the
// contract and the text rule (422), then server/database/suggestions, which
// with the RPCs of 20261220190000 decides the relation (a teacher creates,
// the student owner decides, both list; anybody else 404), the single
// decision and the bound to the live state (409). Accept answers the exact
// JCS bytes the student publishes with its own live.document.put; the work
// changes only then. A log line carries the route and one closed code, never
// a text or an id.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { isWorkId, ROUTES } from "../../contracts/index.ts";
import {
  applySuggestionToLive,
  createSuggestions,
  type SuggestionAnchorInput,
  type SuggestionRefusal,
  type WithActor,
} from "../../database/index.ts";
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

const find = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const LIST = find("collaboration.suggestions-list.post");
const POST = find("collaboration.suggestions.post");
const ACCEPT = find("collaboration.suggestion-accept.post");
const REJECT = find("collaboration.suggestion-reject.post");
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;
const CONTROL = /\p{Cc}/u;

type Contract = typeof LIST;
const successOf = (contract: Contract) =>
  contract.responses.find((response) => response.status === 200)?.body;

const REFUSALS = new Map<SuggestionRefusal["status"], readonly [number, string]>([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["invalid", [422, "invalid_input"]],
  ["conflict", [409, "conflict"]],
  ["unavailable", [503, "unavailable"]],
]);

/** The session, the media type, the bounded body and its JSON; undefined once answered. */
async function readInput(
  contract: Contract,
  request: Parameters<Route["handle"]>[0],
  response: ServerResponse,
): Promise<{ token: string; input: Record<string, unknown> } | undefined> {
  const token = liveSessionTokenFromCookie(request.headers.cookie);
  if (token === undefined) return void refuse(response, 401, "unauthorized");
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return void refuse(response, 415, "unsupported_media_type");
  }
  const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) return void refuse(response, raw.status, raw.reason);
  const json = parseJson(raw.bytes);
  if (!json.ok) return void sendProblem(response, 400, "invalid_json");
  const value = json.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void sendProblem(response, 422, "invalid_input");
  }
  return { token, input: value as Record<string, unknown> };
}

/** isSuggestionText on the server's side: NFC, no control and no bidi character. */
function textWellFormed(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.normalize("NFC") &&
    !CONTROL.test(value) &&
    !BIDI.test(value)
  );
}

function answerRefusal(response: ServerResponse, contract: Contract, refusal: SuggestionRefusal) {
  if (refusal.status === "unavailable") {
    reportServerError(
      "route",
      new Error("suggestion result unavailable"),
      requestIdOf(response),
      contract.id,
    );
  }
  return sendProblem(response, ...(REFUSALS.get(refusal.status) ?? [503, "unavailable"]));
}

/** A success that matches the contract, else 503 and a report. */
function answer(response: ServerResponse, contract: Contract, body: unknown) {
  const schema = successOf(contract);
  if (schema !== undefined && Value.Check(schema, body)) return sendJson(response, 200, body);
  reportServerError(
    "route",
    new Error("suggestion answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  return sendProblem(response, 503, "unavailable");
}

export function createSuggestionRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createSuggestions(main.withActor);

  const list: Route = {
    contract: LIST,
    async handle(request, response) {
      const read = await readInput(LIST, request, response);
      if (read === undefined) return;
      const { documentId } = read.input;
      if (Object.keys(read.input).length !== 1 || documentId === undefined) {
        return sendProblem(response, 422, "invalid_input");
      }
      // A malformed id is answered like a missing work, before the database.
      if (!isWorkId(documentId)) return sendProblem(response, 404, "not_found");
      const result = await store.list(read.token, documentId);
      if (result.status !== "ok") return answerRefusal(response, LIST, result);
      return answer(response, LIST, { suggestions: result.suggestions });
    },
  };

  const post: Route = {
    contract: POST,
    async handle(request, response) {
      const read = await readInput(POST, request, response);
      if (read === undefined) return;
      const { input } = read;
      if (Object.hasOwn(input, "documentId") && !isWorkId(input.documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      if (!Value.Check(POST.request.body!, input)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const anchor = input.anchor as SuggestionAnchorInput;
      // isSuggestionInput: a text other than the quote, a range of the quote's length.
      if (
        !textWellFormed(input.text) ||
        input.text === anchor.quote ||
        anchor.endHint - anchor.startHint !== anchor.quote.length
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      const result = await store.create(read.token, input.documentId as string, anchor, input.text);
      if (result.status !== "ok") return answerRefusal(response, POST, result);
      return answer(response, POST, {
        suggestionId: result.suggestionId,
        baseHash: result.baseHash,
      });
    },
  };

  const accept: Route = {
    contract: ACCEPT,
    async handle(request, response) {
      const read = await readInput(ACCEPT, request, response);
      if (read === undefined) return;
      if (!Value.Check(ACCEPT.request.body!, read.input)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const suggestionId = read.input.suggestionId as string;
      const schema = successOf(ACCEPT);
      // The answer is built and checked inside the transaction: one outside
      // the contract throws, the decision rolls back (503) and the suggestion
      // stays pending, so an accept is never kept without its text.
      const result = await store.accept(read.token, suggestionId, (suggestion) => {
        const applied = applySuggestionToLive(suggestion);
        if (applied === undefined) return undefined;
        const body = {
          suggestionId,
          state: "accepted",
          baseHash: suggestion.baseHash,
          text: applied.text,
          change: applied.change,
        };
        if (schema === undefined || !Value.Check(schema, body)) {
          throw new Error("suggestion answer outside the contract");
        }
        return body;
      });
      if (result.status !== "ok") return answerRefusal(response, ACCEPT, result);
      return answer(response, ACCEPT, result.applied);
    },
  };

  const reject: Route = {
    contract: REJECT,
    async handle(request, response) {
      const read = await readInput(REJECT, request, response);
      if (read === undefined) return;
      if (!Value.Check(REJECT.request.body!, read.input)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const result = await store.reject(read.token, read.input.suggestionId as string);
      if (result.status !== "ok") return answerRefusal(response, REJECT, result);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    },
  };

  return [list, post, accept, reject];
}
