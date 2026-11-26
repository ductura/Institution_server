import { Value } from "@sinclair/typebox/value";

import { workAttachmentGet, workAttachmentPost, workIdFromPath } from "../../contracts/index.ts";
import { checkSession, liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  type Databases,
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  type Route,
  sendJson,
  sendProblem,
} from "../index.ts";

import { createAttachments } from "./service.ts";
import { attachmentStorage } from "./storage.ts";

const BODY_TIMEOUT_MS = 10_000;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const REFUSALS = new Map<string, number>([
  ["unauthorized", 401],
  ["not_found", 404],
  ["invalid_input", 422],
  ["body_too_large", 413],
]);

export function createAttachmentRoutes(
  attachments: ReturnType<typeof createAttachments>,
  actors: Databases["main"]["actorReader"],
): Route[] {
  const post: Route = {
    contract: workAttachmentPost,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      const session = await checkSession(token, actors, { live: true });
      if (!session.ok) {
        return session.refusal === "unauthenticated"
          ? refuse(response, 401, "unauthorized")
          : refuse(response, 503, "unavailable");
      }
      const assignmentId = workIdFromPath(params?.assignmentId ?? "");
      if (
        assignmentId === null ||
        !Value.Check(workAttachmentPost.request.params, { assignmentId })
      ) {
        return refuse(response, 404, "not_found");
      }
      const types = request.headersDistinct["content-type"];
      if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(
        request,
        workAttachmentPost.request.maxBodyBytes,
        BODY_TIMEOUT_MS,
      );
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(workAttachmentPost.request.body, json.value))
        return sendProblem(response, 422, "invalid_input");
      try {
        const result = await attachments.upload(
          session.token,
          assignmentId,
          json.value.imageBase64,
        );
        if (result.status !== "ok")
          return sendProblem(response, REFUSALS.get(result.status) ?? 500, result.status);
        sendJson(response, 200, result.body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), workAttachmentPost.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
  const get: Route = {
    contract: workAttachmentGet,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const attachmentId = workIdFromPath(params?.attachmentId ?? "");
      if (
        attachmentId === null ||
        !Value.Check(workAttachmentGet.request.params, { attachmentId })
      ) {
        return sendProblem(response, 404, "not_found");
      }
      try {
        const result = await attachments.read(token, attachmentId);
        if (result.status !== "ok")
          return sendProblem(response, REFUSALS.get(result.status) ?? 500, result.status);
        sendJson(response, 200, result.body);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), workAttachmentGet.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
  return [post, get];
}

export function createAttachmentRoutesFor(
  main: Pick<Databases["main"], "withActor" | "actorReader">,
  env: NodeJS.ProcessEnv,
  root: string,
): Route[] {
  return createAttachmentRoutes(
    createAttachments(main.withActor, attachmentStorage(env, root)),
    main.actorReader,
  );
}

/**
 * The bytes of one stored image the caller may read (the slides export, SRV-V13-RUTA-IZVOZ):
 * the same relation check and the same byte and hash check as GET of one attachment.
 * A refusal, a missing or an unreadable record is null; a store that fails throws.
 */
export function createAttachmentBytesReaderFor(
  main: Pick<Databases["main"], "withActor">,
  env: NodeJS.ProcessEnv,
  root: string,
): (token: string, attachmentId: string) => Promise<Uint8Array | null> {
  const attachments = createAttachments(main.withActor, attachmentStorage(env, root));
  return async (token, attachmentId) => {
    const result = await attachments.read(token, attachmentId);
    return result.status === "ok" ? Buffer.from(result.body.imageBase64, "base64") : null;
  };
}
