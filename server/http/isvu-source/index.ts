// GET /api/v1/institution/admin/isvu/courses and
// POST /api/v1/institution/admin/courses/{courseId}/isvu-roster-imports
// (SRV-V22-ISVU-POPIS; contracts institution.isvu-courses.get and
// institution.isvu-roster-imports.post). The administrator reads the courses of
// the TRIAL ISVU source and previews the students of one; the confirmation is
// the existing institution.roster-import-confirm.post. The source is the
// synthetic adapter (server/external/isvu): invented data, no network, no
// secret. Nothing here reads or writes a grade.
//
// Order of refusals: the session (401), the request's own shape (422), who
// the caller is (403 unless a confirmed administrator), the institution's ISVU
// setting (off is 404, the same as a course that is not there, so the
// integration is not revealed), the source (404 for a course it does not
// know), and last the database's word on the course (404 for another
// institution's, via institution.preview_roster_import).
//
// The students of the source are sent to the SAME preview as a file's rows:
// they are written as a quoted CSV and read by the roster reader, so the same
// rules (identifier, names, duplicates, 1000 rows) apply to them. Matching to
// accounts is by AAI@EduHr identifier only, in the database.
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { isvuCoursesGet, isvuRosterImportsPost } from "../../contracts/index.ts";
import { createRosterImports, type RosterImports, type WithActor } from "../../database/index.ts";
import {
  createSyntheticIsvu,
  isvuPortFor,
  PRODUCTION_ISVU_SETTING,
  readIsvuSettingFile,
  type IsvuMode,
  type IsvuPort,
  type IsvuRosterRow,
} from "../../external/isvu/index.ts";
import { parseRosterCsv } from "../../institution/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  decodeOnce,
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
  reportServerError,
  requestIdOf,
  rosterPreviewAnswer,
  sendJson,
  sendProblem,
  type Databases,
  type Route,
} from "../index.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const ACADEMIC_YEAR = /^\d{4}\/\d{4}$/;
const SOURCE_COURSE_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const COURSES_MAX = 200;

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["invalid", [422, "invalid_input"]],
] as const);

type Row = Record<string, unknown>;
export type IsvuCaller =
  | { readonly kind: "ok"; readonly institutionSlug: string | null }
  | { readonly kind: "unauthorized" | "forbidden" | "unavailable" };

const CALLER_QUERY = `SELECT (SELECT a.user_id FROM app.current_actor() a) IS NOT NULL AS authenticated,
    institution.actor_has_role('admin') AS admin,
    app.current_institution_slug() AS "institutionSlug"`;

const codeOf = (error: unknown): string | undefined => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
};

/** Who the session is: open, a confirmed administrator, and the slug of its institution. */
export function createIsvuCallerReader(withActor: WithActor) {
  return async (token: string): Promise<IsvuCaller> => {
    if (!TOKEN.test(token)) return { kind: "unauthorized" };
    let rows: Row[];
    try {
      rows = await withActor(token, async (tx) => (await tx.query<Row>(CALLER_QUERY)).rows);
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD401") return { kind: "unauthorized" };
      if (code === "ZD403") return { kind: "forbidden" };
      console.error(
        "isvu caller read failed",
        code !== undefined && SQLSTATE.test(code) ? code : "unknown",
      );
      return { kind: "unavailable" };
    }
    const row = rows.length === 1 ? rows[0]! : undefined;
    if (row?.authenticated === false) return { kind: "unauthorized" };
    if (row?.authenticated !== true || typeof row.admin !== "boolean") {
      return { kind: "unavailable" };
    }
    if (!row.admin) return { kind: "forbidden" };
    const slug = row.institutionSlug;
    return { kind: "ok", institutionSlug: typeof slug === "string" ? slug : null };
  };
}

export type IsvuSourceRouteOptions = {
  readonly readCaller: (token: string) => Promise<IsvuCaller>;
  readonly imports: RosterImports;
  /** The port of an institution: null when its setting is off (the answer is 404). */
  readonly portFor: (institutionSlug: string | null) => IsvuPort | null;
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const quoted = (cell: string) => `"${cell.replace(/"/g, '""')}"`;

/** The source's rows as one quoted CSV, for the roster reader. */
const csvOf = (rows: readonly IsvuRosterRow[]): string =>
  [
    "identifikator;ime;prezime",
    ...rows.map((r) => [r.identifier, r.givenName, r.familyName].map(quoted).join(";")),
  ].join("\r\n") + "\r\n";

/** Exactly {sourceCourseKey}, a valid key; else null (422). */
export function parseIsvuImportBody(value: unknown): { sourceCourseKey: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(value, "sourceCourseKey")) return null;
  const key = (value as Record<string, unknown>).sourceCourseKey;
  return typeof key === "string" && SOURCE_COURSE_KEY.test(key) ? { sourceCourseKey: key } : null;
}

