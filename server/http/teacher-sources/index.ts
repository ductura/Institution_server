import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath, WorkSourceRecord } from "../../contracts/index.ts";
import { createTeacherSources, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

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

// The guidance of a teacher on sources over HTTP (SRV-1605, Ductus#2052,
// WEB-2133): the recommendation of a source on a work, the required literature
// of a course, the request for a proof with a deadline, the mark that the
// literature was reviewed, and the proofs a teacher reads. The port is
// server/database/teacher-sources (20261213100500); the database decides who
// may. Every refusal to read or write (another's, an unknown or a malformed
// work or course, no relation, a reader that is not a writer) is the same 404
// (C-23). An answer outside the contract or a throw is 503 and reported, never a
// partial answer. A write is followed by session activity only after the commit.
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return contract;
}

function bodyOf(id: string) {
  const body = contractOf(id).responses.find((response) => response.status === 200)?.body;
  if (body === undefined) throw new Error(`no answer body of ${id}`);
  return body;
}

function pathId(segment: string | undefined, pattern = UUID): string | undefined {
  const id = workIdFromPath(segment ?? "");
  return id !== null && pattern.test(id) ? id : undefined;
}

function unavailable(response: ServerResponse, id: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), id);
  sendProblem(response, 503, "unavailable");
}

type Refusal = {
  readonly status: "unauthorized" | "not_found" | "invalid_input" | "conflict";
};
type Done<T> = Promise<{ status: "ok"; value: T } | Refusal>;

