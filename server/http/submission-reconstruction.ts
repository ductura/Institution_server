// GET /api/v1/student/assignments/{assignmentId}/submission-reconstruction
// (F4-PM2-R01; contract student.assignment-submission-reconstruction.get): the
// state of the reconstruction the worker makes after the student's own
// submission. The session decides who asks, the database whether a submission
// of that person exists; another person's, an unknown and a malformed
// assignment read the same 404 (C-23). The answer is checked against its
// contract before it leaves.
import type { IncomingMessage } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createSubmissionReconstructionPort,
  type SubmissionReconstructionPort,
  type WithActor,
} from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  const answer = found?.responses.find((r) => r.status === 200)?.body;
  if (found === undefined || answer === undefined) throw new Error(`no contract ${id}`);
  return { contract: found, body: answer };
}
const { contract, body } = contractOf("student.assignment-submission-reconstruction.get");

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

export function createSubmissionReconstructionRoutes(port: SubmissionReconstructionPort): Route[] {
  return [
    {
      contract,
      async handle(request, response, params) {
        if (!sameOrigin(request)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const segment = params?.assignmentId;
        if (segment === undefined || !UUID.test(segment))
          return sendProblem(response, 404, "not_found");
        try {
          const result = await port.read(token, segment.toLowerCase());
          if (result.status === "unauthorized") return sendProblem(response, 401, "unauthorized");
          if (result.status !== "read") return sendProblem(response, 404, "not_found");
          const answer = { state: result.state };
          if (Value.Check(body, answer)) return sendJson(response, 200, answer);
          throw new Error("answer outside the contract");
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}

/** The route over main's application withActor. */
export function createSubmissionReconstructionRoutesFor(main: { withActor: WithActor }): Route[] {
  return createSubmissionReconstructionRoutes(createSubmissionReconstructionPort(main.withActor));
}
