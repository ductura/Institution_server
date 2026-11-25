// SRV-V17-FORMAT-RULES: the HTTP edge of student.assignment-format-rules.get. The rules are
// composed, not stored: the word range from the reader of the assignment requirements (SRV-22)
// and the skeleton and citation style from the template frozen on the assignment
// (SRV-V17-TEMPLATE-ASSIGN). Who may read is the database's (a student of the course); the
// caller comes from the session, the assignment from the path. A malformed, foreign or unknown
// id is the same 404 (C-23); a query is 422; an answer outside the contract, or a throw, is 503
// and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { studentAssignmentFormatRulesGet, type FormatRules } from "../../contracts/index.ts";
import {
  createAssignmentTemplate,
  createMySubmissionStateReader,
  type AssignmentTemplate,
  type MySubmissionStateReader,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNAUTHENTICATED = "MY_SUBMISSION_STATE_UNAUTHENTICATED";
const NOT_FOUND = "MY_SUBMISSION_STATE_NOT_FOUND";

type Answer = { status: 200; body: FormatRules } | { status: 401 | 404 | 422 | 503 };

/** The rules of `assignmentId` for the session behind `token`. */
export async function readFormatRules(
  requirements: MySubmissionStateReader,
  template: AssignmentTemplate,
  token: string,
  assignmentId: string,
): Promise<Answer> {
  // The word range is read first: it is the one read that tells a student of the course from
  // anyone else, so a foreign assignment never reaches the template.
  const range = await requirements.requirements(token, assignmentId);
  if (!range.ok) {
    if (range.error.code === UNAUTHENTICATED) return { status: 401 };
    if (range.error.code === NOT_FOUND) return { status: 404 };
    return { status: 503 };
  }
  const frozen = await template.read(token, assignmentId);
  let requiredSections: string[] = [];
  switch (frozen.status) {
    case "found":
      requiredSections = frozen.template.sections.map((section) => section.title);
      break;
    case "unauthorized":
      return { status: 401 };
    case "invalid_input":
      return { status: 503 };
    default:
      // no_template, not_found (a mentorship assignment) and conflict (not reachable): no
      // skeleton, the other rules still stand.
      break;
  }
  return {
    status: 200,
    body: {
      wordMin: range.value.wordMin,
      wordMax: range.value.wordMax,
      minSources: 0,
      requiredSections,
      citationStyle: frozen.status === "found" ? frozen.template.citationStyle : "fpzg",
      font: null,
      size: null,
      spacing: null,
    },
  };
}

const PROBLEM = {
  401: "unauthorized",
  404: "not_found",
  422: "invalid_input",
  503: "unavailable",
} as const;

export function createFormatRulesRoutesFor(main: { withActor: WithActor }): Route[] {
  const requirements = createMySubmissionStateReader(main.withActor);
  const template = createAssignmentTemplate(main.withActor);
  const contract = studentAssignmentFormatRulesGet;
  const success = contract.responses[0];
  return [
    {
      contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const target = request.url ?? "";
        const queryAt = target.indexOf("?");
        if (queryAt >= 0 && new URLSearchParams(target.slice(queryAt + 1)).size > 0) {
          return sendProblem(response, 422, "invalid_input");
        }
        const sent = params?.assignmentId ?? "";
        if (!UUID.test(sent)) return sendProblem(response, 404, "not_found");
        try {
          const answer = await readFormatRules(requirements, template, token, sent.toLowerCase());
          if (answer.status !== 200) {
            return sendProblem(response, answer.status, PROBLEM[answer.status]);
          }
          if (Value.Check(success.body, answer.body)) return sendJson(response, 200, answer.body);
          reportServerError(
            "route",
            new Error("answer outside the contract"),
            requestIdOf(response),
            contract.id,
          );
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), contract.id);
        }
        return sendProblem(response, 503, "unavailable");
      },
    },
  ];
}
