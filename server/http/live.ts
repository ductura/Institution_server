// GET and PUT /api/v1/live/{documentId} (contracts live.document.get and
// live.document.put). Port of the HTTP edge of Ductus
// src/server/collaboration/live-route.ts at 078c780 (B-LIVE, BACKEND 4.12
// point 6) over the port server/database/live-state.ts: the student owner
// publishes the last state of the work with PUT, and every reader gets it
// with GET through one function, the same status, bytes and ETag for the
// owner and the teacher (PRODUCT §5 rule 5). Changes: the method is the
// router's (405) and the PUT origin pipeline step 7's; the token is
// liveSessionTokenFromCookie; the session before the first body byte is
// checkSession over main's ActorReader (as evidence-session.ts); a 409 is
// written by sendDeclaredResponse, the only writer of a non-problem answer
// of 400 or more the contract declares. Who asks comes only from the session;
// the database decides access. The work text never reaches a log.
import type { IncomingMessage, ServerResponse } from "node:http";

import { isWorkId, ROUTES, workIdFromPath } from "../contracts/index.ts";
import { type ActorReader, createLiveStates, type LiveStates } from "../database/index.ts";
// http may not import domain (docs/server-map.md §2): the evidence area
// re-exports the protocol and the snapshot check, as for the commit route.
import {
  DUCTUS_PROTOCOL_VERSION,
  MAX_DOCUMENT_SNAPSHOT_BYTES,
  verifyDocumentSnapshot,
} from "../evidence/index.ts";
import { checkSession, liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { declaredLengthRefusal, readBodyWithLimit } from "./mutation-request.ts";
import { sendDeclaredResponse, sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

/** Ductus BODY_TIMEOUT_MS of the live route: 2 MiB may take a while. */
export const LIVE_BODY_TIMEOUT_MS = 30_000;
/** The mark of a read whose bytes are the submitted revision, not the live state (DAN-289 A3). */
export const LIVE_STATE_HEADER = "ductus-live-state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ETAG = /^"([0-9a-f]{64})"$/;

export type LiveRouteOptions = {
  readonly states: LiveStates;
  readonly actors: ActorReader;
  /** Session activity for an accepted write (Ductus counted). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const contractOf = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const GET = contractOf("live.document.get");
const PUT = contractOf("live.document.put");

/** The one value of a header sent exactly once; absent is undefined, repeated is null. */
function single(request: IncomingMessage, name: string): string | null | undefined {
  const values = request.headersDistinct[name];
  if (values === undefined) return undefined;
  return values.length === 1 ? values[0]! : null;
}

/**
 * Exactly one precondition: `If-None-Match: *` for the first write, or
 * `If-Match: "<token>"` with the last token. Anything else is null (428).
 */
function expectedTokenOf(request: IncomingMessage): { token: string | null } | null {
  const match = single(request, "if-match");
  const none = single(request, "if-none-match");
  if (match === null || none === null) return null;
  if (match !== undefined && none !== undefined) return null;
  if (none !== undefined) return none.trim() === "*" ? { token: null } : null;
  if (match === undefined) return null;
  const quoted = /^"([^"]*)"$/.exec(match.trim());
  return quoted && UUID.test(quoted[1]!) ? { token: quoted[1]! } : null;
}

/** The refusals of the port, as Ductus refusalFor answers them; anything else is 503. */
const REFUSAL: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["not_found", [404, "not_found"]],
  ["invalid_document", [422, "invalid_document"]],
]);
const refuseOutcome = (response: ServerResponse, status: string) => {
  const [code, name] = REFUSAL.get(status) ?? [503, "unavailable"];
  sendProblem(response, code, name);
};

