// The student's two writes of wave 2 (SRV-10, Ductus#2028 c.7008147932):
// POST /api/v1/student/enrollments (student.enrollments.post, A-2) over the
// port of institution.enroll_with_code (SRV-05), and
// POST /api/v1/student/assignments/{assignmentId}/notice-read
// (student.notice-read.post, PO-7) over institution.mark_notice_read (SRV-06).
// F4-OPE-R03-SRV: POST /api/v1/institution/enrollments
// (institution.enrollments.post), the v1 route of Ductus enrollment-route.ts,
// over the same port and edge: the RPC alone decides, from the session's
// account, which course a code opens. Its contract tells no outcome apart: a
// wrong, foreign or expired code is one 422 refused, so a code of another
// institution reads exactly as one no course has, and a success is {courseId}.
// The edge is that of acknowledgment-route in Ductus 078c780: origin and
// Sec-Fetch-Site are pipeline step 7; then the assignment id (400
// invalid_assignment_id, before the session), the session token (401),
// Content-Type application/json with at most charset=utf-8 (415), the body
// under the contract's limit and 5 s, strict UTF-8 JSON (400), the body's own
// check (422), the port. An accepted write counts as session activity once
// done; a throw is 503 and reported. The bodies are server/institution.
import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES, workIdFromPath } from "../contracts/index.ts";
import {
  createInstitutionEnrollment,
  createStudentNoticeRead,
  ENROLLMENT_EXPIRED_CODE,
  ENROLLMENT_FORBIDDEN,
  ENROLLMENT_REFUSED,
  ENROLLMENT_TOO_MANY_ATTEMPTS,
  ENROLLMENT_UNAUTHENTICATED,
  type InstitutionEnrollment,
  type StudentNoticeRead,
} from "../database/index.ts";
import { parseNoticeReadBody, parseStudentEnrollmentBody } from "../institution/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

export const STUDENT_WRITE_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** application/json, with no parameter but charset=utf-8. */
const MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

export type StudentWriteOptions = {
  readonly enrollment: InstitutionEnrollment;
  readonly noticeRead: StudentNoticeRead;
  /** Session activity for an accepted write. */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const contractOf = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};

const ENROLLMENT_REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  [ENROLLMENT_UNAUTHENTICATED.code, [401, "unauthorized"]],
  [ENROLLMENT_FORBIDDEN.code, [403, "forbidden"]],
  [ENROLLMENT_REFUSED.code, [422, "invalid_code"]],
  [ENROLLMENT_EXPIRED_CODE.code, [422, "expired_code"]],
  [ENROLLMENT_TOO_MANY_ATTEMPTS.code, [429, "too_many_attempts"]],
]);
/** The v1 route: invalid_code and expired_code are one refusal (no new error on API v1). */
const V1_ENROLLMENT_REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  [ENROLLMENT_UNAUTHENTICATED.code, [401, "unauthorized"]],
  [ENROLLMENT_FORBIDDEN.code, [403, "forbidden"]],
  [ENROLLMENT_REFUSED.code, [422, "refused"]],
  [ENROLLMENT_EXPIRED_CODE.code, [422, "refused"]],
  [ENROLLMENT_TOO_MANY_ATTEMPTS.code, [429, "too_many_attempts"]],
]);
const NOTICE_REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["not_found", [404, "not_found"]],
  ["conflict", [409, "conflict"]],
]);

type Written = { ok: true; body: Record<string, unknown> } | { ok: false; refusal: string };
type Write<B> = (token: string, body: B, assignmentId: string) => Promise<Written>;

function writeRoute<B>(
  id: string,
  parse: (text: string, value: unknown) => B | null,
  refusals: ReadonlyMap<string, readonly [number, string]>,
  write: Write<B>,
  options: StudentWriteOptions,
): Route {
  const contract = contractOf(id);
  const timeoutMs = options.timeoutMs ?? STUDENT_WRITE_TIMEOUT_MS;
  const withPath = contract.path.includes("{assignmentId}");
  return {
    contract,
    async handle(request: IncomingMessage, response: ServerResponse, params) {
      const assignmentId = withPath ? (workIdFromPath(params?.assignmentId ?? "") ?? "") : "";
      if (withPath && !UUID.test(assignmentId)) {
        return refuse(response, 400, "invalid_assignment_id");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes ?? 0, timeoutMs);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      const body = parse(json.text, json.value);
      if (body === null) return sendProblem(response, 422, "invalid_input");
      try {
        const written = await write(token, body, assignmentId.toLowerCase());
        if (!written.ok) {
          const [status, code] = refusals.get(written.refusal) ?? [503, "unavailable"];
          return sendProblem(response, status, code);
        }
        sendJson(response, 200, written.body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted write counts, once done; a failure costs only the touch.
      void options.recordActivity(token).catch(() => undefined);
    },
  };
}

export function createStudentWriteRoutes(options: StudentWriteOptions): Route[] {
  return [
    writeRoute(
      "student.enrollments.post",
      parseStudentEnrollmentBody,
      ENROLLMENT_REFUSALS,
      async (token, { code }) => {
        const enrolled = await options.enrollment.enrollWithCode(token, code);
        return enrolled.ok
          ? {
              ok: true,
              body: { outcome: enrolled.value.outcome, courseId: enrolled.value.courseId },
            }
          : { ok: false, refusal: enrolled.error.code };
      },
      options,
    ),
    writeRoute(
      "student.notice-read.post",
      parseNoticeReadBody,
      NOTICE_REFUSALS,
      async (token, { versionNo }, assignmentId) => {
        const read = await options.noticeRead.markRead(token, assignmentId, versionNo);
        return read.status === "read"
          ? { ok: true, body: { readAt: read.readAt } }
          : { ok: false, refusal: read.status };
      },
      options,
    ),
    writeRoute(
      "institution.enrollments.post",
      parseStudentEnrollmentBody,
      V1_ENROLLMENT_REFUSALS,
      async (token, { code }) => {
        const enrolled = await options.enrollment.enrollWithCode(token, code);
        return enrolled.ok
          ? { ok: true, body: { courseId: enrolled.value.courseId } }
          : { ok: false, refusal: enrolled.error.code };
      },
      options,
    ),
  ];
}

/** The three routes over main's application withActor. */
export function createStudentWriteRoutesFor(main: Pick<Databases["main"], "withActor">): Route[] {
  return createStudentWriteRoutes({
    enrollment: createInstitutionEnrollment(main.withActor),
    noticeRead: createStudentNoticeRead(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
