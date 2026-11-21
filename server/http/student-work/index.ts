import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createStudentWorksReader,
  createStudentWorkStarter,
  type StartWorkOutcome,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

// SRV-1412 (M2.1 to M2.3): start the own work, read the own works. The
// database decides who may; another course's assignment, an unknown one and a
// malformed id read the same 404, so a caller learns nothing about an
// assignment that is not theirs (C-23).
const find = (id: string) => ROUTES.find((route) => route.id === id)!;
const START = find("student-work.start.post");
const WORKS = find("student-work.works.get");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [404, "not_found"]],
]);
const START_REFUSALS = new Map<StartWorkOutcome["status"], readonly [number, string]>([
  ["unauthenticated", [401, "unauthorized"]],
  ["not_found", [404, "not_found"]],
  ["not_accepting", [409, "conflict"]],
  ["not_configured", [503, "unavailable"]],
]);

type Store = {
  readonly start: ReturnType<typeof createStudentWorkStarter>["start"];
  readonly works: ReturnType<typeof createStudentWorksReader>["works"];
};

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createStudentWorkRoutes(store: Store, withActor: WithActor | null = null): Route[] {
  const startSuccess = START.responses[0]!;
  const worksSuccess = WORKS.responses[0]!;

  const start: Route = {
    contract: START,
    async handle(request, response, params) {
      const raw = params?.assignmentId ?? "";
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      if (!ID.test(raw)) return sendProblem(response, 404, "not_found");
      try {
        const outcome = await store.start(token, raw.toLowerCase());
        if (outcome.status !== "started") {
          const refusal = START_REFUSALS.get(outcome.status);
          if (refusal === undefined) throw new Error("unknown start outcome");
          return sendProblem(response, ...refusal);
        }
        const body = { ...outcome.work };
        if (!Value.Check(startSuccess.body!, body)) throw new Error("invalid started work");
        sendJson(response, 200, body);
      } catch (error) {
        const refusal = REFUSALS.get(codeOf(error) ?? "");
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), START.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (withActor !== null) void recordActivity(token, withActor).catch(() => undefined);
    },
  };

  const works: Route = {
    contract: WORKS,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const body = { works: await store.works(token) };
        if (!Value.Check(worksSuccess.body!, body)) throw new Error("invalid student works");
        sendJson(response, 200, body);
      } catch (error) {
        if (codeOf(error) === "ZD401") return sendProblem(response, 401, "unauthorized");
        reportServerError("route", error, requestIdOf(response), WORKS.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };

  return [start, works];
}

export function createStudentWorkRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const starter = createStudentWorkStarter(withActor);
  const reader = createStudentWorksReader(withActor);
  return createStudentWorkRoutes({ start: starter.start, works: reader.works }, withActor);
}