export function createLiveRoutes(options: LiveRouteOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? LIVE_BODY_TIMEOUT_MS;
  const documentIdOf = (params: Readonly<Record<string, string>> | undefined) =>
    workIdFromPath(params?.documentId ?? "") ?? "";

  const read: Route = {
    contract: GET,
    async handle(request, response, params) {
      // A teacher's read writes the access log (PRODUCT §5 rule 17), so it needs
      // positive proof that a page of this origin sent it (F-107): the protocol
      // header, which only a script can set, and Sec-Fetch-Site same-origin when sent.
      if (single(request, "ductus-protocol") !== DUCTUS_PROTOCOL_VERSION) {
        return sendProblem(response, 403, "forbidden");
      }
      const site = single(request, "sec-fetch-site");
      if (site !== undefined && site !== "same-origin")
        return sendProblem(response, 403, "forbidden");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = documentIdOf(params);
      if (!isWorkId(documentId)) return sendProblem(response, 404, "not_found");
      // Only the exact form of an ETag this route sent; anything else reads in full.
      const known = ETAG.exec(single(request, "if-none-match")?.trim() ?? "")?.[1] ?? null;
      try {
        const state = await options.states.read(token, documentId, known);
        const submitted = (on: boolean) => (on ? { [LIVE_STATE_HEADER]: "submitted" } : {});
        switch (state.status) {
          case "empty":
            response.writeHead(204, { "cache-control": "no-store" });
            return void response.end();
          case "not_modified":
            response.writeHead(304, {
              "cache-control": "no-store",
              ...submitted(state.submitted),
              etag: `"${state.hash}"`,
            });
            return void response.end();
          case "state":
            response.writeHead(200, {
              "cache-control": "no-store",
              ...submitted(state.submitted),
              "content-type": "application/json; charset=utf-8",
              "content-length": String(state.bytes.byteLength),
              etag: `"${state.hash}"`,
            });
            return void response.end(state.bytes);
          default:
            return refuseOutcome(response, state.status);
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GET.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };

  const publish: Route = {
    contract: PUT,
    async handle(request, response, params) {
      const type = single(request, "content-type");
      if (type?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return refuse(response, 415, "unsupported_media_type");
      }
      const cookieToken = liveSessionTokenFromCookie(request.headers.cookie);
      if (cookieToken === undefined) return refuse(response, 401, "unauthorized");
      const expected = expectedTokenOf(request);
      if (expected === null) return refuse(response, 428, "precondition_required");
      // An id that cannot exist is answered like one that does not, before the database.
      const documentId = documentIdOf(params);
      if (!isWorkId(documentId)) return refuse(response, 404, "not_found");
      // The session before the first body byte (F-098): up to 2 MiB is never
      // held for a cookie that only has the right form. A declared length the
      // reader refuses unread needs no database either.
      const live = declaredLengthRefusal(request, MAX_DOCUMENT_SNAPSHOT_BYTES) === null;
      const session = await checkSession(cookieToken, options.actors, { live });
      if (!session.ok) {
        return session.refusal === "unauthenticated"
          ? refuse(response, 401, "unauthorized")
          : refuse(response, 503, "unavailable");
      }
      const body = await readBodyWithLimit(request, MAX_DOCUMENT_SNAPSHOT_BYTES, timeoutMs);
      if (!body.ok) {
        const [status, code] =
          body.status === 413
            ? [413, "too_large"]
            : body.status === 408
              ? [408, "timeout"]
              : [400, "bad_request"];
        return refuse(response, status, code);
      }
      // Only the exact JCS bytes of a valid document (BACKEND 4.12 point 6, as 4.10 point 2).
      const snapshot = await verifyDocumentSnapshot(body.bytes);
      if (!snapshot.ok) {
        return snapshot.reason === "too_large"
          ? sendProblem(response, 413, "too_large")
          : sendProblem(response, 422, "invalid_document");
      }
      try {
        const outcome = await options.states.publish(
          session.token,
          documentId,
          expected.token,
          snapshot.text,
        );
        if (outcome.status === "accepted" || outcome.status === "unchanged") {
          sendJson(response, 200, { outcome: outcome.status, token: outcome.token });
        } else if (outcome.status === "conflict") {
          return sendDeclaredResponse(response, PUT, 409, {
            outcome: "conflict",
            token: outcome.token,
          });
        } else {
          return refuseOutcome(response, outcome.status);
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), PUT.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted write counts (Ductus counted: 2xx), once written.
      void options.recordActivity(session.token).catch(() => undefined);
    },
  };

  return [read, publish];
}

/** The two routes over main's application withActor and actor reader; server.ts mounts them. */
export function createLiveRoutesFor(
  main: Pick<Databases["main"], "withActor" | "actorReader">,
): Route[] {
  return createLiveRoutes({
    states: createLiveStates(main.withActor),
    actors: main.actorReader,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