/** The answer for an outcome that is not "ok": the one 404 for every refusal. */
function sendRefusal(response: ServerResponse, outcome: Refusal): void {
  if (outcome.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
  if (outcome.status === "not_found") return sendProblem(response, 404, "not_found");
  if (outcome.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
  if (outcome.status === "conflict") return sendProblem(response, 409, "conflict");
  throw new Error(`unknown outcome ${outcome.status}`);
}

export type TeacherSourceRoutesOptions = {
  readonly withActor: WithActor;
  /** Session activity for an accepted write (session/recordActivity). */
  readonly recordActivity?: (token: string) => Promise<unknown>;
};

export function createTeacherSourceRoutes({
  withActor,
  recordActivity: touch,
}: TeacherSourceRoutesOptions): Route[] {
  const sources = createTeacherSources(withActor);

  /** A JSON body of a mutation: media type, size, JSON; the closed contract shape or 422. */
  async function jsonBody(
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
  ): Promise<unknown | undefined> {
    const contract = contractOf(id);
    const types = request.headersDistinct["content-type"];
    if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
      refuse(response, 415, "unsupported_media_type");
      return undefined;
    }
    const raw = await readBodyWithLimit(
      request,
      contract.request.maxBodyBytes ?? 0,
      BODY_TIMEOUT_MS,
    );
    if (!raw.ok) {
      refuse(response, raw.status, raw.reason);
      return undefined;
    }
    const json = parseJson(raw.bytes);
    if (!json.ok) {
      sendProblem(response, 400, "invalid_json");
      return undefined;
    }
    return json.value;
  }

  /** Runs a read that answers JSON checked against the contract's 200 body. */
  function reader(
    id: string,
    run: (
      token: string,
      params: Record<string, string | undefined>,
    ) => (() => Done<unknown>) | undefined,
    shape?: (value: unknown) => unknown,
  ): Route {
    const contract = contractOf(id);
    const body = bodyOf(id);
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const start = run(token, params ?? {});
        if (start === undefined) return sendProblem(response, 404, "not_found");
        try {
          const outcome = await start();
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
          const answer =
            shape === undefined
              ? (outcome as { value: unknown }).value
              : shape((outcome as { value: unknown }).value);
          if (!Value.Check(body, answer)) {
            return unavailable(response, id, new Error("answer outside the contract"));
          }
          response.setHeader("cache-control", "no-store");
          sendJson(response, 200, answer);
        } catch (error) {
          unavailable(response, id, error);
        }
      },
    };
  }

  /** A write with no JSON answer: 204 whether or not there was something to remove. */
  function remover(
    id: string,
    run: (
      token: string,
      params: Record<string, string | undefined>,
    ) => (() => Done<boolean>) | undefined,
  ): Route {
    return {
      contract: contractOf(id),
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const start = run(token, params ?? {});
        if (start === undefined) return sendProblem(response, 404, "not_found");
        try {
          const outcome = await start();
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
        } catch (error) {
          return unavailable(response, id, error);
        }
        if (touch !== undefined) void touch(token).catch(() => undefined);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      },
    };
  }

  /** A write with a JSON body and a JSON answer checked against the contract. */
  function putter(
    id: string,
    run: (
      token: string,
      params: Record<string, string | undefined>,
      body: Record<string, unknown>,
    ) => (() => Done<unknown>) | undefined,
    checkBody?: (
      body: Record<string, unknown>,
      params: Record<string, string | undefined>,
    ) => boolean,
  ): Route {
    const contract = contractOf(id);
    const answerBody = bodyOf(id);
    return {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const json = await jsonBody(request, response, id);
        if (json === undefined) return;
        const input = contract.request.body;
        if (input === undefined) throw new Error(`no request body of ${id}`);
        if (
          !Value.Check(input, json) ||
          (checkBody !== undefined && !checkBody(json as Record<string, unknown>, params ?? {}))
        ) {
          return sendProblem(response, 422, "invalid_input");
        }
        const start = run(token, params ?? {}, json as Record<string, unknown>);
        // A path that is not an id is the one 404.
        if (start === undefined) return sendProblem(response, 404, "not_found");
        try {
          const outcome = await start();
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
          if (!Value.Check(answerBody, outcome.value)) {
            return unavailable(response, id, new Error("answer outside the contract"));
          }
          if (touch !== undefined) void touch(token).catch(() => undefined);
          response.setHeader("cache-control", "no-store");
          sendJson(response, 200, outcome.value);
        } catch (error) {
          unavailable(response, id, error);
        }
      },
    };
  }

  return [
    reader("teacher.source-guidance.get", (token, p) => {
      const documentId = workIdFromPath(p.documentId ?? "");
      return documentId === null ? undefined : () => sources.guidance(token, documentId);
    }),
    putter("teacher.source-recommendation.put", (token, p, body) => {
      const documentId = workIdFromPath(p.documentId ?? "");
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      if (documentId === null || sourceId === undefined) return undefined;
      // The deep shape of the record is checked here (the input validator compiles one level).
      if (
        !Value.Check(WorkSourceRecord, body.record) ||
        (body.record as { id: string }).id !== sourceId
      ) {
        return () => Promise.resolve({ status: "invalid_input" as const });
      }
      return () => sources.recommend(token, documentId, body as never);
    }),
    remover("teacher.source-recommendation.delete", (token, p) => {
      const documentId = workIdFromPath(p.documentId ?? "");
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      return documentId === null || sourceId === undefined
        ? undefined
        : () => sources.unrecommend(token, documentId, sourceId);
    }),
    putter("teacher.source-proof-request.put", (token, p, body) => {
      const documentId = workIdFromPath(p.documentId ?? "");
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      if (documentId === null || sourceId === undefined) return undefined;
      return () => sources.putProofRequest(token, documentId, sourceId, body as never);
    }),
    remover("teacher.source-proof-request.delete", (token, p) => {
      const documentId = workIdFromPath(p.documentId ?? "");
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      return documentId === null || sourceId === undefined
        ? undefined
        : () => sources.closeProofRequest(token, documentId, sourceId);
    }),
    {
      contract: contractOf("teacher.literature-seen.put"),
      async handle(request, response, params) {
        const id = "teacher.literature-seen.put";
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        try {
          const outcome = await sources.markLiteratureSeen(token, documentId);
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
          const answer = { seenAt: outcome.value };
          if (!Value.Check(bodyOf(id), answer)) {
            return unavailable(response, id, new Error("answer outside the contract"));
          }
          if (touch !== undefined) void touch(token).catch(() => undefined);
          response.setHeader("cache-control", "no-store");
          sendJson(response, 200, answer);
        } catch (error) {
          unavailable(response, id, error);
        }
      },
    },
    {
      contract: contractOf("teacher.source-proofs.get"),
      async handle(request, response, params) {
        const id = "teacher.source-proofs.get";
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        const sourceId = pathId(params?.sourceId, SOURCE_ID);
        if (documentId === null || sourceId === undefined)
          return sendProblem(response, 404, "not_found");
        try {
          const outcome = await sources.proofs(token, documentId, sourceId);
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
          const answer = {
            proofs: outcome.value.map((proof) => ({
              ...proof,
              imagePath: `/api/v1/teacher/works/${encodeURIComponent(documentId)}/sources/${sourceId}/proofs/${proof.id}/image`,
            })),
          };
          if (!Value.Check(bodyOf(id), answer)) {
            return unavailable(response, id, new Error("answer outside the contract"));
          }
          sendJson(response, 200, answer);
        } catch (error) {
          unavailable(response, id, error);
        }
      },
    },
    {
      contract: contractOf("teacher.source-proof-image.get"),
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        const sourceId = pathId(params?.sourceId, SOURCE_ID);
        const proofId = pathId(params?.proofId);
        if (documentId === null || sourceId === undefined || proofId === undefined) {
          return sendProblem(response, 404, "not_found");
        }
        try {
          const outcome = await sources.image(token, documentId, sourceId, proofId);
          if (outcome.status !== "ok") return sendRefusal(response, outcome);
          response.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(outcome.value.image.length),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(outcome.value.image);
        } catch (error) {
          unavailable(response, "teacher.source-proof-image.get", error);
        }
      },
    },
    reader("teacher.course-literature.get", (token, p) => {
      const courseId = pathId(p.courseId);
      return courseId === undefined ? undefined : () => sources.courseLiterature(token, courseId);
    }),
    putter("teacher.course-literature.put", (token, p, body) => {
      const courseId = pathId(p.courseId);
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      if (courseId === undefined || sourceId === undefined) return undefined;
      if (
        !Value.Check(WorkSourceRecord, body.record) ||
        (body.record as { id: string }).id !== sourceId
      ) {
        return () => Promise.resolve({ status: "invalid_input" as const });
      }
      return () => sources.putCourseSource(token, courseId, body as never);
    }),
    remover("teacher.course-literature.delete", (token, p) => {
      const courseId = pathId(p.courseId);
      const sourceId = pathId(p.sourceId, SOURCE_ID);
      return courseId === undefined || sourceId === undefined
        ? undefined
        : () => sources.deleteCourseSource(token, courseId, sourceId);
    }),
    reader(
      "student.course-literature.get",
      (token, p) => {
        const courseId = pathId(p.courseId);
        return courseId === undefined ? undefined : () => sources.courseLiterature(token, courseId);
      },
      // The student reads the sources only: canWrite is the teachers' flag.
      (value) => ({ sources: (value as { sources: unknown }).sources }),
    ),
    reader("student.source-proof-requests.get", (token, p) => {
      const assignmentId = pathId(p.assignmentId);
      return assignmentId === undefined
        ? undefined
        : () => sources.studentProofRequests(token, assignmentId);
    }),
  ];
}

/** The routes over main's application withActor; server/server.ts mounts them. */
export function createTeacherSourceRoutesFor(main: { withActor: WithActor }): Route[] {
  return createTeacherSourceRoutes({
    withActor: main.withActor,
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