export function createIsvuSourceRoutes(options: IsvuSourceRouteOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  const touch = (token: string) => void options.recordActivity(token).catch(() => undefined);
  const coursesBody = isvuCoursesGet.responses[0].body;

  /** The port and institution of this session, or null when the refusal is already sent. */
  async function portOf(
    response: Parameters<Route["handle"]>[1],
    token: string,
  ): Promise<{ readonly port: IsvuPort; readonly slug: string | null } | null> {
    const caller = await options.readCaller(token);
    if (caller.kind === "unauthorized") sendProblem(response, 401, "unauthorized");
    else if (caller.kind === "forbidden") sendProblem(response, 403, "forbidden");
    else if (caller.kind === "unavailable") sendProblem(response, 503, "unavailable");
    else if (caller.kind === "ok") {
      const port = options.portFor(caller.institutionSlug);
      if (port !== null) return { port, slug: caller.institutionSlug };
      sendProblem(response, 404, "not_found");
    }
    return null;
  }

  const courses: Route = {
    contract: isvuCoursesGet,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const target = request.url ?? "";
      const queryAt = target.indexOf("?");
      const query = new URLSearchParams(queryAt >= 0 ? target.slice(queryAt + 1) : "");
      const years = query.getAll("academicYear");
      const [year] = years;
      if (
        query.size !== 1 ||
        years.length !== 1 ||
        year === undefined ||
        !ACADEMIC_YEAR.test(year)
      ) {
        return sendProblem(response, 422, "invalid_input");
      }
      try {
        const found = await portOf(response, token);
        if (found === null) return;
        const { port, slug } = found;
        const listed = await port.listCourses({ institutionKey: slug ?? "", academicYear: year });
        const body = {
          mode: port.mode,
          courses: listed.slice(0, COURSES_MAX).map((course) => ({
            sourceCourseKey: course.sourceCourseKey,
            name: course.name,
            academicYear: course.academicYear,
            enrolledCount: course.enrolledCount,
          })),
        };
        if (listed.length > COURSES_MAX || !Value.Check(coursesBody, body)) {
          throw new Error("answer outside the contract");
        }
        sendJson(response, 200, body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), isvuCoursesGet.id);
        return sendProblem(response, 503, "unavailable");
      }
      touch(token);
    },
  };

  const preview: Route = {
    contract: isvuRosterImportsPost,
    async handle(request, response, params) {
      const courseId = decodeOnce(params?.courseId);
      const maxBytes = isvuRosterImportsPost.request.maxBodyBytes ?? 1024;
      const input = await readInstitutionJson(request, response, [courseId], maxBytes, timeoutMs);
      if (input === null) return;
      const body = parseIsvuImportBody(input.value);
      if (body === null) return sendProblem(response, 422, "invalid_input");
      try {
        const found = await portOf(response, input.token);
        if (found === null) return;
        const { port } = found;
        const enrolled = await port.listEnrolled(body.sourceCourseKey);
        if (enrolled === null) return sendProblem(response, 404, "not_found");
        const parsed = parseRosterCsv(csvOf(enrolled));
        if (!parsed.ok) throw new Error(`source roster refused: ${parsed.error}`);
        const rows = parsed.rows.map((row, at) => ({ ...row, line: at + 2 }));
        const candidates = rows.filter((row) => row.problem === null);
        const outcome = await options.imports.preview(
          input.token,
          courseId.toLowerCase(),
          "isvu",
          candidates,
        );
        if (outcome.status !== "previewed") {
          const [code, name] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
          return sendProblem(response, code, name);
        }
        sendJson(response, 200, rosterPreviewAnswer("isvu", rows, outcome));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), isvuRosterImportsPost.id);
        return sendProblem(response, 503, "unavailable");
      }
      touch(input.token);
    },
  };

  return [courses, preview];
}

export type IsvuSourceComposition = {
  /** True for local work and CI (NODE_ENV development or test); production is always off. */
  readonly local: boolean;
  /** For tests: the faculty settings root. */
  readonly root?: string;
};

/**
 * The two routes over main's withActor. In production the setting is the
 * constant PRODUCTION_ISVU_SETTING (off), so both answer 404; locally and in
 * CI each faculty's config/faculties/<faculty>/isvu.json decides, and only the
 * synthetic adapter exists. server/server.ts mounts them.
 */
export function createIsvuSourceRoutesFor(
  main: Pick<Databases["main"], "withActor">,
  composition: IsvuSourceComposition = { local: false },
): Route[] {
  const adapter = createSyntheticIsvu();
  const root = composition.root ?? resolve("config/faculties");
  return createIsvuSourceRoutes({
    readCaller: createIsvuCallerReader(main.withActor),
    imports: createRosterImports(main.withActor),
    portFor: (slug) => {
      const mode: IsvuMode =
        !composition.local || slug === null
          ? PRODUCTION_ISVU_SETTING.mode
          : readIsvuSettingFile(root, slug).mode;
      return isvuPortFor({ mode }, adapter);
    },
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
