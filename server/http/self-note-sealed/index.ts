// SRV-NF6-SIFRA (Ductus#2055; owner decision B2 of 24 Nov 2026): the HTTP
// edge of the sealed note to self (work.sealed-self-note.*) and the wrapped
// note key (profile.self-note-key.*). The edge only, as mentorship-follow: a live
// session cookie (401), for a note the work id decoded once by workIdFromPath
// (one that is not a work id is the same 404 as another's work, C-23), for a
// write the media type, the bounded body and its shape, then
// server/database/self-note-sealed. The database decides who may; a refusal
// of the relation is 404, a key that is not there or not the one named 409, a
// malformed input 422, and none of them writes anything. A throw is 503 and
// reported. The edge never logs or reports a body: it carries only bytes the
// server cannot read.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  isWorkId,
  SealedSelfNoteInput,
  SelfNoteKeyInput,
  selfNoteSealedRoutes,
  workIdFromPath,
} from "../../contracts/index.ts";
import {
  createSelfNoteSealed,
  type SealedNote,
  type SealedRefusal,
  type SelfNoteKeyWrite,
  type SelfNoteSealed,
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

const BODY_TIMEOUT_MS = 5_000;

type Contract = (typeof selfNoteSealedRoutes)[number];

/** Answers a closed refusal of the port with its status and problem code. */
function refusalOf(response: ServerResponse, status: SealedRefusal["status"]): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "conflict") return sendProblem(response, 409, "conflict");
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  return sendProblem(response, 503, "unavailable");
}

type Body = { ok: true; value: unknown } | { ok: false };

/** Reads a JSON body under the contract's bound; on refusal the response is sent. */
async function jsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  contract: Contract,
): Promise<Body> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(
    request,
    (contract.request as { maxBodyBytes?: number }).maxBodyBytes ?? 0,
    BODY_TIMEOUT_MS,
  );
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  return { ok: true, value: json.value };
}

type Answered = { readonly status: string } & Record<string, unknown>;

async function answer(
  response: ServerResponse,
  contract: Contract,
  call: () => Promise<Answered>,
  pick: (ok: Answered) => unknown,
): Promise<void> {
  try {
    const result = await call();
    if (result.status === "ok") return sendJson(response, 200, pick(result));
    return refusalOf(response, result.status as SealedRefusal["status"]);
  } catch (error) {
    reportServerError("route", error, requestIdOf(response), contract.id);
    return sendProblem(response, 503, "unavailable");
  }
}

const stateOf = (ok: Answered) => ok["state"];
const keyOf = (ok: Answered) => ({ key: ok["key"] });

function routeFor(sealed: SelfNoteSealed, contract: Contract): Route {
  const write = contract.method !== "GET";
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) {
        return write
          ? refuse(response, 401, "unauthorized")
          : sendProblem(response, 401, "unauthorized");
      }
      if (contract.method === "DELETE") {
        const empty = await readBodyWithLimit(request, 0, BODY_TIMEOUT_MS);
        if (!empty.ok) return refuse(response, empty.status, empty.reason);
      }

      if (contract.id.startsWith("profile.")) {
        if (contract.id === "profile.self-note-key.get") {
          return answer(response, contract, () => sealed.readKey(token), keyOf);
        }
        if (contract.id === "profile.self-note-key.delete") {
          return answer(response, contract, () => sealed.deleteKey(token), keyOf);
        }
        const body = await jsonBody(request, response, contract);
        if (!body.ok) return;
        if (!Value.Check(SelfNoteKeyInput, body.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { ifVersion, ...key } = body.value as SelfNoteKeyWrite & {
          ifVersion: number | null;
        };
        return answer(response, contract, () => sealed.writeKey(token, key, ifVersion), keyOf);
      }

      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return write ? refuse(response, 404, "not_found") : sendProblem(response, 404, "not_found");
      }
      if (contract.id === "work.sealed-self-note.get") {
        return answer(response, contract, () => sealed.readNote(token, documentId), stateOf);
      }
      if (contract.id === "work.sealed-self-note.delete") {
        return answer(response, contract, () => sealed.clearNote(token, documentId), stateOf);
      }
      const body = await jsonBody(request, response, contract);
      if (!body.ok) return;
      if (!Value.Check(SealedSelfNoteInput, body.value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const note = (body.value as { sealed: SealedNote }).sealed;
      return answer(response, contract, () => sealed.writeNote(token, documentId, note), stateOf);
    },
  };
}

/** The routes over a given port (tests use a fake port). */
export function createSelfNoteSealedRoutes(sealed: SelfNoteSealed): Route[] {
  return selfNoteSealedRoutes.map((contract) => routeFor(sealed, contract));
}

/** All six routes over main's application withActor. */
export function createSelfNoteSealedRoutesFor(main: { withActor: WithActor }): Route[] {
  return createSelfNoteSealedRoutes(createSelfNoteSealed(main.withActor));
}
