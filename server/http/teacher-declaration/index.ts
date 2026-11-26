// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration
// (teacher.declaration.get), SRV-1213. Sec-Fetch-Site, when sent, exactly one
// same-origin (403), then a live session cookie (401). A body the contract
// does not accept is 503, so a payload the database bound under another
// schema never reaches the teacher half-read.
import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  createTeacherDeclarationReader,
  type TeacherDeclarationReader,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { sendJson, sendProblem, type Route } from "../index.ts";

export { createTeacherDeclarationConversationRouteFor } from "./conversation.ts";

const ID = "teacher.declaration.get";

export function createTeacherDeclarationRoute(read: TeacherDeclarationReader): Route {
  const contract = ROUTES.find((entry) => entry.id === ID);
  const body = contract?.responses.find((response) => response.status === 200)?.body;
  if (contract === undefined || body === undefined) throw new Error(`no contract ${ID}`);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = workIdFromPath(params?.assignmentId ?? "") ?? "";
      const studentId = workIdFromPath(params?.studentId ?? "") ?? "";
      const result = await read(token, assignmentId, studentId);
      switch (result.status) {
        case "ok":
          if (Value.Check(body, result.body)) return sendJson(response, 200, result.body);
          return sendProblem(response, 503, "unavailable");
        case "unauthenticated":
          return sendProblem(response, 401, "unauthorized");
        case "not_found":
          return sendProblem(response, 404, "not_found");
        case "unavailable":
          return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createTeacherDeclarationRouteFor(main: { withActor: WithActor }): Route {
  return createTeacherDeclarationRoute(createTeacherDeclarationReader(main.withActor));
}
