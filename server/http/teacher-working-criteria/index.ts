import { Value } from "@sinclair/typebox/value";

import { ROUTES, WORKING_CRITERION_IDS, workIdFromPath } from "../../contracts/index.ts";
import {
  createTeacherWorkingCriteria,
  type WithActor,
  type WorkingCriterionAssessment,
  type WorkingCriterionId,
} from "../../database/index.ts";
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

// GET and PUT /api/v1/teacher/works/{documentId}/working-criteria[/{criterionId}]
// (SRV-1107): the teacher's working note of six criteria. The session decides
// who asks; the RPCs decide the relation to the work. Nothing of the work is
// read: a student, another teacher, an unknown work and an unknown criterion
// all read the same 404 here.
// GET /api/v1/student/works/{documentId}/working-criteria (SRV-ED35, Daniel's
// decision of 26. 11. 2026 replacing B-9): the student who owns the work reads
// every teacher's criteria, each teacher separately; anyone else reads 404.
const LIST = ROUTES.find((route) => route.id === "teacher.working-criteria.get")!;
const SAVE = ROUTES.find((route) => route.id === "teacher.working-criterion.put")!;
const STUDENT = ROUTES.find((route) => route.id === "student.working-criteria.get")!;
const LIST_BODY = LIST.responses.find((response) => response.status === 200)!.body!;
const STUDENT_BODY = STUDENT.responses.find((response) => response.status === 200)!.body!;
const SAVE_BODY = SAVE.responses.find((response) => response.status === 200)!.body!;

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;

function criterionIdOf(value: string | undefined): WorkingCriterionId | undefined {
  const id = workIdFromPath(value ?? "");
  return WORKING_CRITERION_IDS.find((known) => known === id);
}

function unavailable(response: Parameters<typeof sendProblem>[0], id: string, error: unknown) {
  reportServerError("route", error, requestIdOf(response), id);
  sendProblem(response, 503, "unavailable");
}

export function createTeacherWorkingCriteriaRoutesFor({
  withActor,
}: {
  withActor: WithActor;
}): Route[] {
  const criteria = createTeacherWorkingCriteria(withActor);
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await criteria.list(token, documentId);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "unavailable") {
            return unavailable(response, LIST.id, new Error("working criteria unavailable"));
          }
          return sendProblem(response, 404, "not_found");
        }
        const body = {
          criteria: result.criteria.map(({ id, label, assessment, note }) => ({
            id,
            label,
            assessment,
            note,
          })),
        };
        if (!Value.Check(LIST_BODY, body)) {
          return unavailable(response, LIST.id, new Error("invalid working criteria"));
        }
        sendJson(response, 200, body);
      },
    },
    {
      contract: STUDENT,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await criteria.forStudent(token, documentId);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "unavailable") {
            return unavailable(response, STUDENT.id, new Error("working criteria unavailable"));
          }
          return sendProblem(response, 404, "not_found");
        }
        const body = {
          teachers: result.teachers.map(({ teacherId, teacherName, criteria: own }) => ({
            teacherId,
            teacherName:
              teacherName === null
                ? null
                : { givenName: teacherName.givenName, familyName: teacherName.familyName },
            criteria: own.map(({ id, label, assessment, note }) => ({
              id,
              label,
              assessment,
              note,
            })),
          })),
        };
        if (!Value.Check(STUDENT_BODY, body)) {
          return unavailable(response, STUDENT.id, new Error("invalid working criteria"));
        }
        sendJson(response, 200, body);
      },
    },
    {
      contract: SAVE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          SAVE.request.maxBodyBytes ?? 0,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        const documentId = workIdFromPath(params?.documentId ?? "");
        const criterionId = criterionIdOf(params?.criterionId);
        if (documentId === null || criterionId === undefined) {
          return sendProblem(response, 404, "not_found");
        }
        if (!Value.Check(SAVE.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { assessment, note } = json.value as {
          assessment: WorkingCriterionAssessment | null;
          note: string | null;
        };
        if (
          note !== null &&
          (note.trim() === "" ||
            note !== note.normalize("NFC") ||
            /\p{Cc}/u.test(note.replace(/[\n\t]/gu, "")) ||
            BIDI.test(note))
        ) {
          return sendProblem(response, 422, "invalid_input");
        }
        const result = await criteria.save(token, documentId, criterionId, assessment, note);
        if (result.status !== "saved") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
          return unavailable(response, SAVE.id, new Error("working criterion unavailable"));
        }
        const { id, label, assessment: saved, note: savedNote } = result.criterion;
        const body = { id, label, assessment: saved, note: savedNote };
        if (!Value.Check(SAVE_BODY, body)) {
          return unavailable(response, SAVE.id, new Error("invalid working criterion"));
        }
        sendJson(response, 200, body);
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
  ];
}
