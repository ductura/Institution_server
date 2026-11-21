import { Value } from "@sinclair/typebox/value";

import { sourceNotebookRoutes, workIdFromPath } from "../../contracts/index.ts";
import {
  createSourceNotebook,
  type SourceNoteFields,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

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

const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

export function createSourceNotebookRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const notebook = createSourceNotebook(withActor);
  return sourceNotebookRoutes.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");

      const id = workIdFromPath(params?.id ?? "");
      const sourceId = workIdFromPath(params?.sourceId ?? "");
      if (
        id === null ||
        sourceId === null ||
        !Value.Check(contract.request.params!, { id, sourceId })
      ) {
        return refuse(response, 404, "not_found");
      }

      const method = contract.method;
      if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
        throw new Error("invalid source notebook route");
      }
      let noteId: string | null = null;
      let fields: SourceNoteFields | null = null;
      if (method === "POST" || method === "PATCH") {
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(contract.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { noteId: fromBody, ...changes } = json.value as SourceNoteFields & {
          noteId?: string;
        };
        if (
          Object.keys(changes).length === 0 ||
          (method === "POST" && Object.values(changes).every((value) => value === null))
        ) {
          return sendProblem(response, 422, "invalid_input");
        }
        noteId = fromBody ?? null;
        fields = changes;
      } else if (method === "DELETE") {
        const query = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
        const key = query.get("noteId");
        if (query.size !== 1 || !Value.Check(contract.request.query!, { noteId: key })) {
          return sendProblem(response, 422, "invalid_input");
        }
        noteId = key;
      }

      const success = contract.responses[0]!;
      const responseSchema = "body" in success ? success.body : undefined;
      const responseOf = (result: unknown) => (method === "GET" ? { notes: result } : result);
      try {
        const outcome = await notebook(token, id, sourceId, method, noteId, fields, (result) =>
          responseSchema === undefined
            ? result === null
            : Value.Check(responseSchema, responseOf(result)),
        );
        if (outcome.status !== 200) return sendProblem(response, outcome.status, outcome.code);
        if (method === "DELETE") {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } else {
          sendJson(response, success.status, responseOf(outcome.result));
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (method !== "GET") void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
