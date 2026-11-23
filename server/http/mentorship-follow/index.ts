// SRV-MENTOR-3 (Ductus#2055; MK-8, MK-9, MK-11, PG-9): the HTTP edge of the
// note to self and the reading place (work.self-note.*, work.reading-place.*),
// the seen marks (work.seen.post, work.seen-by-student.get) and the mentor's
// overview (mentorship.overview.get). The edge only, as work-messages: a live
// session cookie (401), the work id decoded once by workIdFromPath (one that
// is not a work id is the same 404 as another's work, C-23), for a write the
// media type, the bounded body and its shape, then
// server/database/mentorship-follow. The database decides who may; a refusal
// of the relation is 404, a malformed input 422 and writes nothing. A throw
// is 503 and reported.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  isWorkId,
  mentorshipFollowRoutes,
  ReadingPlaceInput,
  SeenInput,
  SelfNoteInput,
  workIdFromPath,
} from "../../contracts/index.ts";
import {
  createMentorshipFollow,
  type FollowRefusal,
  type MentorshipFollow,
  type SeenKind,
  type WithActor,
  type WorkPlace,
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
const BIDI = /[‪-‮⁦-⁩]/u;

type Contract = (typeof mentorshipFollowRoutes)[number];

/** Answers a closed refusal of the port with its status and problem code. */
function refusalOf(response: ServerResponse, status: FollowRefusal["status"]): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, "not_found");
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  return sendProblem(response, 503, "unavailable");
}

/** A note the database would refuse: not NFC, a control character, a bidi control. */
function badText(text: string): boolean {
  return (
    text !== text.normalize("NFC") ||
    /\p{Cc}/u.test(text.replace(/[\n\t]/gu, "")) ||
    BIDI.test(text)
  );
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
    return refusalOf(response, result.status as FollowRefusal["status"]);
  } catch (error) {
    reportServerError("route", error, requestIdOf(response), contract.id);
    return sendProblem(response, 503, "unavailable");
  }
}

function routeFor(follow: MentorshipFollow, contract: Contract): Route {
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
      if (contract.id === "mentorship.overview.get") {
        return answer(
          response,
          contract,
          () => follow.overview(token),
          (ok) => ({
            students: ok["students"],
          }),
        );
      }
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return write ? refuse(response, 404, "not_found") : sendProblem(response, 404, "not_found");
      }
      const state = (ok: Answered) => ok["state"];
      const items = (ok: Answered) => ({ items: ok["items"] });

      if (contract.method === "DELETE") {
        const empty = await readBodyWithLimit(request, 0, BODY_TIMEOUT_MS);
        if (!empty.ok) return refuse(response, empty.status, empty.reason);
        const part = contract.id === "work.self-note.delete" ? "note" : "reading";
        return answer(response, contract, () => follow.clear(token, documentId, part), state);
      }
      if (contract.id === "work.self-note.get") {
        return answer(response, contract, () => follow.readSelfNote(token, documentId), state);
      }
      if (contract.id === "work.seen-by-student.get") {
        return answer(response, contract, () => follow.seenByStudent(token, documentId), items);
      }

      const body = await jsonBody(request, response, contract);
      if (!body.ok) return;
      if (contract.id === "work.self-note.put") {
        if (!Value.Check(SelfNoteInput, body.value))
          return sendProblem(response, 422, "invalid_input");
        const { text, place } = body.value as { text: string; place?: WorkPlace | null };
        if (badText(text)) return sendProblem(response, 422, "invalid_input");
        return answer(
          response,
          contract,
          () => follow.writeSelfNote(token, documentId, text, place ?? null),
          state,
        );
      }
      if (contract.id === "work.reading-place.put") {
        if (!Value.Check(ReadingPlaceInput, body.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { place } = body.value as { place: WorkPlace };
        return answer(
          response,
          contract,
          () => follow.writeReadingPlace(token, documentId, place),
          state,
        );
      }
      if (!Value.Check(SeenInput, body.value)) return sendProblem(response, 422, "invalid_input");
      const reported = (body.value as { items: { kind: SeenKind; id: string }[] }).items;
      return answer(response, contract, () => follow.markSeen(token, documentId, reported), items);
    },
  };
}

/** The routes over a given port (tests use a fake port). */
export function createMentorshipFollowRoutes(follow: MentorshipFollow): Route[] {
  return mentorshipFollowRoutes.map((contract) => routeFor(follow, contract));
}

/** All eight routes over main's application withActor. */
export function createMentorshipFollowRoutesFor(main: { withActor: WithActor }): Route[] {
  return createMentorshipFollowRoutes(createMentorshipFollow(main.withActor));
}
