import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath } from "../../contracts/index.ts";
import { createSourceProofs, type SourceProof, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

import { boundaryOf, parseMultipart } from "./multipart.ts";

// The proofs of a source over HTTP (SRV-1102, Ductus#2051, editor E§3.4
// "proofs", B-8): list, attach and read the JPEG of the excerpts a student
// attaches to a source of the own work. The table and RPCs are
// institution.source_proof (migration 20261121130000); the port is
// server/database/source-proofs. Another student's work answers 404 (C-23).
const LIST = ROUTES.find((route) => route.id === "student.source-proofs.get")!;
const ADD = ROUTES.find((route) => route.id === "student.source-proofs.post")!;
const IMAGE = ROUTES.find((route) => route.id === "student.source-proof-image.get")!;
const FIELDS = ADD.request.body!;

const BODY_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KNOWN_FIELDS = new Set(["image", "page", "note"]);

function pathId(segment: string | undefined): string | undefined {
  const id = workIdFromPath(segment ?? "");
  return id !== null && UUID.test(id) ? id : undefined;
}

type Refusal = "unauthorized" | "not_found" | "invalid_input";

function sendRefusal(response: ServerResponse, code: Refusal): void {
  if (code === "unauthorized") return sendProblem(response, 401, code);
  if (code === "not_found") return sendProblem(response, 404, code);
  sendProblem(response, 422, code);
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

function answerOf(assignmentId: string, sourceId: string, proof: SourceProof) {
  return {
    ...proof,
    imagePath: `/api/v1/student/assignments/${assignmentId}/sources/${sourceId}/proofs/${proof.id}/image`,
  };
}

type FormInput = { page: string; note: string | null; image: Buffer };

/** The fields of the form: image a file part, page and note text; no other field. */
function formInputOf(body: Buffer, boundary: string): FormInput | undefined {
  const parts = parseMultipart(body, boundary);
  if (parts === null || [...parts.keys()].some((name) => !KNOWN_FIELDS.has(name))) return undefined;
  const image = parts.get("image");
  const text: Record<string, string> = {};
  for (const name of ["page", "note"]) {
    const part = parts.get(name);
    if (part === undefined) continue;
    if (part.file) return undefined;
    // Strict UTF-8: a broken sequence would decode to U+FFFD and not encode back.
    const decoded = part.bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(part.bytes)) return undefined;
    // A form writes every line break of a text field as CR LF (HTML, form-data
    // encoding); the note keeps it as LF, the one line break the table takes.
    text[name] = decoded.replaceAll("\r\n", "\n");
  }
  if (image === undefined || !image.file || image.bytes.length === 0) return undefined;
  // The text fields against the contract; the image bytes are checked by the port (a JPEG).
  if (!Value.Check(FIELDS, { ...text, image: "x" })) return undefined;
  return { page: text.page!, note: text.note ?? null, image: image.bytes };
}

export function createSourceProofRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const proofs = createSourceProofs(withActor);
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendRefusal(response, "unauthorized");
        const assignmentId = pathId(params?.assignmentId);
        const sourceId = pathId(params?.sourceId);
        if (assignmentId === undefined || sourceId === undefined)
          return sendRefusal(response, "not_found");
        try {
          const result = await proofs.list(token, assignmentId, sourceId);
          if (result.status !== "read") return sendRefusal(response, result.status);
          sendJson(response, 200, {
            proofs: result.proofs.map((proof) => answerOf(assignmentId, sourceId, proof)),
          });
        } catch (error) {
          unavailable(response, LIST.id, error);
        }
      },
    },
    {
      contract: ADD,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        const boundary = types?.length === 1 ? boundaryOf(types[0] ?? "") : undefined;
        if (boundary === undefined) return refuse(response, 415, "unsupported_media_type");
        const raw = await readBodyWithLimit(
          request,
          ADD.request.maxBodyBytes ?? 0,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const assignmentId = pathId(params?.assignmentId);
        const sourceId = pathId(params?.sourceId);
        if (assignmentId === undefined || sourceId === undefined)
          return sendRefusal(response, "not_found");
        const input = formInputOf(Buffer.from(raw.bytes), boundary);
        if (input === undefined) return sendRefusal(response, "invalid_input");
        try {
          const result = await proofs.add(token, { assignmentId, sourceId, ...input });
          if (result.status !== "added") return sendRefusal(response, result.status);
          sendJson(response, 201, answerOf(assignmentId, sourceId, result.proof));
        } catch (error) {
          return unavailable(response, ADD.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
    {
      contract: IMAGE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendRefusal(response, "unauthorized");
        const assignmentId = pathId(params?.assignmentId);
        const sourceId = pathId(params?.sourceId);
        const proofId = pathId(params?.proofId);
        if (assignmentId === undefined || sourceId === undefined || proofId === undefined)
          return sendRefusal(response, "not_found");
        try {
          const result = await proofs.image(token, assignmentId, sourceId, proofId);
          if (result.status !== "read") return sendRefusal(response, result.status);
          response.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(result.image.length),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(result.image);
        } catch (error) {
          unavailable(response, IMAGE.id, error);
        }
      },
    },
  ];
}
