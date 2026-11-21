// SRV-1308 (plan M10.5; D-271 MQ02): the student data export over the RPCs of
// SRV-1307 (contracts institution.student-data-exports.get and .post,
// institution.student-data-exports-approve.post, student.data-export.get).
// The HTTP edge only: who may do what (a clerk of the registry office
// requests, a confirmed administrator who did not request approves) is the
// database's. The mutations go through the shared origin layer and the JSON
// body reader. A body or id the contract does not accept is 422 (a path id
// that is no UUID is 404, as the export cannot exist); an answer outside the
// contract, or a throw, is 503 and the throw is reported, never a partial
// answer.
//
// The download needs no session: the link alone carries the right, as a
// former student may have none. The link is used and the package read in one
// transaction, so a package that cannot be read leaves the link unused (503);
// once sent, the package is removed. A used, expired, unknown or malformed
// link is the same 410.
import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createStudentDataExports,
  type StudentDataExports,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  INSTITUTION_BODY_TIMEOUT_MS,
  readInstitutionJson,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

import {
  linkTokenHash,
  studentDataExportDirectory,
  studentDataExportStorage,
  type StudentDataExportStorage,
} from "./storage.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
/** The name of the package, as student.data-export.get names it. */
const FILENAME = "izvoz-mojih-podataka.zip";

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  const body = contract.responses.find((r) => r.status === 200 || r.status === 201)?.body;
  return { contract, body };
}

const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["not_found", [404, "not_found"]],
  ["conflict", [409, "conflict"]],
  ["invalid", [422, "invalid_input"]],
] as const);

const refusalOf = (status: string): readonly [number, string] =>
  REFUSALS.get(status) ?? [503, "unavailable"];

export type StudentDataExportRouteOptions = {
  readonly exports: StudentDataExports;
  readonly storage: StudentDataExportStorage;
  /** Session activity for an accepted mutation (session/recordActivity). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The stored reference of the identity check: how it was checked and its reference. */
const identityCheckRef = (checkedBy: string, note: string) => `${checkedBy}: ${note}`;

function listRoute({ exports }: StudentDataExportRouteOptions): Route {
  const { contract, body } = contractOf("institution.student-data-exports.get");
  return {
    contract,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const result = await exports.list(token);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { exports: result.exports };
        if (Value.Check(body!, answer)) return sendJson(response, 200, answer);
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
  };
}

function requestRoute(options: StudentDataExportRouteOptions): Route {
  const { contract, body } = contractOf("institution.student-data-exports.post");
  const input = contract.request.body!;
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      const read = await readInstitutionJson(
        request,
        response,
        [],
        contract.request.maxBodyBytes!,
        timeoutMs,
      );
      if (read === null) return;
      if (!Value.Check(input, read.value)) return sendProblem(response, 422, "invalid_input");
      const sent = read.value as { studentId: string; identityCheckedBy: string; note: string };
      try {
        const result = await options.exports.request(read.token, {
          studentId: sent.studentId,
          identityCheckRef: identityCheckRef(sent.identityCheckedBy, sent.note),
        });
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { exportId: result.exportId };
        if (Value.Check(body!, answer)) {
          sendJson(response, 201, answer);
          void options.recordActivity(read.token).catch(() => undefined);
          return;
        }
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
  };
}

function approveRoute(options: StudentDataExportRouteOptions): Route {
  const { contract, body } = contractOf("institution.student-data-exports-approve.post");
  const input = contract.request.body!;
  const timeoutMs = options.timeoutMs ?? INSTITUTION_BODY_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response, params) {
      const read = await readInstitutionJson(
        request,
        response,
        [],
        contract.request.maxBodyBytes!,
        timeoutMs,
      );
      if (read === null) return;
      const exportId = params?.exportId ?? "";
      if (!UUID.test(exportId)) return sendProblem(response, 404, "not_found");
      if (!Value.Check(input, read.value)) return sendProblem(response, 422, "invalid_input");
      const { reference } = read.value as { reference: string };
      try {
        const result = await options.exports.approve(read.token, exportId.toLowerCase(), reference);
        if (result.status !== "ok") {
          const [status, code] = refusalOf(result.status);
          return sendProblem(response, status, code);
        }
        const answer = { exportId: result.exportId, state: result.state };
        if (Value.Check(body!, answer)) {
          sendJson(response, 200, answer);
          void options.recordActivity(read.token).catch(() => undefined);
          return;
        }
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
  };
}

function downloadRoute({ exports, storage }: StudentDataExportRouteOptions): Route {
  const { contract } = contractOf("student.data-export.get");
  return {
    contract,
    async handle(_request, response, params) {
      const linkToken = params?.token ?? "";
      if (!LINK_TOKEN.test(linkToken)) return sendProblem(response, 410, "not_allowed");
      try {
        const result = await exports.consume(linkTokenHash(linkToken), (exportId) =>
          storage.read(exportId),
        );
        if (result.status === "gone" || result.status === "invalid") {
          return sendProblem(response, 410, "not_allowed");
        }
        if (result.status !== "ok") return sendProblem(response, 503, "unavailable");
        const bytes = result.value;
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${FILENAME}"`,
          "cache-control": "private, no-store",
          "content-length": String(bytes.byteLength),
          "x-content-type-options": "nosniff",
          "x-content-sha256": createHash("sha256").update(bytes).digest("hex"),
        });
        response.end(Buffer.from(bytes));
        // The link is used: the package goes too; a failure leaves it for the storage sweep.
        void storage.remove(result.exportId).catch(() => undefined);
        return;
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The four routes over one port: the list, the request, the approval, the download. */
export function createStudentDataExportRoutes(options: StudentDataExportRouteOptions): Route[] {
  return [listRoute(options), requestRoute(options), approveRoute(options), downloadRoute(options)];
}

/** The routes over main's application withActor and the package storage; server/server.ts mounts them. */
export function createStudentDataExportRoutesFor(
  main: { withActor: WithActor },
  env: NodeJS.ProcessEnv,
  root: string,
): Route[] {
  return createStudentDataExportRoutes({
    exports: createStudentDataExports(main.withActor),
    storage: studentDataExportStorage(studentDataExportDirectory(env, root)),
    recordActivity: (token) => recordActivity(token, main.withActor),
  });
}
