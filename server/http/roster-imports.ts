// POST /api/v1/institution/admin/courses/{courseId}/roster-imports and
// POST /api/v1/institution/admin/roster-imports/{importId}/confirm
// (SRV-ADMIN-2, NF-7 OA-10; contracts institution.roster-imports.post and
// institution.roster-import-confirm.post) over institution.preview_roster_import
// and confirm_roster_import (20261215100000), behind the same JSON reader as
// the course routes. The preview reads the CSV here (server/institution
// parseRosterCsv): rows the file already rules out (identifier, names,
// duplicate) never reach the database; the others are judged there. Who may
// is the RPCs' decision: a confirmed administrator of the institution only.
import {
  type RosterConfirmOutcome,
  type RosterImports,
  type RosterPreviewOutcome,
  createRosterImports,
} from "../database/index.ts";
import {
  parseRosterCsv,
  ROSTER_IMPORT_MAX_CSV_LENGTH,
  type RosterRow,
} from "../institution/index.ts";
import { ROUTES } from "../contracts/index.ts";
import { recordActivity } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import {
  decodeOnce,
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
} from "./institution-courses.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const PREVIEW = ROUTES.find((route) => route.id === "institution.roster-imports.post")!;
const CONFIRM = ROUTES.find((route) => route.id === "institution.roster-import-confirm.post")!;
const SOURCES = new Set(["merlin", "isvu"]);
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["invalid", [422, "invalid_input"]],
  ["expired", [410, "import_expired"]],
] as const);

export type RosterImportBody = { readonly source: "merlin" | "isvu"; readonly csv: string };

/** Exactly {source, csv}: source merlin or isvu, csv a string within the limit; else null (422). */
export function parseRosterImportBody(value: unknown): RosterImportBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "source") || !Object.hasOwn(value, "csv")) {
    return null;
  }
  const { source, csv } = value as Record<string, unknown>;
  if (typeof source !== "string" || !SOURCES.has(source)) return null;
  if (typeof csv !== "string" || csv.length > ROSTER_IMPORT_MAX_CSV_LENGTH) return null;
  return { source: source as RosterImportBody["source"], csv };
}

type PreviewRow = {
  line: number;
  identifier: string;
  givenName: string;
  familyName: string;
  status: "new" | "already_enrolled" | "unsuitable";
  reason: string | null;
};

/** The answer of a preview: the file's rows with the database's word on those it was sent. */
export function previewAnswer(
  source: RosterImportBody["source"],
  rows: readonly RosterRow[],
  outcome: Extract<RosterPreviewOutcome, { status: "previewed" }>,
) {
  const statuses = [...outcome.statuses];
  const answered = rows.map((row): PreviewRow => {
    const cells = {
      line: row.line,
      identifier: row.identifier,
      givenName: row.givenName,
      familyName: row.familyName,
    };
    if (row.problem !== null) return { ...cells, status: "unsuitable", reason: row.problem };
    const said = statuses.shift();
    if (said === "new" || said === "already_enrolled")
      return { ...cells, status: said, reason: null };
    return { ...cells, status: "unsuitable", reason: said ?? "unknown_account" };
  });
  const count = (status: PreviewRow["status"]) =>
    answered.filter((row) => row.status === status).length;
  return {
    importId: outcome.importId,
    source,
    expiresAt: outcome.expiresAt,
    counts: {
      new: count("new"),
      alreadyEnrolled: count("already_enrolled"),
      unsuitable: count("unsuitable"),
    },
    rows: answered,
  };
}

/** The answer of a confirmation. */
export const confirmAnswer = (outcome: Extract<RosterConfirmOutcome, { status: "confirmed" }>) => ({
  enrolled: outcome.enrolled,
  alreadyEnrolled: outcome.alreadyEnrolled,
  skipped: outcome.skipped,
  alreadyConfirmed: outcome.alreadyConfirmed,
});

export type RosterImportRouteOptions = {
  readonly imports: RosterImports;
  /** Session activity for an accepted answer (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

const refused = (response: Parameters<Route["handle"]>[1], status: string) => {
  const [code, name] = REFUSALS.get(status) ?? [503, "unavailable"];
  sendProblem(response, code, name);
};

export function createRosterImportRoutes(options: RosterImportRouteOptions): Route[] {
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  const touch = (token: string) => void options.recordActivity(token).catch(() => undefined);

  const preview: Route = {
    contract: PREVIEW,
    async handle(request, response, params) {
      const courseId = decodeOnce(params?.courseId);
      const maxBytes = PREVIEW.request.maxBodyBytes ?? 64;
      const input = await readInstitutionJson(request, response, [courseId], maxBytes, timeoutMs);
      if (input === null) return;
      const body = parseRosterImportBody(input.value);
      if (body === null) return sendProblem(response, 422, "invalid_input");
      const parsed = parseRosterCsv(body.csv);
      if (!parsed.ok) return sendProblem(response, 422, parsed.error);
      const candidates = parsed.rows.filter((row) => row.problem === null);
      try {
        const outcome = await options.imports.preview(
          input.token,
          courseId.toLowerCase(),
          body.source,
          candidates,
        );
        if (outcome.status !== "previewed") return refused(response, outcome.status);
        sendJson(response, 200, previewAnswer(body.source, parsed.rows, outcome));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), PREVIEW.id);
        return sendProblem(response, 503, "unavailable");
      }
      touch(input.token);
    },
  };

  const confirm: Route = {
    contract: CONFIRM,
    async handle(request, response, params) {
      const importId = decodeOnce(params?.importId);
      const maxBytes = CONFIRM.request.maxBodyBytes ?? 64;
      const input = await readInstitutionJson(request, response, [importId], maxBytes, timeoutMs);
      if (input === null) return;
      const value = input.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      if (Object.keys(value).length !== 0) return sendProblem(response, 422, "invalid_input");
      try {
        const outcome = await options.imports.confirm(input.token, importId.toLowerCase());
        if (outcome.status !== "confirmed") return refused(response, outcome.status);
        sendJson(response, 200, confirmAnswer(outcome));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONFIRM.id);
        return sendProblem(response, 503, "unavailable");
      }
      touch(input.token);
    },
  };

  return [preview, confirm];
}

/** The two routes over main's application withActor; server/server.ts mounts them. */
export function createRosterImportRoutesFor(main: Pick<Databases["main"], "withActor">): Route[] {
  return createRosterImportRoutes({
    imports: createRosterImports(main.withActor),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
