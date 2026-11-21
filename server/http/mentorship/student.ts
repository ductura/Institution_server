import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createStudentMentorshipReader, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

// SRV-1414: the two reads of the student's side of mentorship. The database
// decides who may: a caller with a confirmed teacher role is 403. A request
// from another site is 403 as on the teacher's list.
const find = (id: string) => ROUTES.find((route) => route.id === id)!;
const REQUESTS = find("mentorship.student-requests.get");
const CANDIDATES = find("mentorship.student-mentor-candidates.get");
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
]);

export function createMentorshipStudentRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const reader = createStudentMentorshipReader(withActor);
  const read = async (contract: typeof REQUESTS, token: string) =>
    contract === REQUESTS
      ? { requests: await reader.requests(token) }
      : { candidates: await reader.candidates(token) };

  return [REQUESTS, CANDIDATES].map((contract) => {
    const success = contract.responses[0]!;
    return {
      contract,
      async handle(request, response) {
        const site = request.headersDistinct["sec-fetch-site"];
        if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
          return sendProblem(response, 403, "forbidden");
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        try {
          const body = await read(contract, token);
          if (!Value.Check(success.body!, body)) throw new Error("invalid mentorship read");
          sendJson(response, 200, body);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    };
  });
}
