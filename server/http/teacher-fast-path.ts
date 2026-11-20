// POST /api/v1/teacher/fast-path (contract teacher.fast-path.post; SRV-8E,
// N-05, Ductus#2028). The HTTP edge of readFastPath (server/teacher/fast-path.ts,
// Ductus B-11c, #757), as process-summary.ts: origin and Sec-Fetch-Site are
// pipeline step 7; then the session cookie (401), Content-Type
// application/json with at most charset=utf-8 (415), the body under the
// contract's 1 KiB and 5 s, strict UTF-8 JSON (400) and exactly
// {assignmentId}, a UUID in any case (422; a role, window or student is
// refused, never read). Who reads comes only from the session token: access
// is the teacher's relation to the assignment (C-23), decided by
// app.fast_path_works under withActor, which also writes the access log row of
// each opened text (B-11b). An assignment the caller does not teach, or that
// does not exist, is the same empty list, never 403 or 404. The mentor's own
// working records never enter this read, and the read writes nothing to the
// work: the comment is a derived view of a separate record (ARCHITECTURE §5a).
// Thresholds come from configuration (rule 12); a value that is set and
// invalid is 503 for every reader.
import { ROUTES } from "../contracts/index.ts";
import type { WithActor } from "../database/index.ts";
import type { InstitutionEvidencePayloadReader } from "../external/storage/index.ts";
import { loadProcessSummaryThresholds } from "../projection/process-summary.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";
import { type FastPathRead, readFastPath } from "../teacher/fast-path.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

export const TEACHER_FAST_PATH_TIMEOUT_MS = 5_000;
/** application/json, with no parameter but charset=utf-8. */
const MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "teacher.fast-path.post");
  if (found === undefined) throw new Error("no contract teacher.fast-path.post");
  return found;
})();

/** The fast path of one assignment for the session `token`; null when the thresholds are invalid. */
export type ReadTeacherFastPath =
  ((token: string, assignmentId: string) => Promise<FastPathRead>) | null;

export type TeacherFastPathRouteOptions = {
  readonly read: ReadTeacherFastPath;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** Exactly `{assignmentId}` with a UUID, in lowercase; anything else is null. */
export function parseTeacherFastPathBody(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 1) return null;
  const { assignmentId } = value as { assignmentId?: unknown };
  return typeof assignmentId === "string" && UUID.test(assignmentId)
    ? assignmentId.toLowerCase()
    : null;
}

export function createTeacherFastPathRoute(options: TeacherFastPathRouteOptions): Route {
  const timeoutMs = options.timeoutMs ?? TEACHER_FAST_PATH_TIMEOUT_MS;
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, CONTRACT.request.maxBodyBytes ?? 0, timeoutMs);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      const assignmentId = parseTeacherFastPathBody(json.value);
      if (assignmentId === null) return sendProblem(response, 422, "invalid_input");
      if (options.read === null) return unavailable(response, "thresholds_invalid");
      let read: FastPathRead;
      try {
        read = await options.read(token, assignmentId);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      switch (read.kind) {
        case "ok":
          return sendJson(response, 200, read);
        case "unauthorized":
          // The same answer as a missing cookie.
          return sendProblem(response, 401, "unauthorized");
        default:
          return unavailable(response, "read_failed");
      }
    },
  };
}

/** 503 with one line on stderr: a closed reason code and the request id, never an id or a text. */
function unavailable(response: Parameters<Route["handle"]>[1], reason: string) {
  try {
    console.error(
      JSON.stringify({
        event: "teacher_fast_path_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
  return sendProblem(response, 503, "unavailable");
}

/**
 * The route over main's application withActor, the storage of every
 * institution (readFastPath binds it to the institution of each row) and the
 * thresholds of `env`, the process-summary route's, never a request field.
 */
export function createTeacherFastPathRouteFor(
  main: { readonly withActor: WithActor },
  deps: { readonly payloads: InstitutionEvidencePayloadReader },
  env: Readonly<Record<string, string | undefined>>,
): Route {
  const thresholds = loadProcessSummaryThresholds(env);
  return createTeacherFastPathRoute({
    read:
      thresholds === null
        ? null
        : (token, assignmentId) =>
            readFastPath(token, assignmentId, main.withActor, {
              payloads: deps.payloads,
              thresholds,
              // The closed codes of readFastPath, never a name, a text or an id.
              log: (message, code) =>
                console.error(JSON.stringify({ event: "teacher_fast_path", message, code })),
            }),
  });
}
