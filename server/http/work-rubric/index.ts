// SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17): the HTTP edge of the teacher's marks of a level per
// criterion of an assignment's rubric, on one work. The session decides who asks; the RPCs decide
// the relation to the work. Nothing of the work is read, and the answer never reaches a student:
// a student, another teacher, an unknown work and a criterion outside the latest rubric version
// all read the same 404. Input outside the contract is 422, an answer outside it or a throw is
// 503 and the throw is reported.
import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkRubric, type WithActor, type WorkRubricLevel } from "../../database/index.ts";
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

const LIST = ROUTES.find((route) => route.id === "teacher.work-rubric.get")!;
const SAVE = ROUTES.find((route) => route.id === "teacher.work-rubric-mark.put")!;
const LIST_BODY = LIST.responses.find((response) => response.status === 200)!.body!;
const SAVE_BODY = SAVE.responses.find((response) => response.status === 200)!.body!;

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const BIDI = /[‪-‮⁦-⁩]/u;
const CRITERION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

function unavailable(response: Parameters<typeof sendProblem>[0], id: string, error: unknown) {
  reportServerError("route", error, requestIdOf(response), id);
  sendProblem(response, 503, "unavailable");
}

export function createWorkRubricRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const rubric = createWorkRubric(withActor);
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const documentId = workIdFromPath(params?.documentId ?? "");
        if (documentId === null) return sendProblem(response, 404, "not_found");
        const result = await rubric.list(token, documentId);
        if (result.status !== "ok") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "unavailable") {
            return unavailable(response, LIST.id, new Error("work rubric unavailable"));
          }
          return sendProblem(response, 404, "not_found");
        }
        const body = {
          rubricVersion: result.rubricVersion,
          marks: result.marks.map(({ criterionId, level, note }) => ({ criterionId, level, note })),
        };
        if (!Value.Check(LIST_BODY, body)) {
          return unavailable(response, LIST.id, new Error("invalid work rubric"));
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
        const criterionId = params?.criterionId ?? "";
        if (documentId === null || !CRITERION_ID.test(criterionId)) {
          return sendProblem(response, 404, "not_found");
        }
        if (!Value.Check(SAVE.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { level, note } = json.value as {
          level: WorkRubricLevel | null;
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
        const result = await rubric.save(token, documentId, criterionId, level, note);
        if (result.status !== "saved") {
          if (result.status === "unauthenticated") {
            return sendProblem(response, 401, "unauthorized");
          }
          if (result.status === "not_found") return sendProblem(response, 404, "not_found");
          if (result.status === "invalid") return sendProblem(response, 422, "invalid_input");
          return unavailable(response, SAVE.id, new Error("work rubric mark unavailable"));
        }
        const { criterionId: id, level: saved, note: savedNote } = result.mark;
        const body = { criterionId: id, level: saved, note: savedNote };
        if (!Value.Check(SAVE_BODY, body)) {
          return unavailable(response, SAVE.id, new Error("invalid work rubric mark"));
        }
        sendJson(response, 200, body);
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
  ];
}
