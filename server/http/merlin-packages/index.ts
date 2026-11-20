// POST /api/v1/teacher/assignments/{assignmentId}/merlin/packages,
// GET .../merlin/packages/{packageId} and GET .../{packageId}/download
// (teacher.merlin-packages.post, teacher.merlin-package.get,
// teacher.merlin-package-download.get), SRV-1110 (Val 11, N-18, C-16, D4):
// the teacher of an assignment asks for its Merlin package, reads its state
// and downloads the ZIP. The HTTP edge only; the build is
// server/downloads/merlin/packages and access, expiry and the record of each
// download are the database's (migration 20261121107500). The origin layer
// checks the POST before it gets here; a cross-site read is 403. No session
// is 401; a malformed, refused or unknown id the same 404 (C-23); a package
// not built yet 409, an expired one 410; an answer outside the contract, a
// ZIP whose bytes are not its fingerprint, or a throw 503 with the throw
// reported, never a partial answer.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createAssignmentSubmissionsReader,
  createDeadlineExtensions,
  createMerlinPackages,
  createSubmittedWorksReader,
  type MerlinPackageStatus,
  type WithActor,
} from "../../database/index.ts";
import {
  createMerlinPackageService,
  createMerlinRosterReader,
  type MerlinPackageService,
} from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { MERLIN_LABELS } from "../merlin-roster/index.ts";

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

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const MERLIN_PACKAGE_FILENAME = "merlin-paket.zip";

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return { contract, body: contract.responses[0]?.body };
}

/** The 403 of a cross-site read, or undefined. */
function crossSite(request: IncomingMessage): boolean {
  const site = request.headersDistinct["sec-fetch-site"];
  return site !== undefined && (site.length !== 1 || site[0] !== "same-origin");
}

/** The lowercase ids of the path, or undefined when one is malformed. */
function idsOf(params: Record<string, string> | undefined) {
  const assignmentId = params?.assignmentId ?? "";
  const packageId = params?.packageId ?? "";
  if (!UUID.test(assignmentId) || !UUID.test(packageId)) return undefined;
  return { assignmentId: assignmentId.toLowerCase(), packageId: packageId.toLowerCase() };
}

/** The status answer of the contract: the path, expiry and fingerprint once built. */
export function packageAnswer(assignmentId: string, pkg: MerlinPackageStatus) {
  if (pkg.state === "queued" || pkg.state === "failed") return { id: pkg.id, state: pkg.state };
  const built = { expiresAt: pkg.expiresAt, sha256: pkg.sha256 };
  if (pkg.state === "expired") return { id: pkg.id, state: pkg.state, ...built };
  return {
    id: pkg.id,
    state: pkg.state,
    downloadPath: `/api/v1/teacher/assignments/${assignmentId}/merlin/packages/${pkg.id}/download`,
    ...built,
  };
}

function askRoute(service: MerlinPackageService): Route {
  const { contract, body } = contractOf("teacher.merlin-packages.post");
  const input = contract.request.body!;
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(input, json.value)) return sendProblem(response, 422, "invalid_input");
      const assignmentId = params?.assignmentId ?? "";
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      const { requestKey } = json.value as { requestKey: string };
      try {
        const result = await service.request(token, assignmentId.toLowerCase(), requestKey, (e) =>
          reportServerError("route", e, requestIdOf(response), contract.id),
        );
        if (result.status === "invalid_input") return sendProblem(response, 422, "invalid_input");
        if (result.status !== "accepted") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = { id: result.id, state: result.state };
        if (body !== undefined && Value.Check(body, answer)) return sendJson(response, 202, answer);
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

function statusRoute(service: MerlinPackageService): Route {
  const { contract, body } = contractOf("teacher.merlin-package.get");
  return {
    contract,
    async handle(request, response, params) {
      if (crossSite(request)) return sendProblem(response, 403, "forbidden");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const ids = idsOf(params);
      if (ids === undefined) return sendProblem(response, 404, "not_found");
      try {
        const result = await service.status(token, ids.assignmentId, ids.packageId);
        if (result.status !== "read") {
          return result.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const answer = packageAnswer(ids.assignmentId, result.package);
        if (body !== undefined && Value.Check(body, answer)) return sendJson(response, 200, answer);
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

function downloadRoute(service: MerlinPackageService): Route {
  const { contract } = contractOf("teacher.merlin-package-download.get");
  return {
    contract,
    async handle(request, response, params) {
      if (crossSite(request)) return sendProblem(response, 403, "forbidden");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const ids = idsOf(params);
      if (ids === undefined) return sendProblem(response, 404, "not_found");
      try {
        const result = await service.download(token, ids.assignmentId, ids.packageId);
        switch (result.status) {
          case "unauthorized":
            return sendProblem(response, 401, "unauthorized");
          case "not_found":
            return sendProblem(response, 404, "not_found");
          case "not_ready":
            return sendProblem(response, 409, "conflict");
          case "expired":
            return sendProblem(response, 410, "not_allowed");
        }
        const bytes = Buffer.from(
          result.content.buffer,
          result.content.byteOffset,
          result.content.byteLength,
        );
        // The bytes handed out are the ones the state names, or nothing.
        if (createHash("sha256").update(bytes).digest("hex") !== result.sha256) {
          throw new Error("merlin package bytes do not match their fingerprint");
        }
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${MERLIN_PACKAGE_FILENAME}"`,
          "cache-control": "no-store",
          "content-length": String(bytes.byteLength),
          "x-content-sha256": result.sha256,
        });
        response.end(bytes);
        return;
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
      }
      return sendProblem(response, 503, "unavailable");
    },
  };
}

/** The three routes over one service: ask, state, download. */
export function createMerlinPackageRoutes(service: MerlinPackageService): Route[] {
  return [askRoute(service), statusRoute(service), downloadRoute(service)];
}

/** The routes over main's application withActor. */
export function createMerlinPackageRoutesFor(main: { readonly withActor: WithActor }): Route[] {
  const extensions = createDeadlineExtensions(main.withActor);
  return createMerlinPackageRoutes(
    createMerlinPackageService({
      packages: createMerlinPackages(main.withActor),
      roster: createMerlinRosterReader({
        extensions: (token, assignmentId) => extensions.list(token, assignmentId),
        submissions: createAssignmentSubmissionsReader(main.withActor),
        works: createSubmittedWorksReader(main.withActor),
        labels: MERLIN_LABELS,
      }),
      labels: MERLIN_LABELS,
    }),
  );
}
