import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createTeacherSubmittedVersion, type WithActor } from "../../database/index.ts";
import { verifyVersionedDocumentSnapshot } from "../../evidence/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { reportServerError, requestIdOf, type Route, sendJson, sendProblem } from "../index.ts";

// GET /api/v1/teacher/works/{documentId}/submitted-versions/{revision}
// (teacher.work.submitted-version.get, F4-NAS-R20-SRV). The edge only: a live
// session cookie (401), a path id decoded once (an id that is not one is the
// same 404 as another's work, C-23), a revision number (422), then the database
// decides whether the caller teaches the course and whether the revision is the
// submitted one. The text is verified against its hash before it is released.
const CONTRACT = ROUTES.find((route) => route.id === "teacher.work.submitted-version.get")!;

function revisionOf(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}(?![\s\S])/u.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function createTeacherSubmittedVersionRoutesFor({
  withActor,
}: {
  withActor: WithActor;
}): Route[] {
  const versions = createTeacherSubmittedVersion(withActor);
  return [
    {
      contract: CONTRACT,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null || !isWorkId(documentId)) {
          return sendProblem(response, 404, "not_found");
        }
        const revision = revisionOf(params?.revision ?? "");
        if (revision === null) return sendProblem(response, 422, "invalid_input");
        try {
          const result = await versions.get(token, documentId, revision);
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (result.status !== "ok") {
            reportServerError(
              "route",
              new Error("submitted version unavailable"),
              requestIdOf(response),
              CONTRACT.id,
            );
            return sendProblem(response, 503, "unavailable");
          }
          const checked = await verifyVersionedDocumentSnapshot(Buffer.from(result.body, "utf8"));
          if (!checked.ok || checked.sha256 !== result.hash) {
            return sendProblem(response, 503, "unavailable");
          }
          return sendJson(response, 200, { revision: result.revision, document: checked.text });
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), CONTRACT.id);
          return sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}
