// GET /api/v1/teacher/assignments/{assignmentId}/merlin/roster and .../merlin/csv
// (teacher.merlin-roster.get, teacher.merlin-roster-csv.get), SRV-1109 (Val 11,
// N-18, C-16, D-286): the Merlin roster of an assignment for its teacher, as
// JSON and as CSV. The HTTP edge only; the projection is
// server/downloads/merlin/roster and access is the database's (the deadline
// extension read refuses anyone but the teacher of the assignment). A
// cross-site read is 403; no session 401; a malformed, refused or unknown id
// the same 404 (C-23); an answer outside the contract, reads that disagree
// or a throw 503 with the throw reported, never a partial roster.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createAssignmentSubmissionsReader,
  createDeadlineExtensions,
  createSubmittedWorksReader,
  type WithActor,
} from "../../database/index.ts";
import {
  createMerlinRosterReader,
  merlinRosterCsv,
  type MerlinLabels,
  type MerlinRosterRead,
  type MerlinRosterReader,
} from "../../downloads/index.ts";
import { merlinHr } from "../../../locales/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import { reportServerError, requestIdOf, sendJson, sendProblem, type Route } from "../index.ts";

/** The catalogue's words; csvHeader is checked to have one header per column. */
export const MERLIN_LABELS: MerlinLabels = {
  csvHeader: merlinHr.csvHeader,
  yes: merlinHr.yes,
  no: merlinHr.no,
  exportLabels: merlinHr.exportLabels,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const MERLIN_CSV_FILENAME = "merlin-popis.csv";

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return contract;
}

type Answer = (
  response: ServerResponse,
  read: Extract<MerlinRosterRead, { status: "read" }>,
) => void;

function route(id: string, read: MerlinRosterReader, answer: Answer): Route {
  const contract = contractOf(id);
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      try {
        const result = await read(token, assignmentId.toLowerCase());
        if (result.status !== "read") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        return answer(response, result);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The two routes over one roster read: JSON, then CSV. */
export function createMerlinRosterRoutes(
  read: MerlinRosterReader,
  labels: MerlinLabels = MERLIN_LABELS,
): Route[] {
  const json = contractOf("teacher.merlin-roster.get");
  const body = json.responses[0]?.body;
  if (body === undefined) throw new Error("no body for teacher.merlin-roster.get");
  return [
    route(json.id, read, (response, result) => {
      const answer = { rows: result.roster.rows, extensionReasons: result.extensionReasons };
      if (!Value.Check(body, answer)) throw new Error("answer outside the contract");
      sendJson(response, 200, answer);
    }),
    route("teacher.merlin-roster-csv.get", read, (response, result) => {
      // The same check as the JSON answer: the CSV never carries a row the JSON would refuse.
      const answer = { rows: result.roster.rows, extensionReasons: [] };
      if (!Value.Check(body, answer)) throw new Error("answer outside the contract");
      const bytes = Buffer.from(merlinRosterCsv(result.roster.rows, labels), "utf8");
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${MERLIN_CSV_FILENAME}"`,
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
      });
      response.end(bytes);
    }),
  ];
}

/** The routes over main's application withActor. */
export function createMerlinRosterRoutesFor(main: { readonly withActor: WithActor }): Route[] {
  const extensions = createDeadlineExtensions(main.withActor);
  return createMerlinRosterRoutes(
    createMerlinRosterReader({
      extensions: (token, assignmentId) => extensions.list(token, assignmentId),
      submissions: createAssignmentSubmissionsReader(main.withActor),
      works: createSubmittedWorksReader(main.withActor),
      labels: MERLIN_LABELS,
    }),
  );
}
