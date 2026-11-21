// POST /api/v1/works/{documentId}/imports and
// POST /api/v1/works/{documentId}/imports/{importId}/confirm (work.imports.post
// and work.imports.confirm.post, SRV-1803; M8.2, M8.2b, D-282, D-290 to D-292;
// contract docs/adr/import-contract.md). The HTTP edge only, as direct-edit: a
// live session cookie (401), the work id decoded once by workIdFromPath (one
// that is not a work id is the same 404 as another's work, C-23), the media
// type, the bounded body and its shape. For an import the database gate comes
// first, so a work that does not take an import (403) or is not the caller's
// (404) costs no read of the file; then server/import reads the file and
// builds the manifest, and server/database/import stores it. The preview is
// marked source import and evidence kind imported. A throw is 503 and
// reported; no byte or name of the file reaches a log or an error.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  IMPORT_CONFIRM_ERRORS,
  IMPORT_PENDING_LIFETIME_MS,
  IMPORT_READ_LIMITS,
  isWorkId,
  MAX_IMPORT_RAW_BYTES,
  ROUTES,
  UUID_V4_PATTERN,
  workIdFromPath,
} from "../../contracts/index.ts";
import {
  createImports,
  type ImportRefusal,
  type Imports,
  type WithActor,
} from "../../database/index.ts";
import { prepareDocxImport } from "../../import/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

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

const find = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const POST_CONTRACT = find("work.imports.post");
const CONFIRM_CONTRACT = find("work.imports.confirm.post");
const POST_BODY = POST_CONTRACT.request.body!;
const CONFIRM_BODY = CONFIRM_CONTRACT.request.body!;
const BODY_TIMEOUT_MS = 15_000;
const UUID_V4 = new RegExp(UUID_V4_PATTERN, "u");

/** A closed refusal of the port; `notFound` names the 404 of the route. */
function refusalOf(
  response: ServerResponse,
  status: ImportRefusal["status"],
  notFound: string,
): void {
  if (status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
  if (status === "not_found") return sendProblem(response, 404, notFound);
  if (status === "invalid") return sendProblem(response, 422, "invalid_input");
  return sendProblem(response, 503, "unavailable");
}

const isJson = (types: string[] | undefined) =>
  types?.length === 1 && types[0]?.split(";")[0]?.trim().toLowerCase() === "application/json";

export function createImportPostRoute(imports: Imports): Route {
  return {
    contract: POST_CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) return refuse(response, 404, "not_found");
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        POST_CONTRACT.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(POST_BODY, json.value)) return sendProblem(response, 422, "invalid_input");
      const { fileBase64, fileName } = json.value as {
        fileBase64: string;
        fileName: string | null;
      };
      const bytes = Buffer.from(fileBase64, "base64");
      // Standard Base64 only: the bytes must give back exactly the text sent.
      if (bytes.toString("base64") !== fileBase64)
        return sendProblem(response, 422, "invalid_input");
      if (bytes.length > MAX_IMPORT_RAW_BYTES) return sendProblem(response, 413, "body_too_large");
      try {
        const gate = await imports.gate(token, documentId);
        if (gate.status === "not_allowed") return sendProblem(response, 403, "import_not_allowed");
        if (gate.status !== "allowed") return refusalOf(response, gate.status, "not_found");
        const prepared = prepareDocxImport({
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          documentId,
          fileName,
          limits: IMPORT_READ_LIMITS,
        });
        if (!prepared.ok) {
          if (prepared.code === "FILE_TOO_LARGE")
            return sendProblem(response, 413, "body_too_large");
          if (prepared.code === "MANIFEST_INVALID")
            return sendProblem(response, 422, "invalid_input");
          return sendProblem(response, 422, "invalid_document");
        }
        const { preview } = prepared;
        const stored = await imports.prepare(token, {
          documentId,
          importId: preview.importId,
          manifest: preview.manifestText,
          manifestSha256: preview.manifestSha256,
          fileName: preview.fileName,
        });
        if (stored.status === "not_allowed")
          return sendProblem(response, 403, "import_not_allowed");
        if (stored.status !== "prepared") return refusalOf(response, stored.status, "not_found");
        return sendJson(response, 201, {
          importId: preview.importId,
          manifestSha256: preview.manifestSha256,
          source: "import",
          evidenceKind: "imported",
          fileFormat: "docx",
          content: preview.content,
          traces: preview.traces,
          rawByteLength: preview.rawByteLength,
          fileName: preview.fileName,
          baseRevision: stored.baseRevision,
          expiresAt: new Date(
            Date.parse(stored.preparedAt) + IMPORT_PENDING_LIFETIME_MS,
          ).toISOString(),
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), POST_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createImportConfirmRoute(imports: Imports): Route {
  return {
    contract: CONFIRM_CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      const importId = params?.importId ?? "";
      if (documentId === null || !isWorkId(documentId) || !UUID_V4.test(importId)) {
        return refuse(response, 404, "import_not_found");
      }
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        CONFIRM_CONTRACT.request.maxBodyBytes!,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(CONFIRM_BODY, json.value))
        return sendProblem(response, 422, "invalid_input");
      const body = json.value as { importId: string; manifestSha256: string };
      if (body.importId !== importId) return sendProblem(response, 422, "invalid_input");
      try {
        const answer = await imports.confirm(token, documentId, importId, body.manifestSha256);
        if (answer.status === "confirmed" || answer.status === "already-confirmed") {
          return sendJson(response, 200, { importId, eventId: answer.eventId });
        }
        if (answer.status === "rejected") {
          const spec = IMPORT_CONFIRM_ERRORS.find((entry) => entry.reason === answer.code);
          if (spec === undefined) return sendProblem(response, 503, "unavailable");
          return sendProblem(response, spec.status, spec.code);
        }
        return refusalOf(response, answer.status, "import_not_found");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONFIRM_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** Both routes over main's application withActor. */
export function createImportRoutesFor(main: { withActor: WithActor }): Route[] {
  const imports = createImports(main.withActor);
  return [createImportPostRoute(imports), createImportConfirmRoute(imports)];
}
