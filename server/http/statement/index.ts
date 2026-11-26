import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { ROUTES, type RouteContract } from "../../contracts/index.ts";
import {
  checkExternalAttachmentBytes,
  createStatementPort,
  incompleteFields,
  isExternalFormat,
  parseDeclarationPutBody,
  parseDeclarationQuestionAnswer,
  type StatementOperation,
  type StatementPort,
  type StatementRefusal,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  sendProblemWith,
  type Route,
} from "../index.ts";
import { createFormReader } from "./form.ts";

export type { StatementPort } from "../../database/index.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const READ = "student.declaration.get";
const SAVE = "student.declaration.put";
const UPLOAD = "student.declaration-attachments.post";
const CONVERSATIONS = "student.declaration-conversations.get";

/** A plain JSON object, so its own questionAnswer key can be set apart. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function mediaType(request: IncomingMessage): string | undefined {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1) return undefined;
  return types[0]?.split(";")[0]?.trim().toLowerCase();
}

function statusOf(status: StatementRefusal["status"]): number {
  switch (status) {
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "invalid_input":
      return 422;
  }
}

/**
 * The wire answer of an RPC refusal (declaration-v1 §7.3): a reason the
 * route's contract names becomes its own code with its context; any other
 * refusal keeps the shared code of its status.
 */
function sendRefusal(
  response: ServerResponse,
  contract: RouteContract,
  { status, reason, ...context }: StatementRefusal,
): void {
  const named =
    reason === "invalid_attachment" && (status === "not_found" || status === "invalid_input")
      ? { status: 422, code: reason }
      : reason === "unsupported_media_type" && status === "invalid_input"
        ? { status: 415, code: reason }
        : status === "conflict" && reason !== undefined
          ? { status: 409, code: reason }
          : undefined;
  const spec =
    named && contract.errors.find((e) => e.status === named.status && e.code === named.code);
  if (spec) return sendProblemWith(response, spec, context);
  return sendProblem(response, statusOf(status), status);
}

export function createStatementRoutes(port: StatementPort): Route[] {
  return [READ, CONVERSATIONS, SAVE, UPLOAD].map((id) => {
    const contract = ROUTES.find((route) => route.id === id);
    if (contract === undefined) throw new Error(`Missing contract for ${id}`);
    return {
      contract,
      async handle(request, response, params) {
        const site = request.headersDistinct["sec-fetch-site"];
        if (
          (id === READ || id === CONVERSATIONS) &&
          site !== undefined &&
          (site.length !== 1 || site[0] !== "same-origin")
        ) {
          return sendProblem(response, 403, "forbidden");
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        try {
          const slug = await port.institutionSlug(token);
          if (slug === null) return refuse(response, 401, "unauthorized");
          const assignmentId = params?.assignmentId ?? "";
          if (!UUID.test(assignmentId)) return refuse(response, 404, "not_found");
          let op: StatementOperation =
            id === CONVERSATIONS ? { type: "conversations" } : { type: "read" };
          if (id !== READ && id !== CONVERSATIONS) {
            const format = mediaType(request);
            if (id === UPLOAD && !isExternalFormat(format))
              return refuse(response, 415, "unsupported_media_type");
            if (id === SAVE && format !== "application/json")
              return refuse(response, 415, "unsupported_media_type");
            const raw = await readBodyWithLimit(
              request,
              contract.request.maxBodyBytes!,
              BODY_TIMEOUT_MS,
            );
            if (!raw.ok) return refuse(response, raw.status, raw.reason);
            if (id === SAVE) {
              const json = parseJson(raw.bytes);
              if (!json.ok) return sendProblem(response, 400, "invalid_json");
              // SRV-IZJAVA-PITANJE: the optional answer travels beside the
              // declaration-v1 body, which stays closed and is saved as before.
              let declaration: unknown = json.value;
              let questionAnswer: unknown;
              if (isRecord(json.value)) ({ questionAnswer, ...declaration } = json.value);
              const parsed = parseDeclarationPutBody(declaration);
              const answer = parseDeclarationQuestionAnswer(questionAnswer);
              if (!parsed.ok || !answer.ok || parsed.body.ai.attachments.length !== 0) {
                return sendProblem(response, 422, "invalid_input");
              }
              if (parsed.body.confirm && incompleteFields(parsed.body).length > 0) {
                return sendProblem(response, 409, "incomplete");
              }
              op = { type: "save", body: parsed.body, answer: answer.answer };
            } else {
              const checked = checkExternalAttachmentBytes(format ?? "", raw.bytes);
              if (!checked.ok) return sendProblem(response, 422, "invalid_input");
              op = { type: "upload", format: checked.format, bytes: raw.bytes };
            }
          }
          const outcome = await port.run(token, assignmentId.toLowerCase(), slug, op);
          if (outcome.status !== "ok") return sendRefusal(response, contract, outcome);
          const schema = contract.responses[0]?.body;
          if (schema !== undefined && Value.Check(schema, outcome.body))
            return sendJson(response, 200, outcome.body);
          throw new Error("Declaration response outside its contract");
        } catch {
          // The postgres error can carry submitted text in its detail or context.
          reportServerError(
            "route",
            new Error("Declaration operation failed"),
            requestIdOf(response),
            id,
          );
          return sendProblem(response, 503, "unavailable");
        }
      },
    };
  });
}

export function createStatementRoutesFor(main: { readonly withActor: WithActor }): Route[] {
  return createStatementRoutes(
    createStatementPort(main.withActor, createFormReader(resolve("config/faculties"))),
  );
}
