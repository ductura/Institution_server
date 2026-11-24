// GET /api/v1/student/assignments/{assignmentId}/submission
// (student.submission.get) and .../requirements
// (student.assignment-requirements.get), SRV-22 (Ductus#2028 c.7009405737):
// the caller's own submission state and the word range of one assignment.
// The HTTP edge only, as student-access-log.ts: Sec-Fetch-Site, when sent,
// exactly one same-origin (403), then a live session cookie (401); an
// assignment id that is not a uuid is the same 404 as another's or an unknown
// one (C-23), and an upper-case uuid is read as its lower-case form. The
// answers are server/institution/student-submission-route.ts and
// student-requirements-route.ts; a body the contract does not accept, or a
// throw, is 503 and the throw is reported, never a partial answer.
// SRV-NF1-PREDANO: GET /api/v1/student/assignment-submissions
// (student.assignment-submissions.get), when each own submission was confirmed,
// has no assignment id; its answer is student-assignment-submissions-route.ts.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import {
  createMyAssignmentSubmissionsReader,
  createMySubmissionStateReader,
  type MyAssignmentSubmissionsReader,
  type MySubmissionStateReader,
} from "../database/index.ts";
import {
  readStudentAssignmentSubmissions,
  readStudentRequirements,
  readStudentSubmission,
} from "../institution/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";
import { createTeacherSubmissionReceiptRoute } from "./teacher-submission-receipt.ts";

type Answer = { status: 200; body: unknown } | { status: 401 | 404 | 503 };
type Read = (reader: MySubmissionStateReader, token: string, id: string) => Promise<Answer>;

const PROBLEM = { 401: "unauthorized", 404: "not_found", 503: "unavailable" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  const body = found?.responses.find((response) => response.status === 200)?.body;
  if (found === undefined || body === undefined) throw new Error(`no contract ${id}`);
  return { contract: found, body };
}

function createRoute(id: string, reader: MySubmissionStateReader, read: Read): Route {
  const { contract, body } = contractOf(id);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const sent = params?.assignmentId ?? "";
      if (!UUID.test(sent)) return sendProblem(response, 404, "not_found");
      try {
        const answer = await read(reader, token, sent.toLowerCase());
        if (answer.status !== 200)
          return sendProblem(response, answer.status, PROBLEM[answer.status]);
        if (Value.Check(body, answer.body)) return sendJson(response, 200, answer.body);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The own submissions of every assignment at once, over the list reader. */
export function createStudentAssignmentSubmissionsRoute(
  reader: MyAssignmentSubmissionsReader,
): Route {
  const id = "student.assignment-submissions.get";
  const { contract, body } = contractOf(id);
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
        const answer = await readStudentAssignmentSubmissions(reader, token);
        if (answer.status !== 200)
          return sendProblem(response, answer.status, PROBLEM[answer.status]);
        if (Value.Check(body, answer.body)) return sendJson(response, 200, answer.body);
        reportServerError(
          "route",
          new Error("answer outside the contract"),
          requestIdOf(response),
          id,
        );
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The two routes over one reader: the submission state, then the requirements. */
export function createStudentSubmissionRoutes(reader: MySubmissionStateReader): Route[] {
  return [
    createRoute("student.submission.get", reader, readStudentSubmission),
    createRoute("student.assignment-requirements.get", reader, readStudentRequirements),
  ];
}

/** The routes over main's application withActor, with the teacher's read of SRV-30. */
export function createStudentSubmissionRoutesFor(
  main: Pick<Databases["main"], "withActor">,
): Route[] {
  const reader = createMySubmissionStateReader(main.withActor);
  // SRV-30: the teacher's read of one student's state shares the reader.
  // SRV-NF1-PREDANO: the list of the same states, over its own one statement.
  return [
    ...createStudentSubmissionRoutes(reader),
    createTeacherSubmissionReceiptRoute(reader),
    createStudentAssignmentSubmissionsRoute(createMyAssignmentSubmissionsReader(main.withActor)),
  ];
}
